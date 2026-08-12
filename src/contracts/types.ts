export const TASK_TYPES = [
  "statistical_analysis",
  "regression_prediction",
  "time_series_forecasting",
  "classification",
  "clustering",
  "evaluation_ranking",
  "optimization",
  "simulation",
  "custom_experiment"
] as const;

export type TaskType = (typeof TASK_TYPES)[number];
export type EvidenceLevel = "standard" | "experimental";

export interface DataAsset {
  artifact_id: string;
  relative_path: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
}

export interface ProblemRequirement {
  id: string;
  kind: "question" | "constraint" | "deliverable";
  text: string;
  required: boolean;
  source_excerpt: string;
}

export interface ProblemSpec {
  schema_version: "1.0.0";
  problem_id: string;
  title: string;
  summary: string;
  language: "zh" | "en" | "mixed" | "unknown";
  requirements: ProblemRequirement[];
  data_assets: DataAsset[];
  external_data_policy: "forbidden" | "required_pending_approval" | "approved";
}

export interface TaskBudget {
  max_attempts: number;
  max_runtime_seconds: number;
  max_tokens: number;
}

export interface TaskNode {
  id: string;
  title: string;
  task_type: TaskType;
  objective: string;
  requirement_ids: string[];
  depends_on: string[];
  input_artifact_ids: string[];
  evidence_level: EvidenceLevel;
  budget: TaskBudget;
  config: Record<string, unknown>;
}

export interface TaskGraph {
  schema_version: "1.0.0";
  workflow_version: "0.1.0";
  problem_id: string;
  nodes: TaskNode[];
}

export interface CoverageIssue {
  severity: "warning" | "error";
  message: string;
}

export interface CoverageReport {
  schema_version: "1.0.0";
  approved: boolean;
  covered_requirement_ids: string[];
  missing_requirement_ids: string[];
  issues: CoverageIssue[];
}

export interface EvaluationMetric {
  name: string;
  direction: "minimize" | "maximize" | "target" | "diagnostic";
  role: "primary" | "secondary" | "diagnostic";
}

export interface EvaluationContract {
  schema_version: "1.0.0";
  contract_id: string;
  task_id: string;
  task_type: string;
  primary_objective: string;
  metrics: EvaluationMetric[];
  hard_checks: string[];
  selection_rule: string;
  frozen_at: string;
}

export interface ExperimentDataFile extends DataAsset {
  absolute_path: string;
}

export interface ExperimentRequest {
  schema_version: "1.0.0";
  run_id: string;
  attempt_id: string;
  task: TaskNode;
  evaluation_contract: EvaluationContract;
  data_files: ExperimentDataFile[];
  output_dir: string;
  random_seed: number;
  task_config?: Record<string, unknown>;
}

export interface ProducedArtifact {
  kind: "data" | "figure" | "table" | "model" | "log" | "code" | "other";
  relative_path: string;
  media_type: string;
  sha256: string;
  size_bytes: number;
}

export interface MethodResult {
  method: string;
  status: "success" | "failed" | "ineligible";
  metrics: Record<string, number | string | boolean | null>;
  hard_checks_passed: boolean;
  warnings: string[];
}

export interface ExperimentResult {
  schema_version: "1.0.0";
  run_id: string;
  attempt_id: string;
  task_id: string;
  plugin_id: string;
  status: "success" | "failed" | "unsupported";
  selected_method?: string;
  method_results: MethodResult[];
  metrics: Record<string, number | string | boolean | null>;
  warnings: string[];
  artifacts: ProducedArtifact[];
  runtime: {
    started_at: string;
    finished_at: string;
    duration_ms: number;
    python_version: string;
  };
  error?: {
    class: string;
    message: string;
    fingerprint?: string;
  };
}

export interface EvidenceNode {
  id: string;
  kind: "metric" | "figure" | "table" | "claim" | "assumption" | "limitation" | "citation";
  label: string;
  source_artifact_id: string;
  value: number | string | boolean | null;
  unit?: string;
  created_at: string;
}

export interface EvidenceEdge {
  from: string;
  to: string;
  relation: "supports" | "derived_from" | "visualizes" | "limits" | "depends_on";
}

export interface EvidenceGraph {
  schema_version: "1.0.0";
  run_id: string;
  nodes: EvidenceNode[];
  edges: EvidenceEdge[];
}

export type RunStatus =
  | "queued"
  | "running"
  | "blocked"
  | "completed"
  | "completed_with_warnings"
  | "budget_exhausted"
  | "failed"
  | "cancelled";

export interface RunSummary {
  id: string;
  package_path: string;
  workspace_path: string;
  runtime_kind: "fake" | "pi";
  execution_kind: "local" | "docker";
  status: RunStatus;
  current_stage: string;
  created_at: string;
  updated_at: string;
  error_message: string | null;
  project_archive: string | null;
}

export interface RunEvent {
  id?: number;
  run_id: string;
  stage_id?: string;
  attempt_id?: string;
  event_type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}
