import type { TaskType } from "../contracts/types.js";

export const BENCHMARK_SCHEMA_VERSION = "1.0.0" as const;
export type BenchmarkSchemaVersion = typeof BENCHMARK_SCHEMA_VERSION;
export type BenchmarkVariant = "agent" | "one_shot";
export type BenchmarkState = "measured" | "not_run" | "blocked";
export type BenchmarkOutcome = "completed" | "incomplete" | "hard_error" | "blocked_policy" | "not_run";
export type MetricStatus = "measured" | "unavailable" | "not_run" | "blocked";
export type MetricValue = boolean | number | string;

export interface BenchmarkLicense {
  name: string;
  spdx_id: string | null;
  copyright_holder: string;
  source_url: string | null;
  redistribution: "permitted" | "user_supplied_only" | "metadata_only";
  notice_path: string | null;
}

export interface BenchmarkBlindPolicy {
  mode: "blind";
  solve_input: "package_only";
  same_problem_answers: "block";
  minimum_reference_match_characters: number;
}

export interface BenchmarkReferencePolicy {
  access: "scoring_only";
  availability: "included" | "user_supplied" | "unavailable";
  relative_path: string | null;
  sha256: string | null;
}

export interface BenchmarkBudget {
  max_wall_time_ms: number;
  max_tokens: number | null;
  max_cost_usd: number | null;
  max_human_review_minutes: number | null;
}

export interface BenchmarkHardCheckDefinition {
  id: string;
  description: string;
}

export interface BenchmarkManifest {
  schema_version: BenchmarkSchemaVersion;
  case_id: string;
  package_path: string;
  license: BenchmarkLicense;
  blind_policy: BenchmarkBlindPolicy;
  reference_policy: BenchmarkReferencePolicy;
  runtime: {
    agent_adapter_id: string;
    one_shot_adapter_id: string;
  };
  execution: {
    kind: "local" | "docker";
    network_access: "disabled" | "research_gateway_only";
  };
  budget: BenchmarkBudget;
  allowed_task_types: TaskType[];
  expected_task_types: TaskType[];
  hard_checks: BenchmarkHardCheckDefinition[];
}

export interface BenchmarkPackageFile {
  relative_path: string;
  media_type: string;
  sha256: string;
  content: string;
}

export interface BenchmarkSolveContext {
  case_id: string;
  variant: BenchmarkVariant;
  frozen_case_sha256: string;
  package_files: readonly BenchmarkPackageFile[];
  budget: Readonly<BenchmarkBudget>;
  expected_task_types: readonly TaskType[];
  hard_checks: readonly BenchmarkHardCheckDefinition[];
}

export interface BenchmarkAdapterOutput {
  status: "success" | "failed";
  observed_task_types: TaskType[];
  hard_checks: Array<{ id: string; passed: boolean; note?: string }>;
  artifacts: string[];
  evidence: string[];
  usage: {
    token_count: number | null;
    cost_usd: number | null;
  };
  output_text: string;
  error?: {
    class: string;
    message: string;
  };
}

export interface BenchmarkAdapter {
  id: string;
  variant: BenchmarkVariant;
  run(context: Readonly<BenchmarkSolveContext>): Promise<BenchmarkAdapterOutput>;
}

export interface BenchmarkClock {
  measure<T>(operation: () => Promise<T>): Promise<{ value: T; duration_ms: number }>;
}

export interface BenchmarkIdentity {
  commit: string;
  environment: string;
}

export interface MeasuredMetric<T extends MetricValue> {
  status: "measured";
  value: T;
  source: string;
}

export interface UnavailableMetric {
  status: "unavailable";
  value: null;
  reason: string;
}

export interface NotRunMetric {
  status: "not_run";
  value: null;
  reason: string;
}

export interface BlockedMetric {
  status: "blocked";
  value: null;
  reason: string;
}

export type BenchmarkMetric<T extends MetricValue> = MeasuredMetric<T> | UnavailableMetric | NotRunMetric | BlockedMetric;

export interface BenchmarkMetrics {
  completion: BenchmarkMetric<boolean>;
  hard_error: BenchmarkMetric<boolean>;
  wall_time_ms: BenchmarkMetric<number>;
  task_type_coverage: BenchmarkMetric<number>;
  custom_experiment_present: BenchmarkMetric<boolean>;
  token_count: BenchmarkMetric<number>;
  cost_usd: BenchmarkMetric<number>;
  human_review_minutes: BenchmarkMetric<number>;
  human_review_notes: BenchmarkMetric<string>;
  artifact_count: BenchmarkMetric<number>;
  evidence_count: BenchmarkMetric<number>;
  commit_identity: BenchmarkMetric<string>;
  environment_identity: BenchmarkMetric<string>;
}

export interface BenchmarkHardCheckResult {
  id: string;
  status: "passed" | "failed" | "blocked" | "not_run";
  note?: string;
}

export interface BenchmarkPolicyEvent {
  type: "same_problem_answer_detected";
  action: "blocked";
  fingerprint: string;
}

export interface BenchmarkResult {
  schema_version: BenchmarkSchemaVersion;
  case_id: string;
  variant: BenchmarkVariant;
  adapter_id: string;
  run_id: string;
  frozen_case_sha256: string;
  state: BenchmarkState;
  outcome: BenchmarkOutcome;
  observed_task_types: TaskType[];
  hard_checks: BenchmarkHardCheckResult[];
  policy_events: BenchmarkPolicyEvent[];
  error: { class: string; message: string; fingerprint?: string } | null;
  metrics: BenchmarkMetrics;
}

export interface BenchmarkMetricAggregate {
  measured_count: number;
  unavailable_count: number;
  not_run_count: number;
  blocked_count: number;
  values: MetricValue[];
}

export interface BenchmarkAggregateReport {
  schema_version: BenchmarkSchemaVersion;
  report_kind: "benchmark_aggregate";
  suite_id: string;
  summary: {
    total_runs: number;
    measured_runs: number;
    completed_runs: number;
    hard_error_runs: number;
    blocked_runs: number;
    not_run_runs: number;
  };
  metrics: Record<keyof BenchmarkMetrics, BenchmarkMetricAggregate>;
  results: BenchmarkResult[];
}
