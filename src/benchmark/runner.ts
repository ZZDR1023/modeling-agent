import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { TaskType } from "../contracts/types.js";
import {
  measuredMetric,
  unavailableMetric,
  validateBenchmarkManifest,
  validateBenchmarkResult
} from "./contracts.js";
import type {
  BenchmarkAdapterOutput,
  BenchmarkClock,
  BenchmarkHardCheckResult,
  BenchmarkIdentity,
  BenchmarkManifest,
  BenchmarkPackageFile,
  BenchmarkResult,
  BenchmarkSolveContext
} from "./types.js";

const TEXT_FILE_LIMIT_BYTES = 1_000_000;

export interface RunBenchmarkCaseOptions {
  case_root: string;
  manifest: BenchmarkManifest;
  adapter: import("./types.js").BenchmarkAdapter;
  identity: BenchmarkIdentity;
  clock?: BenchmarkClock;
}

const systemClock: BenchmarkClock = {
  async measure<T>(operation: () => Promise<T>): Promise<{ value: T; duration_ms: number }> {
    const started = process.hrtime.bigint();
    try {
      return { value: await operation(), duration_ms: Number(process.hrtime.bigint() - started) / 1_000_000 };
    } catch (error) {
      if (error && typeof error === "object") {
        Object.assign(error, { benchmark_duration_ms: Number(process.hrtime.bigint() - started) / 1_000_000 });
      }
      throw error;
    }
  }
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertSafeRelativePath(path: string): void {
  if (isAbsolute(path) || path.split(/[\\/]/u).includes("..") || path.includes("\\")) {
    throw new Error("benchmark package path must remain inside its case root");
  }
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("benchmark package cannot contain symbolic links");
    }
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, path));
    } else if (entry.isFile()) {
      files.push(relative(root, path).split(sep).join("/"));
    }
  }
  return files;
}

function mediaType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = {
    csv: "text/csv",
    json: "application/json",
    md: "text/markdown",
    txt: "text/plain",
    yaml: "application/yaml",
    yml: "application/yaml"
  };
  return extension ? (types[extension] ?? "text/plain") : "text/plain";
}

async function freezePackage(caseRoot: string, packagePath: string): Promise<{ files: BenchmarkPackageFile[]; digest: string }> {
  assertSafeRelativePath(packagePath);
  const canonicalCaseRoot = await realpath(caseRoot);
  const packageRoot = resolve(canonicalCaseRoot, packagePath);
  const canonicalPackageRoot = await realpath(packageRoot);
  if (canonicalPackageRoot !== canonicalCaseRoot && !canonicalPackageRoot.startsWith(`${canonicalCaseRoot}${sep}`)) {
    throw new Error("benchmark package resolves outside its case root");
  }
  if (!(await stat(canonicalPackageRoot)).isDirectory()) {
    throw new Error("benchmark package path must identify a directory");
  }
  const relativePaths = await listFiles(canonicalPackageRoot);
  if (relativePaths.length === 0) {
    throw new Error("benchmark package must contain at least one file");
  }
  const files: BenchmarkPackageFile[] = [];
  const digestParts: string[] = [];
  for (const relativePath of relativePaths) {
    const bytes = await readFile(resolve(canonicalPackageRoot, relativePath));
    if (bytes.byteLength > TEXT_FILE_LIMIT_BYTES) {
      throw new Error(`benchmark package file exceeds ${TEXT_FILE_LIMIT_BYTES} bytes`);
    }
    if (bytes.includes(0)) {
      throw new Error("binary benchmark package files are not supported by the solve adapter context");
    }
    const fileDigest = sha256(bytes);
    files.push({ relative_path: relativePath, media_type: mediaType(relativePath), sha256: fileDigest, content: bytes.toString("utf8") });
    digestParts.push(`${relativePath}\0${fileDigest}\n`);
  }
  return { files, digest: sha256(digestParts.join("")) };
}

async function readReference(caseRoot: string, manifest: BenchmarkManifest): Promise<string | null> {
  const path = manifest.reference_policy.relative_path;
  if (manifest.reference_policy.availability !== "included" || path === null) {
    return null;
  }
  assertSafeRelativePath(path);
  const canonicalCaseRoot = await realpath(caseRoot);
  const canonicalReference = await realpath(resolve(canonicalCaseRoot, path));
  if (!canonicalReference.startsWith(`${canonicalCaseRoot}${sep}`)) {
    throw new Error("benchmark reference resolves outside its case root");
  }
  const reference = await readFile(canonicalReference, "utf8");
  const declaredDigest = manifest.reference_policy.sha256;
  if (declaredDigest !== null && sha256(reference) !== declaredDigest) {
    throw new Error("benchmark reference digest does not match the manifest");
  }
  return reference;
}

function referenceStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(referenceStrings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(referenceStrings);
  return [];
}

function referenceSegments(reference: string): string[] {
  try {
    return [reference, ...referenceStrings(JSON.parse(reference))];
  } catch {
    return [reference];
  }
}

function normalizedWindows(value: string, minimumLength: number): Set<string> {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const windows = new Set<string>();
  if (normalized.length < minimumLength) {
    return windows;
  }
  for (let offset = 0; offset <= normalized.length - minimumLength; offset += Math.max(1, Math.floor(minimumLength / 4))) {
    windows.add(normalized.slice(offset, offset + minimumLength));
  }
  windows.add(normalized.slice(-minimumLength));
  return windows;
}

function leakedReference(output: string, reference: string | null, minimumLength: number): string | null {
  if (reference === null || output.length === 0) return null;
  const normalizedOutput = output.normalize("NFKC").replace(/\s+/gu, " ");
  for (const segment of referenceSegments(reference)) {
    for (const window of normalizedWindows(segment, minimumLength)) {
      if (normalizedOutput.includes(window)) {
        return sha256(window);
      }
    }
  }
  return null;
}

function normalizeObservedTasks(output: BenchmarkAdapterOutput, manifest: BenchmarkManifest): TaskType[] {
  const allowed = new Set(manifest.allowed_task_types);
  return [...new Set(output.observed_task_types)].filter((taskType) => allowed.has(taskType)).sort();
}

function outputContractFailure(output: BenchmarkAdapterOutput, manifest: BenchmarkManifest): string | null {
  if (!output || typeof output !== "object") return "adapter output is not an object";
  if (output.status !== "success" && output.status !== "failed") return "adapter output status is invalid";
  if (!Array.isArray(output.observed_task_types) || !Array.isArray(output.hard_checks) || !Array.isArray(output.artifacts) || !Array.isArray(output.evidence)) return "adapter output collections are invalid";
  if (!output.usage || (output.usage.token_count !== null && (!Number.isInteger(output.usage.token_count) || output.usage.token_count < 0))) return "adapter token usage is invalid";
  if (output.usage.cost_usd !== null && (!Number.isFinite(output.usage.cost_usd) || output.usage.cost_usd < 0)) return "adapter cost usage is invalid";
  if (typeof output.output_text !== "string") return "adapter output text is invalid";
  if (output.artifacts.some((item) => typeof item !== "string") || output.evidence.some((item) => typeof item !== "string")) return "adapter inventory is invalid";
  const allowed = new Set(manifest.allowed_task_types);
  if (output.observed_task_types.some((taskType) => !allowed.has(taskType))) return "adapter reported a disallowed task type";
  const expectedChecks = new Set(manifest.hard_checks.map((check) => check.id));
  if (output.hard_checks.some((check) => !check || typeof check.id !== "string" || typeof check.passed !== "boolean" || !expectedChecks.has(check.id))) return "adapter hard-check output is invalid";
  return null;
}

function hardChecks(output: BenchmarkAdapterOutput, manifest: BenchmarkManifest): BenchmarkHardCheckResult[] {
  const observations = new Map(output.hard_checks.map((check) => [check.id, check]));
  return manifest.hard_checks.map((definition) => {
    const observation = observations.get(definition.id);
    const note = observation?.note;
    return note === undefined
      ? { id: definition.id, status: observation?.passed === true ? "passed" : "failed" }
      : { id: definition.id, status: observation?.passed === true ? "passed" : "failed", note };
  });
}

function safeError(error: unknown): { class: string; message: string; fingerprint: string } {
  const className = error instanceof Error ? error.name : "UnknownError";
  const raw = error instanceof Error ? error.message : String(error);
  const fingerprint = sha256(`${className}\0${raw}`);
  return { class: className.slice(0, 200) || "Error", message: `adapter failed (${fingerprint.slice(0, 12)})`, fingerprint };
}

function runId(caseId: string, variant: string, frozenDigest: string): string {
  return `${caseId}-${variant.replaceAll("_", "-")}-${frozenDigest.slice(0, 12)}`;
}

function coverage(expected: readonly TaskType[], observed: readonly TaskType[]): number {
  if (expected.length === 0) return 1;
  const observedSet = new Set(observed);
  return expected.filter((taskType) => observedSet.has(taskType)).length / expected.length;
}

function usageMetric(value: number | null, source: string) {
  return value === null ? unavailableMetric("adapter_did_not_report") : measuredMetric(value, source);
}

