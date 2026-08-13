import { createHash } from "node:crypto";
import { chmod, link, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { aggregateBenchmarkResults } from "../src/benchmark/report.js";
import { runBenchmarkCase } from "../src/benchmark/runner.js";
import type {
  BenchmarkAdapter,
  BenchmarkAdapterOutput,
  BenchmarkManifest,
  BenchmarkResult,
  BenchmarkVariant
} from "../src/benchmark/types.js";

const ALPHA_REFERENCE = "REFERENCE-FINALIZATION-ALPHA-314159265358979323846";
const BETA_REFERENCE = "REFERENCE-FINALIZATION-BETA-271828182845904523536";

type FailureMode = "throw" | "timeout" | "invalid_output";
type ReferenceMutation = "delete" | "not_regular" | "digest_mismatch";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createCase(): Promise<{ caseRoot: string; manifest: BenchmarkManifest; referencePath: string }> {
  const caseRoot = await mkdtemp(join(tmpdir(), "benchmark-finalization-"));
  const referencePath = resolve(caseRoot, "reference/reference.txt");
  await mkdir(resolve(caseRoot, "package"));
  await mkdir(resolve(caseRoot, "reference"));
  await writeFile(resolve(caseRoot, "package/problem.md"), "Solve the synthetic finalization case.\n", "utf8");
  await writeFile(referencePath, `${ALPHA_REFERENCE}\n`, "utf8");
  return {
    caseRoot,
    referencePath,
    manifest: {
      schema_version: "1.0.0",
      case_id: "synthetic-finalization",
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
      runtime: {
        agent_adapter_id: "finalization-agent-v1",
        one_shot_adapter_id: "finalization-one-shot-v1"
      },
      execution: { kind: "local", network_access: "disabled" },
      budget: {
        max_wall_time_ms: 10,
        max_tokens: null,
        max_cost_usd: null,
        max_human_review_minutes: null
      },
      allowed_task_types: ["statistical_analysis"],
      expected_task_types: ["statistical_analysis"],
      hard_checks: [{ id: "answer-present", description: "A synthetic answer is present." }]
    }
  };
}

function successfulOutput(manifest: BenchmarkManifest): BenchmarkAdapterOutput {
  return {
    status: "success",
    observed_task_types: [...manifest.expected_task_types],
    hard_checks: manifest.hard_checks.map((check) => ({ id: check.id, passed: true })),
    artifacts: ["answer.md"],
    evidence: ["answer-evidence"],
    usage: { token_count: null, cost_usd: null },
    output_text: "A synthetic answer was produced."
  };
}

function deterministicClock() {
  return {
    async measure<T>(operation: () => Promise<T>): Promise<{ value: T; duration_ms: number }> {
      try {
        return { value: await operation(), duration_ms: 1 };
      } catch (error) {
        if (error && typeof error === "object") Object.assign(error, { benchmark_duration_ms: 1 });
        throw error;
      }
    }
  };
}

function adapterFor(manifest: BenchmarkManifest, variant: BenchmarkVariant, run: BenchmarkAdapter["run"]): BenchmarkAdapter {
  return {
    id: variant === "agent" ? manifest.runtime.agent_adapter_id : manifest.runtime.one_shot_adapter_id,
    variant,
    run
  };
}

async function runFailure(
  caseRoot: string,
  manifest: BenchmarkManifest,
  mode: FailureMode,
  variant: BenchmarkVariant = "agent"
): Promise<BenchmarkResult> {
  const run: BenchmarkAdapter["run"] = mode === "throw"
    ? async () => { throw new Error("adapter secret=TOP-SECRET /home/private/reference.txt"); }
    : mode === "timeout"
      ? async () => new Promise(() => undefined)
      : async () => ({
        ...successfulOutput(manifest),
        error: { class: "InvalidSecretError", message: "token=TOP-SECRET /home/private/reference.txt" }
      });
  return runBenchmarkCase({
    case_root: caseRoot,
    manifest,
    adapter: adapterFor(manifest, variant, run),
    identity: { commit: "commit-finalization-v1", environment: "node-test-v1" },
    ...(mode === "timeout" ? {} : { clock: deterministicClock() })
  });
}

describe("benchmark scoring finalization", () => {
  it("binds a throwing agent and successful one-shot baseline to the same final reference contract", async () => {
    const { caseRoot, manifest } = await createCase();
    const agentResult = await runFailure(caseRoot, manifest, "throw", "agent");
    const baselineResult = await runBenchmarkCase({
      case_root: caseRoot,
      manifest,
      adapter: adapterFor(manifest, "one_shot", async () => successfulOutput(manifest)),
      identity: { commit: "commit-finalization-v1", environment: "node-test-v1" },
      clock: deterministicClock()
    });

    expect(agentResult.outcome).toBe("hard_error");
    expect(baselineResult.outcome).toBe("completed");
    expect(agentResult.evaluation_contract_sha256).toBe(baselineResult.evaluation_contract_sha256);

    const report = aggregateBenchmarkResults([agentResult, baselineResult]);
    expect(report.summary).toMatchObject({ total_runs: 2, completed_runs: 1, hard_error_runs: 1 });
  });

  it.each(["throw", "timeout", "invalid_output"] as const)(
    "changes the %s failure evaluation digest and run id when scoring reference bytes change",
    async (mode) => {
      const { caseRoot, manifest, referencePath } = await createCase();
      const alpha = await runFailure(caseRoot, manifest, mode);
      await writeFile(referencePath, `${BETA_REFERENCE}\n`, "utf8");
      const beta = await runFailure(caseRoot, manifest, mode);

      expect(alpha.outcome).toBe("hard_error");
      expect(beta.outcome).toBe("hard_error");
      expect(alpha.evaluation_contract_sha256).not.toBe(beta.evaluation_contract_sha256);
      expect(alpha.run_id).not.toBe(beta.run_id);
    }
  );

  it.each(["success", "throw", "timeout", "invalid_output"] as const)(
    "loads the %s reference state only after its adapter execution window",
    async (mode) => {
      const { caseRoot, manifest, referencePath } = await createCase();
      const alpha = mode === "success"
        ? await runBenchmarkCase({
          case_root: caseRoot,
          manifest,
          adapter: adapterFor(manifest, "agent", async () => successfulOutput(manifest)),
          identity: { commit: "commit-finalization-v1", environment: "node-test-v1" },
          clock: deterministicClock()
        })
        : await runFailure(caseRoot, manifest, mode);
      const run: BenchmarkAdapter["run"] = async () => {
        await writeFile(referencePath, `${BETA_REFERENCE}\n`, "utf8");
        if (mode === "throw") throw new Error("adapter secret=TOP-SECRET");
        if (mode === "timeout") return new Promise(() => undefined);
        if (mode === "invalid_output") {
          return { ...successfulOutput(manifest), error: { class: "InvalidSecretError", message: "token=TOP-SECRET" } };
        }
        return successfulOutput(manifest);
      };
      const beta = await runBenchmarkCase({
        case_root: caseRoot,
        manifest,
        adapter: adapterFor(manifest, "agent", run),
        identity: { commit: "commit-finalization-v1", environment: "node-test-v1" },
        ...(mode === "timeout" ? {} : { clock: deterministicClock() })
      });

      expect(beta.outcome).toBe(mode === "success" ? "completed" : "hard_error");
      expect(beta.evaluation_contract_sha256).not.toBe(alpha.evaluation_contract_sha256);
      expect(beta.run_id).not.toBe(alpha.run_id);
      const serialized = JSON.stringify(beta);
      expect(serialized).not.toContain(ALPHA_REFERENCE);
      expect(serialized).not.toContain(BETA_REFERENCE);
      expect(serialized).not.toContain("TOP-SECRET");
    }
  );

  it.each(["delete", "not_regular", "digest_mismatch"] as const)(
    "records a safe structured harness failure when an included reference suffers %s after adapter start",
    async (mutation: ReferenceMutation) => {
      const { caseRoot, manifest, referencePath } = await createCase();
      if (mutation === "digest_mismatch") {
        manifest.reference_policy.sha256 = sha256(`${ALPHA_REFERENCE}\n`);
      }
      const availableFailure = await runFailure(caseRoot, manifest, "throw");
      const mutatedFailure = await runBenchmarkCase({
        case_root: caseRoot,
        manifest,
        adapter: adapterFor(manifest, "agent", async () => {
          if (mutation === "delete") {
            await rm(referencePath);
          } else if (mutation === "not_regular") {
            await rm(referencePath);
            await mkdir(referencePath);
          } else {
            await writeFile(referencePath, `${BETA_REFERENCE}\n`, "utf8");
          }
          throw new Error(`adapter secret=TOP-SECRET path=${caseRoot}`);
        }),
        identity: { commit: "commit-finalization-v1", environment: "node-test-v1" },
        clock: deterministicClock()
      });

      expect(mutatedFailure.outcome).toBe("hard_error");
      expect(mutatedFailure.error?.class).toBe("ReferenceScoringError");
      expect(mutatedFailure.evaluation_contract_sha256).not.toBe(availableFailure.evaluation_contract_sha256);
      expect(mutatedFailure.run_id).not.toBe(availableFailure.run_id);
      expect(mutatedFailure.metrics.reference_leak_check).toMatchObject({ status: "unavailable", value: null });
      expect(mutatedFailure.error?.class).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
      expect(mutatedFailure.error?.message).toMatch(/^failure:[a-f0-9]{12}$/);
      const serialized = JSON.stringify(mutatedFailure);
      expect(serialized).not.toContain(caseRoot);
      expect(serialized).not.toContain("TOP-SECRET");
      expect(serialized).not.toContain(ALPHA_REFERENCE);
      expect(serialized).not.toContain(BETA_REFERENCE);
    }
  );

  it("loads a user-supplied reference that appears only after the adapter starts", async () => {
    const { caseRoot, manifest, referencePath } = await createCase();
    await rm(referencePath);
    manifest.reference_policy.availability = "user_supplied";

    const result = await runBenchmarkCase({
      case_root: caseRoot,
      manifest,
      adapter: adapterFor(manifest, "agent", async (context) => {
        expect(JSON.stringify(context)).not.toContain("reference/reference.txt");
        await writeFile(referencePath, `${ALPHA_REFERENCE}\n`, "utf8");
        return successfulOutput(manifest);
      }),
      identity: { commit: "commit-finalization-v1", environment: "node-test-v1" },
      clock: deterministicClock()
    });

    expect(result.outcome).toBe("completed");
    expect(result.metrics.reference_leak_check).toMatchObject({ status: "measured", value: true });
  });

  it("binds a user-supplied reference that disappears after the adapter starts to its unavailable final state", async () => {
    const { caseRoot, manifest, referencePath } = await createCase();
    manifest.reference_policy.availability = "user_supplied";
    const available = await runBenchmarkCase({
      case_root: caseRoot,
      manifest,
      adapter: adapterFor(manifest, "agent", async () => successfulOutput(manifest)),
      identity: { commit: "commit-finalization-v1", environment: "node-test-v1" },
      clock: deterministicClock()
    });
    const missing = await runBenchmarkCase({
      case_root: caseRoot,
      manifest,
      adapter: adapterFor(manifest, "agent", async () => {
        await rm(referencePath);
        return successfulOutput(manifest);
      }),
      identity: { commit: "commit-finalization-v1", environment: "node-test-v1" },
      clock: deterministicClock()
    });

    expect(available.outcome).toBe("completed");
    expect(missing.outcome).toBe("incomplete");
    expect(missing.metrics.completion).toMatchObject({ status: "measured", value: false });
    expect(missing.metrics.reference_leak_check).toMatchObject({
      status: "unavailable",
      value: null,
      reason: "user_supplied_reference_missing"
    });
    expect(missing.evaluation_contract_sha256).not.toBe(available.evaluation_contract_sha256);
    expect(missing.run_id).not.toBe(available.run_id);
  });

  it("records a fixed read-failed scoring contract without exposing a protected included reference", async () => {
    const { caseRoot, manifest, referencePath } = await createCase();
    const available = await runFailure(caseRoot, manifest, "throw");
    try {
      const unreadable = await runBenchmarkCase({
        case_root: caseRoot,
        manifest,
        adapter: adapterFor(manifest, "agent", async () => {
          await chmod(referencePath, 0);
          throw new Error("adapter secret=TOP-SECRET");
        }),
        identity: { commit: "commit-finalization-v1", environment: "node-test-v1" },
        clock: deterministicClock()
      });

      expect(unreadable.outcome).toBe("hard_error");
      expect(unreadable.error?.class).toBe("ReferenceScoringError");
      expect(unreadable.metrics.reference_leak_check).toMatchObject({
        status: "unavailable",
        value: null,
        reason: "reference_read_failed"
      });
      expect(unreadable.evaluation_contract_sha256).not.toBe(available.evaluation_contract_sha256);
      expect(unreadable.run_id).not.toBe(available.run_id);
      const serialized = JSON.stringify(unreadable);
      expect(serialized).not.toContain(caseRoot);
      expect(serialized).not.toContain(ALPHA_REFERENCE);
      expect(serialized).not.toContain("TOP-SECRET");
    } finally {
      await chmod(referencePath, 0o600);
    }
  });

  it("reads an included reference only after a wall-time timeout without waiting for the adapter to settle", async () => {
    const { caseRoot, manifest, referencePath } = await createCase();
    const availableTimeout = await runFailure(caseRoot, manifest, "timeout");
    await writeFile(referencePath, `${ALPHA_REFERENCE}\n`, "utf8");

    const missingTimeout = await runBenchmarkCase({
      case_root: caseRoot,
      manifest,
      adapter: adapterFor(manifest, "agent", async (context) => {
        expect(JSON.stringify(context)).not.toContain("reference/reference.txt");
        await rm(referencePath);
        return new Promise(() => undefined);
      }),
      identity: { commit: "commit-finalization-v1", environment: "node-test-v1" }
    });

    expect(missingTimeout.outcome).toBe("hard_error");
    expect(missingTimeout.error?.class).toBe("ReferenceScoringError");
    expect(missingTimeout.evaluation_contract_sha256).not.toBe(availableTimeout.evaluation_contract_sha256);
    expect(missingTimeout.run_id).not.toBe(availableTimeout.run_id);
  });

  it("binds a post-adapter package-alias failure to its final reference bytes without exposing them", async () => {
    const { caseRoot, manifest, referencePath } = await createCase();
    const packagePath = resolve(caseRoot, "package/problem.md");

    async function runPackageAlias(bytes: string): Promise<BenchmarkResult> {
      await writeFile(packagePath, "Solve the synthetic finalization case.\n", "utf8");
      await rm(referencePath, { force: true });
      await writeFile(referencePath, `${ALPHA_REFERENCE}\n`, "utf8");
      return runBenchmarkCase({
        case_root: caseRoot,
        manifest,
        adapter: adapterFor(manifest, "agent", async () => {
          await writeFile(packagePath, `${bytes}\n`, "utf8");
          await rm(referencePath);
          await link(packagePath, referencePath);
          throw new Error(`adapter secret=TOP-SECRET path=${caseRoot}`);
        }),
        identity: { commit: "commit-finalization-v1", environment: "node-test-v1" },
        clock: deterministicClock()
      });
    }

    const alpha = await runPackageAlias(ALPHA_REFERENCE);
    const beta = await runPackageAlias(BETA_REFERENCE);

    for (const result of [alpha, beta]) {
      expect(result.outcome).toBe("hard_error");
      expect(result.error?.class).toBe("ReferenceScoringError");
      expect(result.metrics.reference_leak_check).toMatchObject({
        status: "unavailable",
        value: null,
        reason: "reference_package_overlap"
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(caseRoot);
      expect(serialized).not.toContain("TOP-SECRET");
      expect(serialized).not.toContain(ALPHA_REFERENCE);
      expect(serialized).not.toContain(BETA_REFERENCE);
    }
    expect(alpha.frozen_case_sha256).toBe(beta.frozen_case_sha256);
    expect(alpha.evaluation_contract_sha256).not.toBe(beta.evaluation_contract_sha256);
    expect(alpha.run_id).not.toBe(beta.run_id);
  });
});
