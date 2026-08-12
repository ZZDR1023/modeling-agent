import { createHash } from "node:crypto";
import { lstat, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { TaskType } from "../contracts/types.js";
import {
  measuredMetric,
  unavailableMetric,
  validateBenchmarkManifest,
  validateBenchmarkResult
} from "./contracts.js";
import type {
  BenchmarkAdapter,
  BenchmarkAdapterOutput,
  BenchmarkClock,
  BenchmarkHardCheckResult,
  BenchmarkHumanReviewNote,
  BenchmarkIdentity,
  BenchmarkManifest,
  BenchmarkMetric,
  BenchmarkPackageFile,
  BenchmarkResult,
  BenchmarkReviewObservation,
  BenchmarkSolveContext
} from "./types.js";

const TEXT_FILE_LIMIT_BYTES = 1_000_000;
const OPAQUE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REVIEW_NOTES = new Set<BenchmarkHumanReviewNote>(["no_revision", "minor_revision", "major_revision", "rejected"]);

type ReferenceStatus = "available" | "unavailable";

interface FrozenPackage {
  files: BenchmarkPackageFile[];
  digest: string;
  canonical_root: string;
}

interface PreparedReference {
  declared_path: string | null;
  canonical_path: string | null;
  status: ReferenceStatus;
  reason: string | null;
}

interface LoadedReference {
  canonical_path: string | null;
  status: ReferenceStatus;
  digest: string | null;
  reason: string | null;
  text: string | null;
}

interface EvaluationContract {
  frozen_case_sha256: string;
  reference: {
    availability: BenchmarkManifest["reference_policy"]["availability"];
    status: ReferenceStatus;
    sha256: string | null;
  };
  blind_policy: BenchmarkManifest["blind_policy"];
  budget: BenchmarkManifest["budget"];
  allowed_task_types: BenchmarkManifest["allowed_task_types"];
  expected_task_types: BenchmarkManifest["expected_task_types"];
  hard_checks: BenchmarkManifest["hard_checks"];
  execution: BenchmarkManifest["execution"];
  runtime: BenchmarkManifest["runtime"];
}

export interface RunBenchmarkCaseOptions {
  case_root: string;
  manifest: BenchmarkManifest;
  adapter: BenchmarkAdapter;
  identity: BenchmarkIdentity;
  clock?: BenchmarkClock;
  review_observation?: BenchmarkReviewObservation;
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

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`).join(",")}}`;
}

function assertOpaqueIdentifier(value: string, label: string): void {
  if (!OPAQUE_IDENTIFIER.test(value)) {
    throw new Error(`${label} must be a bounded opaque identifier`);
  }
}

function validateIdentity(identity: BenchmarkIdentity): void {
  assertOpaqueIdentifier(identity.commit, "commit identity");
  assertOpaqueIdentifier(identity.environment, "environment identity");
}

function validateReviewObservation(observation: BenchmarkReviewObservation | undefined): BenchmarkReviewObservation | undefined {
  if (observation === undefined) return undefined;
  if (observation === null || typeof observation !== "object" || Array.isArray(observation)) {
    throw new Error("review observation must be an object");
  }
  const keys = Object.keys(observation).sort();
  if (keys.length !== 2 || keys[0] !== "minutes" || keys[1] !== "notes") {
    throw new Error("review observation must contain only minutes and notes");
  }
  if (observation.minutes !== null && (!Number.isFinite(observation.minutes) || observation.minutes < 0)) {
    throw new Error("review observation minutes must be a non-negative number or null");
  }
  if (observation.notes !== null && !REVIEW_NOTES.has(observation.notes)) {
    throw new Error("review observation notes must be a safe review classification or null");
  }
  if ((observation.minutes === null) !== (observation.notes === null)) {
    throw new Error("review observation minutes and notes must be measured together or both unavailable");
  }
  return structuredClone(observation);
}

function assertSafeRelativePath(path: string): void {
  if (isAbsolute(path) || path.split(/[\\/]/u).includes("..") || path.includes("\\")) {
    throw new Error("benchmark path must remain inside its case root");
  }
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
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

async function freezePackage(canonicalCaseRoot: string, packagePath: string): Promise<FrozenPackage> {
  assertSafeRelativePath(packagePath);
  const packageRoot = resolve(canonicalCaseRoot, packagePath);
  const canonicalPackageRoot = await realpath(packageRoot);
  if (!isWithin(canonicalCaseRoot, canonicalPackageRoot)) {
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
  return { files, digest: sha256(digestParts.join("")), canonical_root: canonicalPackageRoot };
}

async function optionalRealpath(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function prepareReference(canonicalCaseRoot: string, packageRoot: string, manifest: BenchmarkManifest): Promise<PreparedReference> {
  const policy = manifest.reference_policy;
  const relativePath = policy.relative_path;
  if (relativePath === null) {
    return { declared_path: null, canonical_path: null, status: "unavailable", reason: "reference_not_declared" };
  }
  assertSafeRelativePath(relativePath);
  const declaredPath = resolve(canonicalCaseRoot, relativePath);
  if (pathsOverlap(packageRoot, declaredPath)) {
    throw new Error("benchmark reference must remain outside the package directory");
  }
  const canonicalReference = await optionalRealpath(declaredPath);
  if (canonicalReference === null) {
    if (policy.availability === "included") {
      throw new Error("included benchmark reference is unavailable");
    }
    return { declared_path: declaredPath, canonical_path: null, status: "unavailable", reason: "user_supplied_reference_missing" };
  }
  if (!isWithin(canonicalCaseRoot, canonicalReference)) {
    throw new Error("benchmark reference resolves outside its case root");
  }
  if (pathsOverlap(packageRoot, canonicalReference)) {
    throw new Error("benchmark reference must remain outside the package directory");
  }
  const info = await lstat(canonicalReference);
  if (!info.isFile()) {
    throw new Error("benchmark reference path must identify a file");
  }
  return { declared_path: declaredPath, canonical_path: canonicalReference, status: "available", reason: null };
}

async function loadReference(reference: PreparedReference, manifest: BenchmarkManifest): Promise<LoadedReference> {
  if (reference.status === "unavailable" || reference.canonical_path === null) {
    return { canonical_path: null, status: "unavailable", digest: null, reason: reference.reason, text: null };
  }
  try {
    const handle = await open(reference.canonical_path, "r");
    try {
      const canonicalHandlePath = await realpath(`/proc/self/fd/${handle.fd}`);
      if (canonicalHandlePath !== reference.canonical_path) {
        throw new Error("benchmark reference changed before scoring");
      }
      const bytes = await handle.readFile();
      const actualDigest = sha256(bytes);
      if (manifest.reference_policy.sha256 !== null && actualDigest !== manifest.reference_policy.sha256) {
        throw new Error("benchmark reference digest does not match the manifest");
      }
      return { canonical_path: reference.canonical_path, status: "available", digest: actualDigest, reason: null, text: bytes.toString("utf8") };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (manifest.reference_policy.availability === "user_supplied" && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { canonical_path: null, status: "unavailable", digest: null, reason: "user_supplied_reference_missing", text: null };
    }
    throw error;
  }
}

function evaluationContract(manifest: BenchmarkManifest, frozenDigest: string, reference: PreparedReference | LoadedReference): EvaluationContract {
  return {
    frozen_case_sha256: frozenDigest,
    reference: {
      availability: manifest.reference_policy.availability,
      status: reference.status,
      sha256: "digest" in reference ? reference.digest : null
    },
    blind_policy: structuredClone(manifest.blind_policy),
    budget: structuredClone(manifest.budget),
    allowed_task_types: [...manifest.allowed_task_types],
    expected_task_types: [...manifest.expected_task_types],
    hard_checks: manifest.hard_checks.map((check) => ({ ...check })),
    execution: structuredClone(manifest.execution),
    runtime: structuredClone(manifest.runtime)
  };
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
  if (normalized.length < minimumLength) return windows;
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
      if (normalizedOutput.includes(window)) return sha256(window);
    }
  }
  return null;
}

function normalizeObservedTasks(output: BenchmarkAdapterOutput, manifest: BenchmarkManifest): TaskType[] {
  const allowed = new Set(manifest.allowed_task_types);
  return [...new Set(output.observed_task_types)].filter((taskType) => allowed.has(taskType)).sort();
}

function outputContractFailure(value: unknown, manifest: BenchmarkManifest): string | null {
  if (!value || typeof value !== "object") return "output_not_object";
  const output = value as BenchmarkAdapterOutput;
  if (output.status !== "success" && output.status !== "failed") return "invalid_status";
  if (output.status === "success" && output.error !== undefined) return "success_with_error";
  if (output.status === "failed" && output.error === undefined) return "failed_without_error";
  if (!Array.isArray(output.observed_task_types) || !Array.isArray(output.hard_checks) || !Array.isArray(output.artifacts) || !Array.isArray(output.evidence)) return "invalid_collections";
  if (!output.usage || typeof output.usage !== "object" || Array.isArray(output.usage)) return "invalid_usage";
  if (output.usage.token_count !== null && (!Number.isInteger(output.usage.token_count) || output.usage.token_count < 0)) return "invalid_token_usage";
  if (output.usage.cost_usd !== null && (!Number.isFinite(output.usage.cost_usd) || output.usage.cost_usd < 0)) return "invalid_cost_usage";
  if (typeof output.output_text !== "string") return "invalid_output_text";
  if (output.artifacts.some((item) => typeof item !== "string") || output.evidence.some((item) => typeof item !== "string")) return "invalid_inventory";
  const allowed = new Set(manifest.allowed_task_types);
  if (output.observed_task_types.some((taskType) => !allowed.has(taskType))) return "disallowed_task_type";
  const expectedChecks = new Set(manifest.hard_checks.map((check) => check.id));
  if (output.hard_checks.some((check) => !check || typeof check.id !== "string" || typeof check.passed !== "boolean" || !expectedChecks.has(check.id))) return "invalid_hard_check";
  const observedCheckIds = output.hard_checks.map((check) => check.id);
  if (new Set(observedCheckIds).size !== observedCheckIds.length) return "duplicate_hard_check";
  if (observedCheckIds.length !== expectedChecks.size || [...expectedChecks].some((id) => !observedCheckIds.includes(id))) return "missing_hard_check";
  if (output.error !== undefined && (!output.error || typeof output.error.class !== "string" || typeof output.error.message !== "string")) return "invalid_error";
  return null;
}

function hardChecks(output: BenchmarkAdapterOutput, manifest: BenchmarkManifest): BenchmarkHardCheckResult[] {
  const observations = new Map(output.hard_checks.map((check) => [check.id, check]));
  return manifest.hard_checks.map((definition) => ({
    id: definition.id,
    status: observations.get(definition.id)?.passed === true ? "passed" : "failed"
  }));
}

function safeError(error: unknown, fallbackClass = "HarnessError"): { class: string; message: string; fingerprint: string } {
  const rawClass = error instanceof Error ? error.name : fallbackClass;
  const className = OPAQUE_IDENTIFIER.test(rawClass) ? rawClass : fallbackClass;
  const raw = error instanceof Error ? error.message : String(error);
  const fingerprint = sha256(`${rawClass}\0${raw}`);
  return { class: className, message: `failure:${fingerprint.slice(0, 12)}`, fingerprint };
}

function safeAdapterError(output: BenchmarkAdapterOutput): { class: string; message: string; fingerprint: string } | null {
  if (output.error === undefined) return null;
  const className = OPAQUE_IDENTIFIER.test(output.error.class) ? output.error.class : "AdapterError";
  const fingerprint = sha256(`${output.error.class}\0${output.error.message}`);
  return { class: className, message: `failure:${fingerprint.slice(0, 12)}`, fingerprint };
}

function runId(caseId: string, variant: string, frozenDigest: string, evaluationDigest: string): string {
  return `${caseId}-${variant.replaceAll("_", "-")}-${frozenDigest.slice(0, 12)}-${evaluationDigest.slice(0, 12)}`;
}

function coverage(expected: readonly TaskType[], observed: readonly TaskType[]): number {
  if (expected.length === 0) return 1;
  const observedSet = new Set(observed);
  return expected.filter((taskType) => observedSet.has(taskType)).length / expected.length;
}

function usageMetric(value: number | null, source: string) {
  return value === null ? unavailableMetric("adapter_did_not_report") : measuredMetric(value, source);
}

function reviewMetrics(observation: BenchmarkReviewObservation | undefined): {
  minutes: BenchmarkMetric<number>;
  notes: BenchmarkMetric<BenchmarkHumanReviewNote>;
} {
  if (observation === undefined || observation.minutes === null || observation.notes === null) {
    return { minutes: unavailableMetric("review_observation_unavailable"), notes: unavailableMetric("review_observation_unavailable") };
  }
  return {
    minutes: measuredMetric(observation.minutes, "review_observation"),
    notes: measuredMetric(observation.notes, "review_observation")
  };
}

function budgetProven(manifest: BenchmarkManifest, output: BenchmarkAdapterOutput, duration: number, review: BenchmarkReviewObservation | undefined): boolean {
  if (duration > manifest.budget.max_wall_time_ms) return false;
  if (manifest.budget.max_tokens !== null && (output.usage.token_count === null || output.usage.token_count > manifest.budget.max_tokens)) return false;
  if (manifest.budget.max_cost_usd !== null && (output.usage.cost_usd === null || output.usage.cost_usd > manifest.budget.max_cost_usd)) return false;
  if (manifest.budget.max_human_review_minutes !== null && (review?.minutes === null || review?.minutes === undefined || review.minutes > manifest.budget.max_human_review_minutes)) return false;
  return true;
}

function errorResult(parameters: {
  manifest: BenchmarkManifest;
  adapter: BenchmarkAdapter;
  identity: BenchmarkIdentity;
  frozenDigest: string;
  evaluationDigest: string;
  duration: number;
  error: { class: string; message: string; fingerprint: string };
}): BenchmarkResult {
  const { manifest, adapter, identity, frozenDigest, evaluationDigest, duration, error } = parameters;
  return validateBenchmarkResult({
    schema_version: "1.0.0",
    case_id: manifest.case_id,
    variant: adapter.variant,
    adapter_id: adapter.id,
    run_id: runId(manifest.case_id, adapter.variant, frozenDigest, evaluationDigest),
    frozen_case_sha256: frozenDigest,
    evaluation_contract_sha256: evaluationDigest,
    state: "measured",
    outcome: "hard_error",
    observed_task_types: [],
    hard_checks: manifest.hard_checks.map((check) => ({ id: check.id, status: "failed" as const })),
    policy_events: [],
    error,
    metrics: {
      completion: measuredMetric(false, "harness_scoring"),
      hard_error: measuredMetric(true, "harness_scoring"),
      wall_time_ms: measuredMetric(duration, "harness_clock"),
      task_type_coverage: measuredMetric(0, "harness_scoring"),
      custom_experiment_present: measuredMetric(false, "harness_scoring"),
      token_count: unavailableMetric("adapter_failed_before_usage_report"),
      cost_usd: unavailableMetric("adapter_failed_before_usage_report"),
      human_review_minutes: unavailableMetric("review_observation_unavailable"),
      human_review_notes: unavailableMetric("review_observation_unavailable"),
      reference_leak_check: unavailableMetric("adapter_output_unavailable"),
      artifact_count: measuredMetric(0, "adapter_inventory"),
      evidence_count: measuredMetric(0, "adapter_inventory"),
      commit_identity: measuredMetric(identity.commit, "git_commit"),
      environment_identity: measuredMetric(identity.environment, "runtime_environment")
    }
  });
}

export async function runBenchmarkCase(options: RunBenchmarkCaseOptions): Promise<BenchmarkResult> {
  const manifest = validateBenchmarkManifest(structuredClone(options.manifest));
  validateIdentity(options.identity);
  assertOpaqueIdentifier(options.adapter.id, "adapter id");
  const review = validateReviewObservation(options.review_observation);
  const expectedAdapterId = options.adapter.variant === "agent" ? manifest.runtime.agent_adapter_id : manifest.runtime.one_shot_adapter_id;
  if (options.adapter.id !== expectedAdapterId) {
    throw new Error("adapter id does not match frozen manifest runtime");
  }

  const canonicalCaseRoot = await realpath(options.case_root);
  const frozen = await freezePackage(canonicalCaseRoot, manifest.package_path);
  const preparedReference = await prepareReference(canonicalCaseRoot, frozen.canonical_root, manifest);
  let evaluationDigest = sha256(stableSerialize(evaluationContract(manifest, frozen.digest, preparedReference)));
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
        timer = setTimeout(() => reject(new Error("wall_time_budget_exceeded")), manifest.budget.max_wall_time_ms);
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
      : manifest.budget.max_wall_time_ms;
    return errorResult({
      manifest,
      adapter: options.adapter,
      identity: options.identity,
      frozenDigest: frozen.digest,
      evaluationDigest,
      duration,
      error: safeError(error)
    });
  }

  const contractFailure = outputContractFailure(output, manifest);
  if (contractFailure !== null) {
    return errorResult({
      manifest,
      adapter: options.adapter,
      identity: options.identity,
      frozenDigest: frozen.digest,
      evaluationDigest,
      duration,
      error: safeError(contractFailure, "AdapterContractError")
    });
  }

  const reference = await loadReference(preparedReference, manifest);
  evaluationDigest = sha256(stableSerialize(evaluationContract(manifest, frozen.digest, reference)));
  const observedTasks = normalizeObservedTasks(output, manifest);
  const checks = hardChecks(output, manifest);
  const reviewValues = reviewMetrics(review);
  const referenceMetric: BenchmarkMetric<boolean> = reference.status === "available"
    ? measuredMetric(true, "harness_leak_check")
    : unavailableMetric(reference.reason ?? "reference_unavailable");
  const leakedFingerprint = leakedReference(output.output_text, reference.text, manifest.blind_policy.minimum_reference_match_characters);

  if (leakedFingerprint !== null) {
    return validateBenchmarkResult({
      schema_version: "1.0.0",
      case_id: manifest.case_id,
      variant: options.adapter.variant,
      adapter_id: options.adapter.id,
      run_id: runId(manifest.case_id, options.adapter.variant, frozen.digest, evaluationDigest),
      frozen_case_sha256: frozen.digest,
      evaluation_contract_sha256: evaluationDigest,
      state: "blocked",
      outcome: "blocked_policy",
      observed_task_types: observedTasks,
      hard_checks: manifest.hard_checks.map((check) => ({ id: check.id, status: "blocked" as const })),
      policy_events: [{ type: "same_problem_answer_detected", action: "blocked", fingerprint: leakedFingerprint }],
      error: { class: "BlindPolicyViolation", message: `failure:${leakedFingerprint.slice(0, 12)}`, fingerprint: leakedFingerprint },
      metrics: {
        completion: measuredMetric(false, "harness_scoring"),
        hard_error: measuredMetric(true, "harness_scoring"),
        wall_time_ms: measuredMetric(duration, "harness_clock"),
        task_type_coverage: measuredMetric(coverage(manifest.expected_task_types, observedTasks), "harness_scoring"),
        custom_experiment_present: measuredMetric(observedTasks.includes("custom_experiment"), "harness_scoring"),
        token_count: usageMetric(output.usage.token_count, "adapter_usage"),
        cost_usd: usageMetric(output.usage.cost_usd, "adapter_usage"),
        human_review_minutes: reviewValues.minutes,
        human_review_notes: reviewValues.notes,
        reference_leak_check: measuredMetric(false, "harness_leak_check"),
        artifact_count: measuredMetric(0, "blocked_output_discarded"),
        evidence_count: measuredMetric(0, "blocked_output_discarded"),
        commit_identity: measuredMetric(options.identity.commit, "git_commit"),
        environment_identity: measuredMetric(options.identity.environment, "runtime_environment")
      }
    });
  }

  const adapterFailed = output.status === "failed";
  const checksFailed = checks.some((check) => check.status !== "passed");
  const scoringAvailable = reference.status === "available" || manifest.reference_policy.availability === "unavailable";
  const complete = !adapterFailed && !checksFailed && scoringAvailable && budgetProven(manifest, output, duration, review);
  const outcome = complete ? "completed" : adapterFailed ? "hard_error" : "incomplete";
  const outputError = safeAdapterError(output);
  return validateBenchmarkResult({
    schema_version: "1.0.0",
    case_id: manifest.case_id,
    variant: options.adapter.variant,
    adapter_id: options.adapter.id,
    run_id: runId(manifest.case_id, options.adapter.variant, frozen.digest, evaluationDigest),
    frozen_case_sha256: frozen.digest,
    evaluation_contract_sha256: evaluationDigest,
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
      human_review_minutes: reviewValues.minutes,
      human_review_notes: reviewValues.notes,
      reference_leak_check: referenceMetric,
      artifact_count: measuredMetric(output.artifacts.length, "adapter_inventory"),
      evidence_count: measuredMetric(output.evidence.length, "adapter_inventory"),
      commit_identity: measuredMetric(options.identity.commit, "git_commit"),
      environment_identity: measuredMetric(options.identity.environment, "runtime_environment")
    }
  });
}
