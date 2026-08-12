import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskType } from "../contracts/types.js";
import { validateBenchmarkManifest } from "./contracts.js";
import { aggregateBenchmarkResults, writeBenchmarkReports } from "./report.js";
import { runBenchmarkCase } from "./runner.js";
import type {
  BenchmarkAdapter,
  BenchmarkAdapterOutput,
  BenchmarkAggregateReport,
  BenchmarkClock,
  BenchmarkIdentity,
  BenchmarkManifest,
  BenchmarkResult,
  BenchmarkSolveContext,
  BenchmarkVariant
} from "./types.js";

const caseDirectories = ["summary-statistics", "custom-threshold"] as const;

async function defaultBenchmarkRoot(): Promise<string> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, "../../benchmarks/synthetic"),
    resolve(moduleDirectory, "../../../benchmarks/synthetic"),
    resolve(process.cwd(), "benchmarks/synthetic")
  ];
  for (const candidate of candidates) {
    try {
      await access(resolve(candidate, caseDirectories[0], "manifest.json"));
      return candidate;
    } catch {
      // Try the next explicit source/dist/project-root candidate.
    }
  }
  throw new Error("synthetic benchmark fixture root is unavailable");
}

const deterministicClock: BenchmarkClock = {
  async measure<T>(operation: () => Promise<T>): Promise<{ value: T; duration_ms: number }> {
    return { value: await operation(), duration_ms: 1 };
  }
};

const deterministicIdentity: BenchmarkIdentity = {
  commit: "synthetic-fixture-v1",
  environment: "deterministic-offline-v1"
};

function tasksFor(context: BenchmarkSolveContext): TaskType[] {
  return [...context.expected_task_types];
}

function hardChecksFor(context: BenchmarkSolveContext): Array<{ id: string; passed: boolean }> {
  return context.hard_checks.map((check) => ({ id: check.id, passed: true }));
}

function deterministicOutput(context: BenchmarkSolveContext, variant: BenchmarkVariant): BenchmarkAdapterOutput {
  const custom = context.expected_task_types.includes("custom_experiment");
  return {
    status: "success",
    observed_task_types: tasksFor(context),
    hard_checks: hardChecksFor(context),
    artifacts: custom ? ["experiment.json", "summary.md"] : ["summary.md"],
    evidence: custom ? ["threshold-evidence", "summary-evidence"] : ["summary-evidence"],
    usage: { token_count: 1, cost_usd: null },
    output_text: `${variant} deterministic synthetic output for ${context.case_id}; ${custom ? "custom experiment included" : "statistical summary included"}.`
  };
}

function syntheticAdapter(variant: BenchmarkVariant): BenchmarkAdapter {
  return {
    id: variant === "agent" ? "synthetic-agent-v1" : "synthetic-one-shot-v1",
    variant,
    run: async (context) => deterministicOutput(context, variant)
  };
}

async function loadManifest(caseRoot: string): Promise<BenchmarkManifest> {
  return validateBenchmarkManifest(JSON.parse(await readFile(resolve(caseRoot, "manifest.json"), "utf8")));
}

export interface RunSyntheticBenchmarksOptions {
  output_directory: string;
  benchmark_root?: string;
}

export interface SyntheticBenchmarkRun {
  results: BenchmarkResult[];
  report: BenchmarkAggregateReport;
  paths: { json_path: string; markdown_path: string };
}

export async function runSyntheticBenchmarks(options: RunSyntheticBenchmarksOptions): Promise<SyntheticBenchmarkRun> {
  const benchmarkRoot = options.benchmark_root ?? await defaultBenchmarkRoot();
  const results: BenchmarkResult[] = [];
  for (const directory of caseDirectories) {
    const caseRoot = resolve(benchmarkRoot, directory);
    const manifest = await loadManifest(caseRoot);
    for (const variant of ["agent", "one_shot"] as const) {
      results.push(await runBenchmarkCase({
        case_root: caseRoot,
        manifest,
        adapter: syntheticAdapter(variant),
        identity: deterministicIdentity,
        clock: deterministicClock
      }));
    }
  }
  const report = aggregateBenchmarkResults(results, "synthetic-v1");
  const paths = await writeBenchmarkReports(report, options.output_directory);
  return { results, report, paths };
}
