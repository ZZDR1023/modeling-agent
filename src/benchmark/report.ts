import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BENCHMARK_SCHEMA_VERSION } from "./types.js";
import type {
  BenchmarkAggregateReport,
  BenchmarkMetric,
  BenchmarkMetricAggregate,
  BenchmarkMetrics,
  BenchmarkResult,
  MetricValue
} from "./types.js";
import { validateBenchmarkResult } from "./contracts.js";

const metricNames: Array<keyof BenchmarkMetrics> = [
  "completion",
  "hard_error",
  "wall_time_ms",
  "task_type_coverage",
  "custom_experiment_present",
  "token_count",
  "cost_usd",
  "human_review_minutes",
  "human_review_notes",
  "reference_leak_check",
  "artifact_count",
  "evidence_count",
  "commit_identity",
  "environment_identity"
];

function aggregateMetric(metrics: Array<BenchmarkMetric<MetricValue>>): BenchmarkMetricAggregate {
  return {
    measured_count: metrics.filter((metric) => metric.status === "measured").length,
    unavailable_count: metrics.filter((metric) => metric.status === "unavailable").length,
    not_run_count: metrics.filter((metric) => metric.status === "not_run").length,
    blocked_count: metrics.filter((metric) => metric.status === "blocked").length,
    values: metrics.flatMap((metric) => metric.status === "measured" ? [metric.value] : [])
  };
}

function stableResultOrder(left: BenchmarkResult, right: BenchmarkResult): number {
  return left.case_id.localeCompare(right.case_id) || left.variant.localeCompare(right.variant) || left.run_id.localeCompare(right.run_id);
}

function assertComparableVariants(results: readonly BenchmarkResult[]): void {
  const groups = new Map<string, BenchmarkResult[]>();
  for (const result of results) {
    const group = groups.get(result.case_id) ?? [];
    group.push(result);
    groups.set(result.case_id, group);
  }
  for (const [caseId, group] of groups) {
    const agent = group.find((result) => result.variant === "agent");
    const oneShot = group.find((result) => result.variant === "one_shot");
    if (agent && oneShot && agent.frozen_case_sha256 !== oneShot.frozen_case_sha256) {
      throw new Error(`benchmark variants for ${caseId} do not share a frozen case`);
    }
    if (agent && oneShot && agent.evaluation_contract_sha256 !== oneShot.evaluation_contract_sha256) {
      throw new Error(`benchmark variants for ${caseId} do not share an evaluation contract`);
    }
  }
}

export function aggregateBenchmarkResults(input: readonly BenchmarkResult[], suiteId = "synthetic-v1"): BenchmarkAggregateReport {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(suiteId)) {
    throw new Error("benchmark suite id must be a bounded opaque identifier");
  }
  const results = input.map((entry) => validateBenchmarkResult(structuredClone(entry))).sort(stableResultOrder);
  assertComparableVariants(results);
  const metrics = Object.fromEntries(metricNames.map((name) => [name, aggregateMetric(results.map((result) => result.metrics[name]))])) as Record<keyof BenchmarkMetrics, BenchmarkMetricAggregate>;
  return {
    schema_version: BENCHMARK_SCHEMA_VERSION,
    report_kind: "benchmark_aggregate",
    suite_id: suiteId,
    summary: {
      total_runs: results.length,
      measured_runs: results.filter((result) => result.state === "measured").length,
      completed_runs: results.filter((result) => result.outcome === "completed" && result.metrics.completion.status === "measured" && result.metrics.completion.value === true).length,
      hard_error_runs: results.filter((result) => result.state === "measured" && result.outcome === "hard_error").length,
      blocked_runs: results.filter((result) => result.state === "blocked").length,
      not_run_runs: results.filter((result) => result.state === "not_run").length
    },
    metrics,
    results
  };
}

function metricDisplay(metric: BenchmarkMetric<MetricValue>): string {
  if (metric.status === "measured") return `measured: ${String(metric.value)}`;
  return `${metric.status}: ${metric.reason}`;
}

export function renderBenchmarkMarkdown(report: BenchmarkAggregateReport): string {
  const lines = [
    "# Benchmark aggregate report",
    "",
    `Suite: \`${report.suite_id}\``,
    "",
    "## Status legend",
    "",
    "- `measured`: the harness observed a value.",
    "- `not_run`: the run was intentionally not executed.",
    "- `blocked`: policy prevented the run or metric from being accepted.",
    "- `unavailable`: a run occurred but the adapter or reviewer did not provide the metric.",
    "",
    "## Summary",
    "",
    `- Completion: ${report.summary.completed_runs} / ${report.summary.total_runs}`,
    `- Measured runs: ${report.summary.measured_runs}`,
    `- Hard-error runs: ${report.summary.hard_error_runs}`,
    `- Blocked runs: ${report.summary.blocked_runs}`,
    `- Not-run runs: ${report.summary.not_run_runs}`,
    "",
    "A failed, blocked, or not-run result is never counted as completion.",
    "",
    "## Runs",
    "",
    "| Case | Variant | State | Outcome | Completion | Hard error | Coverage | Token count | Cost USD | Human review | Artifacts | Evidence |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  ];
  for (const result of report.results) {
    lines.push(`| ${result.case_id} | ${result.variant} | ${result.state} | ${result.outcome} | ${metricDisplay(result.metrics.completion)} | ${metricDisplay(result.metrics.hard_error)} | ${metricDisplay(result.metrics.task_type_coverage)} | ${metricDisplay(result.metrics.token_count)} | ${metricDisplay(result.metrics.cost_usd)} | ${metricDisplay(result.metrics.human_review_minutes)} | ${metricDisplay(result.metrics.artifact_count)} | ${metricDisplay(result.metrics.evidence_count)} |`);
  }
  lines.push("", "## Metric availability", "", "| Metric | measured | unavailable | not_run | blocked |", "| --- | ---: | ---: | ---: | ---: |");
  for (const name of metricNames) {
    const aggregate = report.metrics[name];
    lines.push(`| ${name} | ${aggregate.measured_count} | ${aggregate.unavailable_count} | ${aggregate.not_run_count} | ${aggregate.blocked_count} |`);
  }
  return `${lines.join("\n")}\n`;
}

export async function writeBenchmarkReports(report: BenchmarkAggregateReport, outputDirectory: string): Promise<{ json_path: string; markdown_path: string }> {
  await mkdir(outputDirectory, { recursive: true });
  const jsonPath = resolve(outputDirectory, "benchmark-report.json");
  const markdownPath = resolve(outputDirectory, "benchmark-report.md");
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(markdownPath, renderBenchmarkMarkdown(report), "utf8")
  ]);
  return { json_path: jsonPath, markdown_path: markdownPath };
}
