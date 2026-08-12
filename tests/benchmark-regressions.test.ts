import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { aggregateBenchmarkResults } from "../src/benchmark/report.js";
import { runBenchmarkCase, type RunBenchmarkCaseOptions } from "../src/benchmark/runner.js";
import type {
  BenchmarkAdapter,
  BenchmarkAdapterOutput,
  BenchmarkManifest,
  BenchmarkResult,
  BenchmarkSolveContext,
  BenchmarkVariant
} from "../src/benchmark/types.js";

const ORIGINAL_REFERENCE = "REFERENCE-ORIGINAL-ALPHA-314159265358979323846";
const REPLACEMENT_REFERENCE = "REFERENCE-REPLACED-BETA-271828182845904523536";

async function createCase(): Promise<{ caseRoot: string; manifest: BenchmarkManifest; referencePath: string }> {
  const caseRoot = await mkdtemp(join(tmpdir(), "benchmark-regression-"));
  const referencePath = resolve(caseRoot, "reference/reference.txt");
  await mkdir(resolve(caseRoot, "package"));
  await mkdir(resolve(caseRoot, "reference"));
  await writeFile(resolve(caseRoot, "package/problem.md"), "Solve this synthetic package.\n", "utf8");
  await writeFile(referencePath, `${ORIGINAL_REFERENCE}\n`, "utf8");
  return {
    caseRoot,
    referencePath,
    manifest: {
      schema_version: "1.0.0",
      case_id: "synthetic-regression",
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
        minimum_reference_match_characters: 24
      },
      reference_policy: {
        access: "scoring_only",
        availability: "included",
        relative_path: "reference/reference.txt",
        sha256: null
      },
      runtime: { agent_adapter_id: "agent-regression-v1", one_shot_adapter_id: "one-shot-regression-v1" },
      execution: { kind: "local", network_access: "disabled" },
      budget: { max_wall_time_ms: 1_000, max_tokens: null, max_cost_usd: null, max_human_review_minutes: null },
      allowed_task_types: ["statistical_analysis", "custom_experiment"],
      expected_task_types: ["statistical_analysis"],
      hard_checks: [{ id: "answer-present", description: "A synthetic answer is present." }]
    }
  };
}

function outputFor(manifest: BenchmarkManifest, overrides: Partial<BenchmarkAdapterOutput> = {}): BenchmarkAdapterOutput {
  return {
    status: "success",
    observed_task_types: [...manifest.expected_task_types],
    hard_checks: manifest.hard_checks.map((check) => ({ id: check.id, passed: true })),
    artifacts: ["answer.md"],
    evidence: ["answer-evidence"],
    usage: { token_count: null, cost_usd: null },
    output_text: "A synthetic answer was produced.",
    ...overrides
  };
}

function adapter(
  id: string,
  variant: BenchmarkVariant,
  run: (context: BenchmarkSolveContext) => Promise<BenchmarkAdapterOutput>
): BenchmarkAdapter {
  return { id, variant, run };
}

function deterministicClock(duration_ms = 1) {
  return { measure: async <T>(operation: () => Promise<T>) => ({ value: await operation(), duration_ms }) };
}

async function runVariant(
  caseRoot: string,
  manifest: BenchmarkManifest,
  variant: BenchmarkVariant,
  overrides: Partial<BenchmarkAdapterOutput> = {},
  extra: Partial<RunBenchmarkCaseOptions> & Record<string, unknown> = {}
): Promise<BenchmarkResult> {
  const id = variant === "agent" ? manifest.runtime.agent_adapter_id : manifest.runtime.one_shot_adapter_id;
  const options = {
    case_root: caseRoot,
    manifest,
    adapter: adapter(id, variant, async () => outputFor(manifest, overrides)),
    identity: { commit: "commit-regression-v1", environment: "node-test-v1" },
    clock: deterministicClock(),
    ...extra
  };
  return runBenchmarkCase(options as RunBenchmarkCaseOptions);
}

