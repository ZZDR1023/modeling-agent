import type { EvaluationContract, EvaluationMetric, TaskNode, TaskType } from "../contracts/types.js";

export interface TaskPlugin {
  id: TaskType;
  label: string;
  methods: readonly string[];
  defaultMetrics: readonly EvaluationMetric[];
  hardChecks: readonly string[];
  evidenceRequirements: readonly string[];
  buildEvaluationContract(task: TaskNode, frozenAt: string): EvaluationContract;
  validateConfig(config: Record<string, unknown>): string[];
}

export interface PluginDefinition {
  id: TaskType;
  label: string;
  methods: readonly string[];
  metrics: readonly EvaluationMetric[];
  hardChecks: readonly string[];
  evidenceRequirements: readonly string[];
  selectionRule: string;
  requiredConfigAnyOf?: readonly string[];
}
