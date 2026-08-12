import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  BenchmarkAdapter,
  BenchmarkManifest,
  BenchmarkSolveContext,
  BenchmarkVariant
} from "../src/benchmark/types.js";
import { runBenchmarkCase } from "../src/benchmark/runner.js";

async function createCase(): Promise<{ caseRoot: string; manifest: BenchmarkManifest; secret: string }> {
  const caseRoot = await mkdtemp(join(tmpdir(), "benchmark-runner-"));
  const secret = "REFERENCE-ANSWER-NEVER-IN-SOLVE-CONTEXT-314159265358979";
  await mkdir(resolve(caseRoot, "package"));
  await mkdir(resolve(caseRoot, "reference"));
  await writeFile(resolve(caseRoot, "package/problem.md"), "Estimate the synthetic quantity.\n", "utf8");
  await writeFile(resolve(caseRoot, "reference/reference.json"), `${JSON.stringify({ answer: secret })}\n`, "utf8");
  const manifest: BenchmarkManifest = {
    schema_version: "1.0.0",
    case_id: "synthetic-runner",
    package_path: "package",
    license: {
      name: "CC0 1.0 Universal",
      spdx_id: "CC0-1.0",
      copyright_holder: "modeling-agent contributors",
      source_url: null,
      redistribution: "permitted",
      notice_path: null
    },
    blind_policy: {
      mode: "blind",
      solve_input: "package_only",
      same_problem_answers: "block",
      minimum_reference_match_characters: 32
    },
    reference_policy: {
      access: "scoring_only",
      availability: "included",
      relative_path: "reference/reference.json",
      sha256: null
    },
    runtime: { agent_adapter_id: "agent-test-v1", one_shot_adapter_id: "one-shot-test-v1" },
    execution: { kind: "local", network_access: "disabled" },
    budget: { max_wall_time_ms: 1_000, max_tokens: 1_000, max_cost_usd: null, max_human_review_minutes: null },
    allowed_task_types: ["statistical_analysis", "custom_experiment"],
    expected_task_types: ["statistical_analysis"],
    hard_checks: [{ id: "answer-present", description: "An answer is produced." }]
  };
  await writeFile(resolve(caseRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { caseRoot, manifest, secret };
}

function adapter(
  id: string,
  variant: BenchmarkVariant,
  run: (context: BenchmarkSolveContext) => ReturnType<BenchmarkAdapter["run"]>
): BenchmarkAdapter {
  return { id, variant, run };
}

describe("benchmark runner", () => {
  it("gives agent and one-shot adapters the same frozen package and metric denominator without reference access", async () => {
    const { caseRoot, manifest, secret } = await createCase();
    const contexts: BenchmarkSolveContext[] = [];
    const makeAdapter = (id: string, variant: BenchmarkVariant): BenchmarkAdapter => adapter(id, variant, async (context) => {
      contexts.push(context);
      expect(JSON.stringify(context)).not.toContain(secret);
      expect(Object.keys(context).sort()).toEqual(["budget", "case_id", "expected_task_types", "frozen_case_sha256", "hard_checks", "package_files", "variant"]);
      expect(context.package_files.map((file) => file.relative_path)).toEqual(["problem.md"]);
      expect(context.package_files[0]!.content).toContain("synthetic quantity");
      return {
        status: "success",
        observed_task_types: ["statistical_analysis"],
        hard_checks: [{ id: "answer-present", passed: true }],
        artifacts: ["answer.md"],
        evidence: ["answer-evidence"],
        usage: { token_count: null, cost_usd: null },
        output_text: "Synthetic estimate produced."
      };
    });

    const agentResult = await runBenchmarkCase({
      case_root: caseRoot,
      manifest,
      adapter: makeAdapter("agent-test-v1", "agent"),
      identity: { commit: "a".repeat(40), environment: "test-environment" },
      clock: { measure: async (operation) => ({ value: await operation(), duration_ms: 25 }) }
    });
    const baselineResult = await runBenchmarkCase({
      case_root: caseRoot,
      manifest,
      adapter: makeAdapter("one-shot-test-v1", "one_shot"),
      identity: { commit: "a".repeat(40), environment: "test-environment" },
      clock: { measure: async (operation) => ({ value: await operation(), duration_ms: 20 }) }
    });

    expect(contexts).toHaveLength(2);
    expect(contexts[0]!.frozen_case_sha256).toBe(contexts[1]!.frozen_case_sha256);
    expect(contexts[0]!.expected_task_types).toEqual(contexts[1]!.expected_task_types);
    for (const result of [agentResult, baselineResult]) {
      expect(result.outcome).toBe("completed");
      expect(result.metrics.completion.value).toBe(true);
      expect(result.metrics.task_type_coverage.value).toBe(1);
      expect(result.metrics.token_count).toMatchObject({ status: "unavailable", value: null });
      expect(result.metrics.cost_usd).toMatchObject({ status: "unavailable", value: null });
    }
  });

  it("blocks and records same-problem answer leakage without counting the run as complete", async () => {
    const { caseRoot, manifest, secret } = await createCase();
    const leaking = adapter("agent-test-v1", "agent", async () => ({
      status: "success",
      observed_task_types: ["statistical_analysis"],
      hard_checks: [{ id: "answer-present", passed: true }],
      artifacts: ["answer.md"],
      evidence: ["answer-evidence"],
      usage: { token_count: 12, cost_usd: null },
      output_text: `I found the hidden value: ${secret.slice(0, 36)}\n${secret.slice(36)}`
    }));

    const result = await runBenchmarkCase({
      case_root: caseRoot,
      manifest,
      adapter: leaking,
      identity: { commit: "b".repeat(40), environment: "test-environment" },
      clock: { measure: async (operation) => ({ value: await operation(), duration_ms: 15 }) }
    });

    expect(result.state).toBe("blocked");
    expect(result.outcome).toBe("blocked_policy");
    expect(result.metrics.completion).toMatchObject({ status: "measured", value: false });
    expect(result.metrics.hard_error).toMatchObject({ status: "measured", value: true });
    expect(result.policy_events).toEqual([
      expect.objectContaining({ type: "same_problem_answer_detected", action: "blocked" })
    ]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(caseRoot);
  });

  it("rejects disallowed adapter task types as a measured contract hard error", async () => {
    const { caseRoot, manifest } = await createCase();
    const invalid = adapter("agent-test-v1", "agent", async () => ({
      status: "success",
      observed_task_types: ["optimization"],
      hard_checks: [{ id: "answer-present", passed: true }],
      artifacts: ["answer.md"],
      evidence: ["answer-evidence"],
      usage: { token_count: 10, cost_usd: null },
      output_text: "An invalid task type was reported."
    }));

    const result = await runBenchmarkCase({
      case_root: caseRoot,
      manifest,
      adapter: invalid,
      identity: { commit: "d".repeat(40), environment: "test-environment" },
      clock: { measure: async (operation) => ({ value: await operation(), duration_ms: 10 }) }
    });

    expect(result.outcome).toBe("hard_error");
    expect(result.metrics.completion.value).toBe(false);
    expect(result.metrics.hard_error.value).toBe(true);
    expect(result.error?.message).not.toContain("optimization");
  });

  it("enforces the wall-time budget and records timeout as an incomplete hard error", async () => {
    const { caseRoot, manifest } = await createCase();
    manifest.budget.max_wall_time_ms = 5;
    const hanging = adapter("agent-test-v1", "agent", async () => new Promise(() => undefined));

    const result = await runBenchmarkCase({
      case_root: caseRoot,
      manifest,
      adapter: hanging,
      identity: { commit: "e".repeat(40), environment: "test-environment" }
    });

    expect(result.outcome).toBe("hard_error");
    expect(result.metrics.completion.value).toBe(false);
    expect(result.metrics.hard_error.value).toBe(true);
  });

  it("turns adapter failures into measured incomplete hard errors instead of success", async () => {
    const { caseRoot, manifest } = await createCase();
    const failing = adapter("one-shot-test-v1", "one_shot", async () => {
      throw new Error(`credential=super-secret path=${caseRoot}`);
    });

    const result = await runBenchmarkCase({
      case_root: caseRoot,
      manifest,
      adapter: failing,
      identity: { commit: "c".repeat(40), environment: "test-environment" },
      clock: { measure: async (operation) => {
        try {
          return { value: await operation(), duration_ms: 30 };
        } catch (error) {
          Object.assign(error as object, { benchmark_duration_ms: 30 });
          throw error;
        }
      } }
    });

    expect(result.state).toBe("measured");
    expect(result.outcome).toBe("hard_error");
    expect(result.metrics.completion.value).toBe(false);
    expect(result.metrics.hard_error.value).toBe(true);
    expect(result.error?.class).toBe("Error");
    expect(result.error?.message).not.toContain("super-secret");
    expect(JSON.stringify(result)).not.toContain(caseRoot);
  });
});
