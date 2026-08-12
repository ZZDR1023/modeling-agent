import type { CoverageIssue, CoverageReport, ProblemSpec, TaskGraph, TaskNode } from "../contracts/types.js";
import { TASK_TYPES } from "../contracts/types.js";

export class TaskGraphValidationError extends Error {
  readonly issues: CoverageIssue[];

  constructor(issues: CoverageIssue[]) {
    super(`Task graph rejected: ${issues.map((issue) => issue.message).join("; ")}`);
    this.name = "TaskGraphValidationError";
    this.issues = issues;
  }
}

export function reviewTaskGraph(problem: ProblemSpec, graph: TaskGraph): CoverageReport {
  const issues: CoverageIssue[] = [];
  const nodeIds = new Set<string>();
  const knownRequirements = new Set(problem.requirements.map((requirement) => requirement.id));
  const requiredRequirements = new Set(
    problem.requirements.filter((requirement) => requirement.required).map((requirement) => requirement.id)
  );
  const coveredRequirements = new Set<string>();

  if (graph.problem_id !== problem.problem_id) {
    issues.push({ severity: "error", message: "Task graph problem_id does not match the frozen problem spec." });
  }

  for (const node of graph.nodes) {
    if (nodeIds.has(node.id)) {
      issues.push({ severity: "error", message: `Duplicate task id: ${node.id}.` });
    }
    nodeIds.add(node.id);
    if (!TASK_TYPES.includes(node.task_type)) {
      issues.push({ severity: "error", message: `Unregistered task type on ${node.id}: ${String(node.task_type)}.` });
    }
    if (node.requirement_ids.length === 0) {
      issues.push({ severity: "error", message: `${node.id} does not cover a requirement.` });
    }
    const pluginIssues = pluginIssuesFor(node);
    for (const message of pluginIssues) issues.push({ severity: "error", message: `${node.id}: ${message}` });
    for (const requirementId of node.requirement_ids) {
      if (!knownRequirements.has(requirementId)) {
        issues.push({ severity: "error", message: `${node.id} references unknown requirement ${requirementId}.` });
      } else {
        coveredRequirements.add(requirementId);
      }
    }
  }

  for (const node of graph.nodes) {
    for (const dependency of node.depends_on) {
      if (!nodeIds.has(dependency)) {
        issues.push({ severity: "error", message: `${node.id} depends on missing task ${dependency}.` });
      }
      if (dependency === node.id) {
        issues.push({ severity: "error", message: `${node.id} cannot depend on itself.` });
      }
    }
  }

  try {
    topologicalOrder(graph.nodes);
  } catch (error) {
    issues.push({ severity: "error", message: error instanceof Error ? error.message : String(error) });
  }

  const missingRequirementIds = [...requiredRequirements].filter((id) => !coveredRequirements.has(id)).sort();
  for (const requirementId of missingRequirementIds) {
    issues.push({ severity: "error", message: `Required item ${requirementId} is not covered by any task.` });
  }

  for (const node of graph.nodes) {
    if (node.task_type === "custom_experiment" && node.evidence_level !== "experimental") {
      issues.push({ severity: "error", message: `${node.id} uses custom_experiment but is not marked experimental.` });
    }
  }

  return {
    schema_version: "1.0.0",
    approved: !issues.some((issue) => issue.severity === "error"),
    covered_requirement_ids: [...coveredRequirements].sort(),
    missing_requirement_ids: missingRequirementIds,
    issues
  };
}

export function assertTaskGraphApproved(problem: ProblemSpec, graph: TaskGraph): CoverageReport {
  const report = reviewTaskGraph(problem, graph);
  if (!report.approved) {
    throw new TaskGraphValidationError(report.issues);
  }
  return report;
}

export function topologicalOrder(nodes: TaskNode[]): TaskNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map(nodes.map((node) => [node.id, new Set(node.depends_on)]));
  const ready = nodes.filter((node) => node.depends_on.length === 0).map((node) => node.id).sort();
  const ordered: TaskNode[] = [];

  while (ready.length > 0) {
    const id = ready.shift();
    if (!id) break;
    const node = byId.get(id);
    if (!node) throw new Error(`Task ${id} disappeared during graph traversal.`);
    ordered.push(node);

    for (const [candidateId, dependencies] of incoming) {
      if (dependencies.delete(id) && dependencies.size === 0 && !ordered.some((item) => item.id === candidateId)) {
        if (!ready.includes(candidateId)) ready.push(candidateId);
        ready.sort();
      }
    }
  }

  if (ordered.length !== nodes.length) {
    const cyclic = nodes.filter((node) => !ordered.some((item) => item.id === node.id)).map((node) => node.id);
    throw new Error(`Task graph contains a cycle involving: ${cyclic.join(", ")}.`);
  }
  return ordered;
}

function pluginIssuesFor(node: TaskNode): string[] {
  if (node.task_type === "regression_prediction" || node.task_type === "time_series_forecasting" || node.task_type === "classification") {
    return node.config.target_column === undefined ? [`${node.task_type} requires target_column.`] : [];
  }
  if (node.task_type === "optimization") {
    return node.config.objective === undefined ? ["optimization requires objective."] : [];
  }
  if (node.task_type === "custom_experiment") {
    return node.config.operation === undefined && node.config.script_path === undefined
      ? ["custom_experiment requires operation or script_path."]
      : [];
  }
  return [];
}
