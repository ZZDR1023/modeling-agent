import type { EvaluationContract, TaskNode, TaskType } from "../contracts/types.js";
import type { PluginDefinition, TaskPlugin } from "./types.js";

const sharedChecks = [
  "execution_succeeded",
  "result_is_finite",
  "result_is_reproducible",
  "input_lineage_is_complete"
] as const;

const definitions: readonly PluginDefinition[] = [
  {
    id: "statistical_analysis",
    label: "Statistical analysis",
    methods: ["descriptive_statistics", "pearson_spearman", "hypothesis_tests"],
    metrics: [
      { name: "observations", direction: "diagnostic", role: "diagnostic" },
      { name: "missing_fraction", direction: "minimize", role: "secondary" }
    ],
    hardChecks: [...sharedChecks, "test_assumptions_reported", "effect_size_reported"],
    evidenceRequirements: ["summary_table", "assumption_report", "source_columns"],
    selectionRule: "Report all valid analyses; do not select tests only by favorable p-values."
  },
  {
    id: "regression_prediction",
    label: "Regression and prediction",
    methods: ["linear", "ridge", "lasso", "random_forest", "gradient_boosting"],
    metrics: [
      { name: "mae", direction: "minimize", role: "primary" },
      { name: "rmse", direction: "minimize", role: "secondary" },
      { name: "r2", direction: "maximize", role: "secondary" }
    ],
    hardChecks: [...sharedChecks, "no_data_leakage", "held_out_evaluation", "baseline_included"],
    evidenceRequirements: ["split_manifest", "candidate_metrics", "prediction_table", "residual_figure"],
    selectionRule: "Minimize held-out MAE after hard checks; prefer the simpler stable model on a practical tie.",
    requiredConfigAnyOf: ["target_column"]
  },
  {
    id: "time_series_forecasting",
    label: "Time-series forecasting",
    methods: ["naive", "seasonal_naive", "ets", "arima", "sarima"],
    metrics: [
      { name: "mae", direction: "minimize", role: "primary" },
      { name: "rmse", direction: "minimize", role: "secondary" },
      { name: "mase", direction: "minimize", role: "secondary" }
    ],
    hardChecks: [...sharedChecks, "temporal_order_preserved", "rolling_backtest", "baseline_included"],
    evidenceRequirements: ["fold_manifest", "candidate_metrics", "forecast_table", "forecast_figure"],
    selectionRule: "Minimize frozen rolling-backtest MAE; use stability and model simplicity as tie-breakers.",
    requiredConfigAnyOf: ["target_column"]
  },
  {
    id: "classification",
    label: "Classification",
    methods: ["logistic_regression", "decision_tree", "random_forest", "svm"],
    metrics: [
      { name: "f1_macro", direction: "maximize", role: "primary" },
      { name: "accuracy", direction: "maximize", role: "secondary" }
    ],
    hardChecks: [...sharedChecks, "no_data_leakage", "stratified_evaluation", "baseline_included"],
    evidenceRequirements: ["split_manifest", "confusion_matrix", "candidate_metrics"],
    selectionRule: "Maximize held-out macro F1 after hard checks; disclose class imbalance and per-class errors.",
    requiredConfigAnyOf: ["target_column"]
  },
  {
    id: "clustering",
    label: "Clustering",
    methods: ["kmeans", "agglomerative", "dbscan"],
    metrics: [
      { name: "silhouette", direction: "maximize", role: "primary" },
      { name: "cluster_count", direction: "diagnostic", role: "diagnostic" },
      { name: "stability", direction: "maximize", role: "secondary" }
    ],
    hardChecks: [...sharedChecks, "non_degenerate_partition", "scale_policy_recorded"],
    evidenceRequirements: ["cluster_assignments", "candidate_metrics", "cluster_profile"],
    selectionRule: "Retain non-degenerate stable candidates; prefer interpretable clusters when scores are comparable."
  },
  {
    id: "evaluation_ranking",
    label: "Evaluation and ranking",
    methods: ["entropy_topsis", "pca", "equal_weight_topsis"],
    metrics: [
      { name: "rank_stability", direction: "maximize", role: "primary" },
      { name: "method_agreement", direction: "maximize", role: "secondary" }
    ],
    hardChecks: [...sharedChecks, "indicator_directions_declared", "normalization_recorded", "weights_valid"],
    evidenceRequirements: ["indicator_spec", "weight_table", "ranking_table", "sensitivity_report"],
    selectionRule: "Prefer stable, valid rankings; retain alternatives when reasonable weighting choices materially disagree."
  },
  {
    id: "optimization",
    label: "Optimization",
    methods: ["linear_programming", "mixed_integer_programming", "nonlinear_programming", "pareto_search"],
    metrics: [
      { name: "objective_value", direction: "target", role: "primary" },
      { name: "max_constraint_violation", direction: "minimize", role: "secondary" }
    ],
    hardChecks: [...sharedChecks, "solver_success", "constraints_feasible", "baseline_included"],
    evidenceRequirements: ["mathematical_formulation", "solution_table", "constraint_audit", "sensitivity_report"],
    selectionRule: "Reject infeasible candidates, then compare the declared objective and sensitivity evidence.",
    requiredConfigAnyOf: ["objective"]
  },
  {
    id: "simulation",
    label: "Simulation",
    methods: ["monte_carlo", "ordinary_differential_equation", "discrete_simulation"],
    metrics: [
      { name: "estimate", direction: "target", role: "primary" },
      { name: "monte_carlo_standard_error", direction: "minimize", role: "secondary" }
    ],
    hardChecks: [...sharedChecks, "boundary_conditions_checked", "random_seed_recorded", "sensitivity_analyzed"],
    evidenceRequirements: ["parameter_spec", "simulation_summary", "sensitivity_report", "trajectory_figure"],
    selectionRule: "Use the declared simulation target; reject violations and disclose uncertainty and sensitivity."
  },
  {
    id: "custom_experiment",
    label: "Custom experimental method",
    methods: ["generated_python"],
    metrics: [{ name: "task_specific_metric", direction: "target", role: "primary" }],
    hardChecks: [...sharedChecks, "baseline_included", "falsifiable_check_present", "code_policy_passed"],
    evidenceRequirements: ["generated_code", "execution_log", "baseline_result", "limitation_statement"],
    selectionRule: "Apply the task-frozen metric and retain experimental evidence labeling throughout the report.",
    requiredConfigAnyOf: ["script_path", "operation"]
  }
] as const;