function evaluationDigest(result: BenchmarkResult): unknown {
  return (result as BenchmarkResult & { evaluation_contract_sha256?: unknown }).evaluation_contract_sha256;
}

function referenceLeakMetric(result: BenchmarkResult): unknown {
  return (result.metrics as BenchmarkResult["metrics"] & { reference_leak_check?: unknown }).reference_leak_check;
}

describe("benchmark regression hardening", () => {
  it("rejects a reference nested in the package before invoking the solve adapter", async () => {
    const { caseRoot, manifest } = await createCase();
    const secret = "REFERENCE-NESTED-IN-PACKAGE-TOP-SECRET-123456789";
    await writeFile(resolve(caseRoot, "package/reference.txt"), secret, "utf8");
    manifest.reference_policy.relative_path = "package/reference.txt";
    let adapterCalled = false;
    let solveSawReference = false;

    const run = runBenchmarkCase({
      case_root: caseRoot,
      manifest,
      adapter: adapter("agent-regression-v1", "agent", async (context) => {
        adapterCalled = true;
        solveSawReference = JSON.stringify(context).includes(secret);
        return outputFor(manifest);
      }),
      identity: { commit: "commit-regression-v1", environment: "node-test-v1" },
      clock: deterministicClock()
    });

    await expect(run).rejects.toThrow(/reference.*package/i);
    expect(adapterCalled).toBe(false);
    expect(solveSawReference).toBe(false);
  });

  it("rejects a package symlink whose canonical directory covers the reference", async () => {
    const { caseRoot, manifest } = await createCase();
    await rm(resolve(caseRoot, "package"), { recursive: true });
    await mkdir(resolve(caseRoot, "shared"));
    await writeFile(resolve(caseRoot, "shared/problem.md"), "Synthetic problem.\n", "utf8");
    await writeFile(resolve(caseRoot, "shared/reference.txt"), ORIGINAL_REFERENCE, "utf8");
    await symlink("shared", resolve(caseRoot, "package"), "dir");
    manifest.reference_policy.relative_path = "shared/reference.txt";
    let adapterCalled = false;

    const run = runBenchmarkCase({
      case_root: caseRoot,
      manifest,
      adapter: adapter("agent-regression-v1", "agent", async () => {
        adapterCalled = true;
        return outputFor(manifest);
      }),
      identity: { commit: "commit-regression-v1", environment: "node-test-v1" },
      clock: deterministicClock()
    });

    await expect(run).rejects.toThrow(/reference.*package/i);
    expect(adapterCalled).toBe(false);
  });

  it.each(["included", "user_supplied"] as const)(
    "opens an %s reference only after the adapter finishes and keeps it out of solve context",
    async (availability) => {
      const { caseRoot, manifest } = await createCase();
      manifest.reference_policy.availability = availability;
      const result = await runBenchmarkCase({
        case_root: caseRoot,
        manifest,
        adapter: adapter("agent-regression-v1", "agent", async (context) => {
          const serialized = JSON.stringify(context);
          expect(serialized).not.toContain(ORIGINAL_REFERENCE);
          expect(serialized).not.toContain("reference/reference.txt");
          expect(Object.keys(context).sort()).toEqual([
            "budget",
            "case_id",
            "expected_task_types",
            "frozen_case_sha256",
            "hard_checks",
            "package_files",
            "variant"
          ]);
          return outputFor(manifest, { output_text: ORIGINAL_REFERENCE });
        }),
        identity: { commit: "commit-regression-v1", environment: "node-test-v1" },
        clock: deterministicClock()
      });

      expect(result.outcome).toBe("blocked_policy");
      expect(result.metrics.completion).toMatchObject({ status: "measured", value: false });
      expect(JSON.stringify(result)).not.toContain(ORIGINAL_REFERENCE);
    }
  );

  it("marks a missing user-supplied scoring reference unavailable and does not claim completion", async () => {
    const { caseRoot, manifest } = await createCase();
    manifest.reference_policy = {
      access: "scoring_only",
      availability: "user_supplied",
      relative_path: "reference/not-provided.txt",
      sha256: null
    };

    const result = await runVariant(caseRoot, manifest, "agent");
    expect(result.outcome).toBe("incomplete");
    expect(result.metrics.completion).toMatchObject({ status: "measured", value: false });
    expect(referenceLeakMetric(result)).toMatchObject({ status: "unavailable", value: null });
  });

  it("records one stable evaluation contract for both variants and binds it into run ids", async () => {
    const { caseRoot, manifest } = await createCase();
    const agentResult = await runVariant(caseRoot, manifest, "agent");
    const baselineResult = await runVariant(caseRoot, manifest, "one_shot");

    expect(evaluationDigest(agentResult)).toMatch(/^[a-f0-9]{64}$/);
    expect(evaluationDigest(agentResult)).toBe(evaluationDigest(baselineResult));
    expect(agentResult.run_id).not.toBe(baselineResult.run_id);
    expect(agentResult.run_id).toContain(String(evaluationDigest(agentResult)).slice(0, 12));
  });

  it.each(["budget", "expected tasks", "hard checks", "reference bytes"] as const)(
    "refuses to compare variants with different %s in the frozen evaluation contract",
    async (dimension) => {
      const { caseRoot, manifest, referencePath } = await createCase();
      const agentResult = await runVariant(caseRoot, manifest, "agent");
      const altered = structuredClone(manifest);
      if (dimension === "budget") {
        altered.budget.max_tokens = 50;
      } else if (dimension === "expected tasks") {
        altered.expected_task_types = ["statistical_analysis", "custom_experiment"];
      } else if (dimension === "hard checks") {
        altered.hard_checks[0]!.description = "A materially different scoring requirement.";
      } else {
        await writeFile(referencePath, `${REPLACEMENT_REFERENCE}\n`, "utf8");
      }
      const usage = dimension === "budget" ? { token_count: 10, cost_usd: null } : { token_count: null, cost_usd: null };
      const baselineResult = await runVariant(caseRoot, altered, "one_shot", { usage });

      expect(evaluationDigest(agentResult)).not.toBe(evaluationDigest(baselineResult));
      expect(() => aggregateBenchmarkResults([agentResult, baselineResult])).toThrow(/evaluation contract/i);
    }
  );

  it("binds both adapter ids plus blind and execution policy into the evaluation contract", async () => {
    const { caseRoot, manifest } = await createCase();
    const agentResult = await runVariant(caseRoot, manifest, "agent");
    const altered = structuredClone(manifest);
    altered.runtime.agent_adapter_id = "agent-regression-v2";
    altered.blind_policy.minimum_reference_match_characters += 1;
    altered.execution.network_access = "research_gateway_only";
    const baselineResult = await runVariant(caseRoot, altered, "one_shot");

    expect(evaluationDigest(agentResult)).not.toBe(evaluationDigest(baselineResult));
    expect(() => aggregateBenchmarkResults([agentResult, baselineResult])).toThrow(/evaluation contract/i);
  });

  it.each([
    { name: "wall time", budget: { max_wall_time_ms: 5 }, output: {}, duration: 6 },
    { name: "tokens over limit", budget: { max_tokens: 10 }, output: { usage: { token_count: 11, cost_usd: null } }, duration: 1 },
    { name: "tokens unavailable", budget: { max_tokens: 10 }, output: { usage: { token_count: null, cost_usd: null } }, duration: 1 },
    { name: "cost over limit", budget: { max_cost_usd: 0.1 }, output: { usage: { token_count: null, cost_usd: 0.2 } }, duration: 1 },
    { name: "cost unavailable", budget: { max_cost_usd: 0.1 }, output: { usage: { token_count: null, cost_usd: null } }, duration: 1 },
    { name: "review over limit", budget: { max_human_review_minutes: 5 }, output: {}, duration: 1, review: { minutes: 6, notes: "major_revision" } },
    { name: "review unavailable", budget: { max_human_review_minutes: 5 }, output: {}, duration: 1 }
  ])("makes completion incomplete when the declared $name budget cannot be proven", async ({ budget, output, duration, review }) => {
    const { caseRoot, manifest } = await createCase();
    Object.assign(manifest.budget, budget);
    const options = {
      case_root: caseRoot,
      manifest,
      adapter: adapter("agent-regression-v1", "agent", async () => outputFor(manifest, output)),
      identity: { commit: "commit-regression-v1", environment: "node-test-v1" },
      clock: deterministicClock(duration),
      review_observation: review
    } as RunBenchmarkCaseOptions & { review_observation?: unknown };

    const result = await runBenchmarkCase(options);
    expect(result.outcome).toBe("incomplete");
    expect(result.metrics.completion).toMatchObject({ status: "measured", value: false });
    expect(result.metrics.hard_error).toMatchObject({ status: "measured", value: false });
  });

  it("records a bounded human-review observation and permits completion within all declared budgets", async () => {
    const { caseRoot, manifest } = await createCase();
    manifest.budget = { max_wall_time_ms: 100, max_tokens: 20, max_cost_usd: 1, max_human_review_minutes: 5 };
    const options = {
      case_root: caseRoot,
      manifest,
      adapter: adapter("agent-regression-v1", "agent", async () => outputFor(manifest, {
        usage: { token_count: 10, cost_usd: 0.5 }
      })),
      identity: { commit: "commit-regression-v1", environment: "node-test-v1" },
      clock: deterministicClock(10),
      review_observation: { minutes: 4, notes: "minor_revision" }
    } as RunBenchmarkCaseOptions & { review_observation: unknown };

    const result = await runBenchmarkCase(options);
    expect(result.outcome).toBe("completed");
    expect(result.metrics.human_review_minutes).toMatchObject({ status: "measured", value: 4 });
    expect(result.metrics.human_review_notes).toMatchObject({ status: "measured", value: "minor_revision" });
  });

  it("rejects arbitrary human-review notes before adapter execution", async () => {
    const { caseRoot, manifest } = await createCase();
    let adapterCalled = false;
    const options = {
      case_root: caseRoot,
      manifest,
      adapter: adapter("agent-regression-v1", "agent", async () => {
        adapterCalled = true;
        return outputFor(manifest);
      }),
      identity: { commit: "commit-regression-v1", environment: "node-test-v1" },
      review_observation: { minutes: 1, notes: "token=TOP-SECRET /home/private" }
    } as unknown as RunBenchmarkCaseOptions;

    await expect(runBenchmarkCase(options)).rejects.toThrow(/review observation/i);
    expect(adapterCalled).toBe(false);
  });

  it("drops untrusted hard-check notes instead of persisting reference, credential, or host path text", async () => {
    const { caseRoot, manifest } = await createCase();
    const malicious = "REFERENCE token=TOP-SECRET /home/private/result.txt";
    const result = await runVariant(caseRoot, manifest, "agent", {
      hard_checks: [{ id: "answer-present", passed: true, note: malicious }]
    });

    expect(result.outcome).toBe("completed");
    expect(JSON.stringify(result)).not.toContain(malicious);
    expect(JSON.stringify(result)).not.toContain("TOP-SECRET");
    expect(JSON.stringify(result)).not.toContain("/home/private");
  });

  it.each([
    {
      name: "success carrying an error",
      make: (manifest: BenchmarkManifest) => outputFor(manifest, { status: "success", error: { class: "Error", message: "TOP-SECRET" } })
    },
    {
      name: "failed without an error",
      make: (manifest: BenchmarkManifest) => {
        const output = outputFor(manifest, { status: "failed" });
        delete output.error;
        return output;
      }
    },
    {
      name: "missing hard-check observation",
      make: (manifest: BenchmarkManifest) => outputFor(manifest, { hard_checks: [] })
    },
    {
      name: "duplicate hard-check observation",
      make: (manifest: BenchmarkManifest) => outputFor(manifest, {
        hard_checks: [
          { id: "answer-present", passed: true },
          { id: "answer-present", passed: true, note: "token=TOP-SECRET /home/private" }
        ]
      })
    },
    {
      name: "unknown hard-check observation",
      make: (manifest: BenchmarkManifest) => outputFor(manifest, { hard_checks: [{ id: "unknown-check", passed: true }] })
    }
  ])("turns $name into a fingerprint-only measured hard error", async ({ make }) => {
    const { caseRoot, manifest } = await createCase();
    const invalidOutput = make(manifest);
    const result = await runBenchmarkCase({
      case_root: caseRoot,
      manifest,
      adapter: adapter("agent-regression-v1", "agent", async () => invalidOutput),
      identity: { commit: "commit-regression-v1", environment: "node-test-v1" },
      clock: deterministicClock()
    });

    expect(result.outcome).toBe("hard_error");
    expect(result.metrics.completion).toMatchObject({ status: "measured", value: false });
    expect(result.metrics.hard_error).toMatchObject({ status: "measured", value: true });
    expect(result.error?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.error?.message).toMatch(/^failure:[a-f0-9]{12}$/);
    expect(JSON.stringify(result)).not.toContain("TOP-SECRET");
    expect(JSON.stringify(result)).not.toContain("/home/private");
  });

  it("rejects unsafe adapter, manifest identity, and suite identifiers without persisting them", async () => {
    const { caseRoot, manifest } = await createCase();
    let adapterCalled = false;
    const unsafeEnvironment = "token=TOP-SECRET /home/private";
    await expect(runBenchmarkCase({
      case_root: caseRoot,
      manifest,
      adapter: adapter("agent-regression-v1", "agent", async () => {
        adapterCalled = true;
        return outputFor(manifest);
      }),
      identity: { commit: "commit-regression-v1", environment: unsafeEnvironment },
      clock: deterministicClock()
    })).rejects.toThrow(/identity/i);
    expect(adapterCalled).toBe(false);

    const unsafeManifest = structuredClone(manifest);
    unsafeManifest.runtime.agent_adapter_id = "../../token=TOP-SECRET";
    await expect(runBenchmarkCase({
      case_root: caseRoot,
      manifest: unsafeManifest,
      adapter: adapter("../../token=TOP-SECRET", "agent", async () => outputFor(unsafeManifest)),
      identity: { commit: "commit-regression-v1", environment: "node-test-v1" },
      clock: deterministicClock()
    })).rejects.toThrow();

    expect(() => aggregateBenchmarkResults([], "../../token=TOP-SECRET /home/private")).toThrow(/suite id/i);
  });

  it("sanitizes an adapter-reported error class and message to an opaque class plus fingerprint", async () => {
    const { caseRoot, manifest } = await createCase();
    const result = await runVariant(caseRoot, manifest, "agent", {
      status: "failed",
      error: { class: "../../SecretError token=TOP-SECRET", message: "/home/private/credential.txt" }
    });

    expect(result.outcome).toBe("hard_error");
    expect(result.error?.class).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(result.error?.message).toMatch(/^failure:[a-f0-9]{12}$/);
    expect(JSON.stringify(result)).not.toContain("TOP-SECRET");
    expect(JSON.stringify(result)).not.toContain("/home/private");
  });

  it("requires the new evaluation digest and leak-check boundary in every production result", async () => {
    const { caseRoot, manifest } = await createCase();
    const result = await runVariant(caseRoot, manifest, "agent");
    const missingDigest = structuredClone(result) as unknown as Omit<BenchmarkResult, "evaluation_contract_sha256"> & { evaluation_contract_sha256?: string };
    delete missingDigest.evaluation_contract_sha256;
    expect(() => aggregateBenchmarkResults([missingDigest as BenchmarkResult])).toThrow();

    const missingLeakCheck = structuredClone(result) as BenchmarkResult;
    const partialMetrics = missingLeakCheck.metrics as unknown as { reference_leak_check?: unknown };
    delete partialMetrics.reference_leak_check;
    expect(() => aggregateBenchmarkResults([missingLeakCheck])).toThrow();
  });
});
