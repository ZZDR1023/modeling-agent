import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { BenchmarkResult } from "../src/benchmark/types.js";
import { measuredMetric, notRunMetric, unavailableMetric } from "../src/benchmark/contracts.js";
import { aggregateBenchmarkResults, writeBenchmarkReports } from "../src/benchmark/report.js";

function result(overrides: Partial<BenchmarkResult> = {}): BenchmarkResult {
  return {
    schema_version: "1.0.0",
    case_id: "synthetic-report",
    variant: "agent",
    adapter_id: "agent-v1",
    run_id: "synthetic-report-agent-aaaaaaaaaaaa",
    frozen_case_sha256: "a".repeat(64),
    evaluation_contract_sha256: "c".repeat(64),
    state: "measured",
    outcome: "completed",
    observed_task_types: ["statistical_analysis"],
    hard_checks: [{ id: "output", status: "passed" }],
    policy_events: [],
    error: null,
    metrics: {
      completion: measuredMetric(true, "harness_scoring"),
      hard_error: measuredMetric(false, "harness_scoring"),
      wall_time_ms: measuredMetric(10, "harness_clock"),
      task_type_coverage: measuredMetric(1, "harness_scoring"),
      custom_experiment_present: measuredMetric(false, "harness_scoring"),
      token_count: unavailableMetric("adapter_did_not_report"),
      cost_usd: unavailableMetric("adapter_did_not_report"),
      human_review_minutes: unavailableMetric("not_reviewed"),
      human_review_notes: unavailableMetric("not_reviewed"),
      reference_leak_check: measuredMetric(true, "harness_leak_check"),
      artifact_count: measuredMetric(1, "adapter_inventory"),
      evidence_count: measuredMetric(1, "adapter_inventory"),
      commit_identity: measuredMetric("a".repeat(40), "git_commit"),
      environment_identity: measuredMetric("node-24-linux-x64", "runtime_environment")
    },
    ...overrides
  };
}

describe("benchmark aggregate reports", () => {
  it("distinguishes measured, not_run, blocked, and unavailable without counting failure as completion", async () => {
    const blocked = result({
      variant: "one_shot",
      adapter_id: "one-shot-v1",
      run_id: "synthetic-report-one-shot-bbbbbbbbbbbb",
      state: "blocked",
      outcome: "blocked_policy",
      hard_checks: [{ id: "output", status: "blocked" }],
      policy_events: [{ type: "same_problem_answer_detected", action: "blocked", fingerprint: "b".repeat(64) }],
      metrics: {
        ...result().metrics,
        completion: measuredMetric(false, "harness_scoring"),
        hard_error: measuredMetric(true, "harness_scoring"),
        task_type_coverage: measuredMetric(0, "harness_scoring"),
        artifact_count: measuredMetric(0, "adapter_inventory"),
        evidence_count: measuredMetric(0, "adapter_inventory")
      }
    });
    const notRun = result({
      case_id: "historical-placeholder",
      variant: "agent",
      adapter_id: "not-run",
      run_id: "historical-placeholder-agent-notrun000000",
      state: "not_run",
      outcome: "not_run",
      observed_task_types: [],
      hard_checks: [],
      metrics: {
        completion: notRunMetric("case_material_not_available"),
        hard_error: notRunMetric("case_material_not_available"),
        wall_time_ms: notRunMetric("case_material_not_available"),
        task_type_coverage: notRunMetric("case_material_not_available"),
        custom_experiment_present: notRunMetric("case_material_not_available"),
        token_count: unavailableMetric("not_run"),
        cost_usd: unavailableMetric("not_run"),
        human_review_minutes: unavailableMetric("not_reviewed"),
        human_review_notes: unavailableMetric("not_reviewed"),
        reference_leak_check: unavailableMetric("not_run"),
        artifact_count: notRunMetric("case_material_not_available"),
        evidence_count: notRunMetric("case_material_not_available"),
        commit_identity: measuredMetric("a".repeat(40), "git_commit"),
        environment_identity: measuredMetric("node-24-linux-x64", "runtime_environment")
      }
    });

    const report = aggregateBenchmarkResults([result(), blocked, notRun]);
    expect(report.summary).toEqual({ total_runs: 3, measured_runs: 1, completed_runs: 1, hard_error_runs: 0, blocked_runs: 1, not_run_runs: 1 });
    expect(report.metrics.completion).toMatchObject({ measured_count: 2, unavailable_count: 0, not_run_count: 1 });
    expect(report.metrics.completion.values).toEqual([true, false]);
    expect(report.metrics.token_count).toMatchObject({ measured_count: 0, unavailable_count: 3, not_run_count: 0 });

    const output = await mkdtemp(join(tmpdir(), "benchmark-report-"));
    const paths = await writeBenchmarkReports(report, output);
    const json = await readFile(paths.json_path, "utf8");
    const markdown = await readFile(paths.markdown_path, "utf8");
    expect(JSON.parse(json)).toEqual(report);
    for (const label of ["measured", "not_run", "blocked", "unavailable"]) {
      expect(markdown).toContain(label);
    }
    expect(markdown).toContain("1 / 3");
    expect(markdown).not.toContain(output);
  });

  it("refuses to compare agent and one-shot results from different frozen case bytes", () => {
    const oneShot = result({
      variant: "one_shot",
      adapter_id: "one-shot-v1",
      run_id: "synthetic-report-one-shot-bbbbbbbbbbbb",
      frozen_case_sha256: "b".repeat(64)
    });
    expect(() => aggregateBenchmarkResults([result(), oneShot])).toThrow(/do not share a frozen case/i);
  });

  it("rejects duplicate run ids globally", () => {
    const duplicate = result({
      case_id: "synthetic-other",
      variant: "one_shot",
      adapter_id: "one-shot-v1"
    });
    expect(() => aggregateBenchmarkResults([result(), duplicate])).toThrow(/run id.*unique|duplicate run id/i);
  });

  it.each(["agent", "one_shot"] as const)("rejects a duplicate %s variant for one case", (variant) => {
    const first = result({
      variant,
      adapter_id: variant === "agent" ? "agent-v1" : "one-shot-v1",
      run_id: `synthetic-report-${variant.replace("_", "-")}-aaaaaaaaaaaa`
    });
    const duplicate = result({
      variant,
      adapter_id: variant === "agent" ? "agent-v2" : "one-shot-v2",
      run_id: `synthetic-report-${variant.replace("_", "-")}-bbbbbbbbbbbb`
    });
    expect(() => aggregateBenchmarkResults([first, duplicate])).toThrow(/duplicate.*variant|at most one.*variant/i);
  });

  it("rejects a third same-case result before contract comparison can ignore it", () => {
    const agent = result();
    const baseline = result({
      variant: "one_shot",
      adapter_id: "one-shot-v1",
      run_id: "synthetic-report-one-shot-bbbbbbbbbbbb"
    });
    const third = result({
      adapter_id: "agent-v2",
      run_id: "synthetic-report-agent-cccccccccccc",
      evaluation_contract_sha256: "d".repeat(64)
    });

    expect(() => aggregateBenchmarkResults([agent, baseline, third])).toThrow(/duplicate.*variant|at most one.*variant/i);
  });
});
