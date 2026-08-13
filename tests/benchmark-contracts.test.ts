import { describe, expect, it } from "vitest";
import type { BenchmarkManifest, BenchmarkResult } from "../src/benchmark/types.js";
import {
  BenchmarkContractError,
  measuredMetric,
  unavailableMetric,
  validateBenchmarkManifest,
  validateBenchmarkResult
} from "../src/benchmark/contracts.js";

const manifest: BenchmarkManifest = {
  schema_version: "1.0.0",
  case_id: "synthetic-contract",
  package_path: "package",
  license: {
    name: "Apache License 2.0",
    spdx_id: "Apache-2.0",
    copyright_holder: "modeling-agent contributors",
    source_url: null,
    redistribution: "permitted",
    notice_path: "package/NOTICE.md"
  },
  blind_policy: {
    mode: "blind",
    solve_input: "package_only",
    same_problem_answers: "block",
    minimum_reference_match_characters: 48
  },
  reference_policy: {
    access: "scoring_only",
    availability: "included",
    relative_path: "reference/reference.json",
    sha256: "a".repeat(64)
  },
  runtime: {
    agent_adapter_id: "deterministic-agent-v1",
    one_shot_adapter_id: "deterministic-one-shot-v1"
  },
  execution: {
    kind: "local",
    network_access: "disabled"
  },
  budget: {
    max_wall_time_ms: 60_000,
    max_tokens: 10_000,
    max_cost_usd: null,
    max_human_review_minutes: null
  },
  allowed_task_types: ["statistical_analysis", "custom_experiment"],
  expected_task_types: ["statistical_analysis"],
  hard_checks: [{ id: "required-output", description: "The required output is present." }]
};

const result: BenchmarkResult = {
  schema_version: "1.0.0",
  case_id: manifest.case_id,
  variant: "agent",
  adapter_id: "deterministic-agent-v1",
  run_id: "synthetic-contract-agent-aaaaaaaaaaaa",
  frozen_case_sha256: "b".repeat(64),
  evaluation_contract_sha256: "c".repeat(64),
  state: "measured",
  outcome: "completed",
  observed_task_types: ["statistical_analysis"],
  hard_checks: [{ id: "required-output", status: "passed" }],
  policy_events: [],
  error: null,
  metrics: {
    completion: measuredMetric(true, "harness_scoring"),
    hard_error: measuredMetric(false, "harness_scoring"),
    wall_time_ms: measuredMetric(125, "harness_clock"),
    task_type_coverage: measuredMetric(1, "harness_scoring"),
    custom_experiment_present: measuredMetric(false, "harness_scoring"),
    token_count: unavailableMetric("adapter_did_not_report"),
    cost_usd: unavailableMetric("adapter_did_not_report"),
    human_review_minutes: unavailableMetric("not_reviewed"),
    human_review_notes: unavailableMetric("not_reviewed"),
    reference_leak_check: measuredMetric(true, "harness_leak_check"),
    artifact_count: measuredMetric(2, "adapter_inventory"),
    evidence_count: measuredMetric(3, "adapter_inventory"),
    commit_identity: measuredMetric("a".repeat(40), "git_commit"),
    environment_identity: measuredMetric("node-24-linux-x64", "runtime_environment")
  }
};

describe("benchmark contracts", () => {
  it("accepts a complete versioned manifest and rejects unsafe or inconsistent policy metadata", () => {
    expect(validateBenchmarkManifest(structuredClone(manifest))).toEqual(manifest);

    const unknownField = { ...structuredClone(manifest), unexpected: true };
    expect(() => validateBenchmarkManifest(unknownField)).toThrow(BenchmarkContractError);

    const absolutePackage = { ...structuredClone(manifest), package_path: "/home/user/private/problem" };
    expect(() => validateBenchmarkManifest(absolutePackage)).toThrow(/relative path/i);

    const inconsistentTasks = structuredClone(manifest);
    inconsistentTasks.expected_task_types = ["optimization"];
    expect(() => validateBenchmarkManifest(inconsistentTasks)).toThrow(/expected task type/i);

    const leakingPolicy = structuredClone(manifest);
    leakingPolicy.reference_policy.access = "solve_and_score" as "scoring_only";
    expect(() => validateBenchmarkManifest(leakingPolicy)).toThrow(BenchmarkContractError);

    const unsafeAdapter = structuredClone(manifest);
    unsafeAdapter.runtime.agent_adapter_id = "../../token=TOP-SECRET";
    expect(() => validateBenchmarkManifest(unsafeAdapter)).toThrow(BenchmarkContractError);
  });

  it("represents unknown token, cost, and human-review values as unavailable nulls rather than zero", () => {
    const validated = validateBenchmarkResult(structuredClone(result));
    for (const name of ["token_count", "cost_usd", "human_review_minutes", "human_review_notes"] as const) {
      expect(validated.metrics[name]).toMatchObject({ status: "unavailable", value: null });
    }

    const ambiguousUnknown = structuredClone(result) as BenchmarkResult;
    ambiguousUnknown.metrics.token_count = { status: "unavailable", value: 0, reason: "adapter_did_not_report" } as never;
    expect(() => validateBenchmarkResult(ambiguousUnknown)).toThrow(BenchmarkContractError);
  });

  it("rejects a completed result when completion, hard-error, or hard-check evidence contradicts success", () => {
    const falseCompletion = structuredClone(result);
    falseCompletion.metrics.completion = measuredMetric(false, "harness_scoring");
    expect(() => validateBenchmarkResult(falseCompletion)).toThrow(/completed result/i);

    const failedCheck = structuredClone(result);
    failedCheck.hard_checks[0]!.status = "failed";
    expect(() => validateBenchmarkResult(failedCheck)).toThrow(/completed result/i);

    const completedWithError = structuredClone(result);
    completedWithError.error = { class: "AdapterError", message: `failure:${"a".repeat(12)}`, fingerprint: "a".repeat(64) };
    expect(() => validateBenchmarkResult(completedWithError)).toThrow(/completed result/i);
  });
});