function createPlugin(definition: PluginDefinition): TaskPlugin {
  return {
    id: definition.id,
    label: definition.label,
    methods: definition.methods,
    defaultMetrics: definition.metrics,
    hardChecks: definition.hardChecks,
    evidenceRequirements: definition.evidenceRequirements,
    buildEvaluationContract(task: TaskNode, frozenAt: string): EvaluationContract {
      return {
        schema_version: "1.0.0",
        contract_id: `eval-${task.id}`,
        task_id: task.id,
        task_type: task.task_type,
        primary_objective: task.objective,
        metrics: [...definition.metrics],
        hard_checks: [...definition.hardChecks],
        selection_rule: definition.selectionRule,
        frozen_at: frozenAt
      };
    },
    validateConfig(config: Record<string, unknown>): string[] {
      const required = definition.requiredConfigAnyOf;
      if (!required || required.length === 0) return [];
      return required.some((field) => config[field] !== undefined)
        ? []
        : [`${definition.id} requires at least one of: ${required.join(", ")}.`];
    }
  };
}

export class TaskPluginRegistry {
  readonly #plugins = new Map<TaskType, TaskPlugin>();

  constructor() {
    for (const definition of definitions) {
      this.#plugins.set(definition.id, createPlugin(definition));
    }
  }

  get(type: TaskType): TaskPlugin {
    const plugin = this.#plugins.get(type);
    if (!plugin) throw new Error(`No plugin registered for ${type}.`);
    return plugin;
  }

  list(): TaskPlugin[] {
    return [...this.#plugins.values()];
  }
}