export async function runBenchmarkCase(options: RunBenchmarkCaseOptions): Promise<BenchmarkResult> {
  const manifest = validateBenchmarkManifest(structuredClone(options.manifest));
  const expectedAdapterId = options.adapter.variant === "agent" ? manifest.runtime.agent_adapter_id : manifest.runtime.one_shot_adapter_id;
  if (options.adapter.id !== expectedAdapterId) {
    throw new Error(`adapter id ${options.adapter.id} does not match frozen manifest runtime ${expectedAdapterId}`);
  }
  const frozen = await freezePackage(options.case_root, manifest.package_path);
  const reference = await readReference(options.case_root, manifest);
  const context: BenchmarkSolveContext = Object.freeze({
    case_id: manifest.case_id,
    variant: options.adapter.variant,
    frozen_case_sha256: frozen.digest,
    package_files: Object.freeze(frozen.files.map((file) => Object.freeze(file))),
    budget: Object.freeze(structuredClone(manifest.budget)),
    expected_task_types: Object.freeze([...manifest.expected_task_types]),
    hard_checks: Object.freeze(manifest.hard_checks.map((check) => Object.freeze({ ...check })))
  });
  const clock = options.clock ?? systemClock;
  let duration = 0;
  let output: BenchmarkAdapterOutput;
  try {
    const measured = await clock.measure(async () => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("benchmark wall-time budget exceeded")), manifest.budget.max_wall_time_ms);
        timer.unref();
      });
      try {
        return await Promise.race([options.adapter.run(context), timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    });
    duration = measured.duration_ms;
    output = measured.value;
  } catch (error) {
    duration = typeof (error as { benchmark_duration_ms?: unknown })?.benchmark_duration_ms === "number"
      ? (error as { benchmark_duration_ms: number }).benchmark_duration_ms
      : 0;
    const sanitized = safeError(error);
    return validateBenchmarkResult({
      schema_version: "1.0.0",
      case_id: manifest.case_id,
      variant: options.adapter.variant,
      adapter_id: options.adapter.id,
      run_id: runId(manifest.case_id, options.adapter.variant, frozen.digest),
      frozen_case_sha256: frozen.digest,
      state: "measured",
      outcome: "hard_error",
      observed_task_types: [],
      hard_checks: manifest.hard_checks.map((check) => ({ id: check.id, status: "failed" as const })),
      policy_events: [],
      error: sanitized,
      metrics: {
        completion: measuredMetric(false, "harness_scoring"),
        hard_error: measuredMetric(true, "harness_scoring"),
        wall_time_ms: measuredMetric(duration, "harness_clock"),
        task_type_coverage: measuredMetric(0, "harness_scoring"),
        custom_experiment_present: measuredMetric(false, "harness_scoring"),
        token_count: unavailableMetric("adapter_failed_before_usage_report"),
        cost_usd: unavailableMetric("adapter_failed_before_usage_report"),
        human_review_minutes: unavailableMetric("not_reviewed"),
        human_review_notes: unavailableMetric("not_reviewed"),
        artifact_count: measuredMetric(0, "adapter_inventory"),
        evidence_count: measuredMetric(0, "adapter_inventory"),
        commit_identity: measuredMetric(options.identity.commit, "git_commit"),
        environment_identity: measuredMetric(options.identity.environment, "runtime_environment")
      }
    });
  }

  const contractFailure = outputContractFailure(output, manifest);
  if (contractFailure !== null) {
    const sanitized = safeError(new Error(contractFailure));
    return validateBenchmarkResult({
      schema_version: "1.0.0",
      case_id: manifest.case_id,
      variant: options.adapter.variant,
      adapter_id: options.adapter.id,
      run_id: runId(manifest.case_id, options.adapter.variant, frozen.digest),
      frozen_case_sha256: frozen.digest,
      state: "measured",
      outcome: "hard_error",
      observed_task_types: [],
      hard_checks: manifest.hard_checks.map((check) => ({ id: check.id, status: "failed" as const })),
      policy_events: [],
      error: sanitized,
      metrics: {
        completion: measuredMetric(false, "harness_scoring"),
        hard_error: measuredMetric(true, "harness_scoring"),
        wall_time_ms: measuredMetric(duration, "harness_clock"),
        task_type_coverage: measuredMetric(0, "harness_scoring"),
        custom_experiment_present: measuredMetric(false, "harness_scoring"),
        token_count: unavailableMetric("invalid_adapter_output"),
        cost_usd: unavailableMetric("invalid_adapter_output"),
        human_review_minutes: unavailableMetric("not_reviewed"),
        human_review_notes: unavailableMetric("not_reviewed"),
        artifact_count: measuredMetric(0, "invalid_adapter_output"),
        evidence_count: measuredMetric(0, "invalid_adapter_output"),
        commit_identity: measuredMetric(options.identity.commit, "git_commit"),
        environment_identity: measuredMetric(options.identity.environment, "runtime_environment")
      }
    });
  }

  const observedTasks = normalizeObservedTasks(output, manifest);
  const checks = hardChecks(output, manifest);
  const leakedFingerprint = leakedReference(output.output_text, reference, manifest.blind_policy.minimum_reference_match_characters);
  if (leakedFingerprint !== null) {
    return validateBenchmarkResult({
      schema_version: "1.0.0",
      case_id: manifest.case_id,
      variant: options.adapter.variant,
      adapter_id: options.adapter.id,
      run_id: runId(manifest.case_id, options.adapter.variant, frozen.digest),
      frozen_case_sha256: frozen.digest,
      state: "blocked",
      outcome: "blocked_policy",
      observed_task_types: observedTasks,
      hard_checks: manifest.hard_checks.map((check) => ({ id: check.id, status: "blocked" as const })),
      policy_events: [{ type: "same_problem_answer_detected", action: "blocked", fingerprint: leakedFingerprint }],
      error: { class: "BlindPolicyViolation", message: `same-problem answer match blocked (${leakedFingerprint.slice(0, 12)})`, fingerprint: leakedFingerprint },
      metrics: {
        completion: measuredMetric(false, "harness_scoring"),
        hard_error: measuredMetric(true, "harness_scoring"),
        wall_time_ms: measuredMetric(duration, "harness_clock"),
        task_type_coverage: measuredMetric(coverage(manifest.expected_task_types, observedTasks), "harness_scoring"),
        custom_experiment_present: measuredMetric(observedTasks.includes("custom_experiment"), "harness_scoring"),
        token_count: usageMetric(output.usage.token_count, "adapter_usage"),
        cost_usd: usageMetric(output.usage.cost_usd, "adapter_usage"),
        human_review_minutes: unavailableMetric("not_reviewed"),
        human_review_notes: unavailableMetric("not_reviewed"),
        artifact_count: measuredMetric(0, "blocked_output_discarded"),
        evidence_count: measuredMetric(0, "blocked_output_discarded"),
        commit_identity: measuredMetric(options.identity.commit, "git_commit"),
        environment_identity: measuredMetric(options.identity.environment, "runtime_environment")
      }
    });
  }

  const adapterFailed = output.status !== "success";
  const checksFailed = checks.some((check) => check.status !== "passed");
  const withinBudget = duration <= manifest.budget.max_wall_time_ms;
  const complete = !adapterFailed && !checksFailed && withinBudget;
  const outputError = output.error === undefined ? null : safeError(new Error(`${output.error.class}: ${output.error.message}`));
  const outcome = complete ? "completed" : adapterFailed ? "hard_error" : "incomplete";
  return validateBenchmarkResult({
    schema_version: "1.0.0",
    case_id: manifest.case_id,
    variant: options.adapter.variant,
    adapter_id: options.adapter.id,
    run_id: runId(manifest.case_id, options.adapter.variant, frozen.digest),
    frozen_case_sha256: frozen.digest,
    state: "measured",
    outcome,
    observed_task_types: observedTasks,
    hard_checks: checks,
    policy_events: [],
    error: outputError,
    metrics: {
      completion: measuredMetric(complete, "harness_scoring"),
      hard_error: measuredMetric(adapterFailed, "harness_scoring"),
      wall_time_ms: measuredMetric(duration, "harness_clock"),
      task_type_coverage: measuredMetric(coverage(manifest.expected_task_types, observedTasks), "harness_scoring"),
      custom_experiment_present: measuredMetric(observedTasks.includes("custom_experiment"), "harness_scoring"),
      token_count: usageMetric(output.usage.token_count, "adapter_usage"),
      cost_usd: usageMetric(output.usage.cost_usd, "adapter_usage"),
      human_review_minutes: unavailableMetric("not_reviewed"),
      human_review_notes: unavailableMetric("not_reviewed"),
      artifact_count: measuredMetric(output.artifacts.length, "adapter_inventory"),
      evidence_count: measuredMetric(output.evidence.length, "adapter_inventory"),
      commit_identity: measuredMetric(options.identity.commit, "git_commit"),
      environment_identity: measuredMetric(options.identity.environment, "runtime_environment")
    }
  });
}
