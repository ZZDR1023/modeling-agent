import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import type {
  BenchmarkManifest,
  BenchmarkMetric,
  BenchmarkResult,
  BlockedMetric,
  MeasuredMetric,
  MetricValue,
  NotRunMetric,
  UnavailableMetric
} from "./types.js";

export type BenchmarkContractName = "benchmark-manifest" | "benchmark-result";

const schemaFiles: Record<BenchmarkContractName, string> = {
  "benchmark-manifest": "benchmark-manifest.v1.json",
  "benchmark-result": "benchmark-result.v1.json"
};

export class BenchmarkContractError extends Error {
  readonly contract: BenchmarkContractName;
  readonly validation_errors: ErrorObject[];

  constructor(contract: BenchmarkContractName, message: string, validationErrors: ErrorObject[] = []) {
    super(`Benchmark contract ${contract} failed: ${message}`);
    this.name = "BenchmarkContractError";
    this.contract = contract;
    this.validation_errors = validationErrors;
  }
}

function locateSchemaDirectory(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, "../../schemas"),
    resolve(moduleDirectory, "../../../schemas"),
    resolve(process.cwd(), "schemas")
  ];
  const directory = candidates.find((candidate) => Object.values(schemaFiles).every((filename) => existsSync(resolve(candidate, filename))));
  if (directory === undefined) {
    throw new BenchmarkContractError("benchmark-manifest", "schema directory is unavailable");
  }
  return directory;
}

class BenchmarkSchemaRegistry {
  readonly #validators = new Map<BenchmarkContractName, ValidateFunction>();

  constructor(schemaDirectory = locateSchemaDirectory()) {
    const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
    ajv.addFormat("uri", {
      type: "string",
      validate: (value: string) => {
        try {
          const url = new URL(value);
          return url.protocol === "https:" || url.protocol === "http:";
        } catch {
          return false;
        }
      }
    });
    for (const [name, filename] of Object.entries(schemaFiles) as Array<[BenchmarkContractName, string]>) {
      const schema = JSON.parse(readFileSync(resolve(schemaDirectory, filename), "utf8")) as object;
      this.#validators.set(name, ajv.compile(schema));
    }
  }

  validate<T>(name: BenchmarkContractName, value: unknown): T {
    const validator = this.#validators.get(name);
    if (!validator) {
      throw new BenchmarkContractError(name, "validator is unavailable");
    }
    if (!validator(value)) {
      const errors = validator.errors ?? [];
      const message = errors.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ");
      const pathMessage = errors.some((error) => error.keyword === "pattern" && ["/package_path", "/license/notice_path", "/reference_policy/relative_path"].includes(error.instancePath))
        ? `path must be a normalized relative path; ${message}`
        : message;
      throw new BenchmarkContractError(name, pathMessage, errors);
    }
    return value as T;
  }
}

const registry = new BenchmarkSchemaRegistry();

function validateManifestSemantics(manifest: BenchmarkManifest): void {
  const allowed = new Set(manifest.allowed_task_types);
  const unexpected = manifest.expected_task_types.find((taskType) => !allowed.has(taskType));
  if (unexpected) {
    throw new BenchmarkContractError("benchmark-manifest", `expected task type ${unexpected} is not allowed`);
  }
  const checkIds = manifest.hard_checks.map((check) => check.id);
  if (new Set(checkIds).size !== checkIds.length) {
    throw new BenchmarkContractError("benchmark-manifest", "hard check ids must be unique");
  }
  const reference = manifest.reference_policy;
  if (reference.availability === "included" && reference.relative_path === null) {
    throw new BenchmarkContractError("benchmark-manifest", "included reference requires a relative_path");
  }
  if (reference.availability === "unavailable" && (reference.relative_path !== null || reference.sha256 !== null)) {
    throw new BenchmarkContractError("benchmark-manifest", "unavailable reference cannot declare a path or digest");
  }
  if (manifest.license.redistribution !== "permitted" && reference.availability === "included") {
    throw new BenchmarkContractError("benchmark-manifest", "non-redistributable reference material cannot be included");
  }
}

function measuredBoolean(metric: BenchmarkMetric<boolean>, expected: boolean): boolean {
  return metric.status === "measured" && metric.value === expected;
}

function validateResultSemantics(result: BenchmarkResult): void {
  const hardCheckIds = result.hard_checks.map((check) => check.id);
  if (new Set(hardCheckIds).size !== hardCheckIds.length) {
    throw new BenchmarkContractError("benchmark-result", "hard check ids must be unique");
  }
  if (result.outcome === "completed") {
    if (result.state !== "measured" || result.error !== null || !measuredBoolean(result.metrics.completion, true) || !measuredBoolean(result.metrics.hard_error, false) || result.hard_checks.some((check) => check.status !== "passed")) {
      throw new BenchmarkContractError("benchmark-result", "completed result contradicts completion, error, hard-error, state, or hard-check evidence");
    }
  } else if (result.metrics.completion.status === "measured" && result.metrics.completion.value === true) {
    throw new BenchmarkContractError("benchmark-result", "non-completed result cannot report completion=true");
  }
  if (result.state === "blocked" && (result.outcome !== "blocked_policy" || result.policy_events.length === 0)) {
    throw new BenchmarkContractError("benchmark-result", "blocked state requires blocked_policy outcome and a policy event");
  }
  if (result.state === "not_run" && result.outcome !== "not_run") {
    throw new BenchmarkContractError("benchmark-result", "not_run state requires not_run outcome");
  }
  if (result.state === "measured" && result.outcome === "not_run") {
    throw new BenchmarkContractError("benchmark-result", "measured state cannot have not_run outcome");
  }
  if ((result.outcome === "hard_error" || result.outcome === "blocked_policy") && !measuredBoolean(result.metrics.hard_error, true)) {
    throw new BenchmarkContractError("benchmark-result", `${result.outcome} requires hard_error=true`);
  }
}

export function validateBenchmarkManifest(value: unknown): BenchmarkManifest {
  const manifest = registry.validate<BenchmarkManifest>("benchmark-manifest", value);
  validateManifestSemantics(manifest);
  return manifest;
}

export function validateBenchmarkResult(value: unknown): BenchmarkResult {
  const result = registry.validate<BenchmarkResult>("benchmark-result", value);
  validateResultSemantics(result);
  return result;
}

export function measuredMetric<T extends MetricValue>(value: T, source: string): MeasuredMetric<T> {
  return { status: "measured", value, source };
}

export function unavailableMetric(reason: string): UnavailableMetric {
  return { status: "unavailable", value: null, reason };
}

export function notRunMetric(reason: string): NotRunMetric {
  return { status: "not_run", value: null, reason };
}

export function blockedMetric(reason: string): BlockedMetric {
  return { status: "blocked", value: null, reason };
}
