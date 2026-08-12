import type { EvidenceEdge, EvidenceGraph, EvidenceNode, ExperimentResult } from "../contracts/types.js";
import { SchemaRegistry } from "../contracts/schema-registry.js";
import { sha256Text } from "../infrastructure/hash.js";

function evidenceId(...parts: string[]): string {
  return `evidence-${sha256Text(parts.join("\u0000")).slice(0, 16)}`;
}

function metricArtifact(result: ExperimentResult): string {
  const preferred = result.artifacts.find((artifact) => artifact.kind === "table" || artifact.kind === "other");
  return preferred ? `artifact-${preferred.sha256.slice(0, 16)}` : `attempt-${result.attempt_id}`;
}

export function buildEvidenceGraph(runId: string, results: ExperimentResult[], createdAt: string, schemas = new SchemaRegistry()): EvidenceGraph {
  const nodes: EvidenceNode[] = [];
  const edges: EvidenceEdge[] = [];

  for (const result of results) {
    const sourceArtifactId = metricArtifact(result);
    const taskNodeId = evidenceId(runId, result.task_id, "claim", result.status);
    nodes.push({
      id: taskNodeId,
      kind: result.status === "success" ? "claim" : "limitation",
      label: `${result.task_id} ${result.plugin_id} status`,
      source_artifact_id: sourceArtifactId,
      value: result.status,
      created_at: createdAt
    });

    for (const [name, value] of Object.entries(result.metrics).sort(([left], [right]) => left.localeCompare(right))) {
      const metricNodeId = evidenceId(runId, result.task_id, "metric", name, String(value));
      nodes.push({
        id: metricNodeId,
        kind: "metric",
        label: `${result.task_id}.${name}`,
        source_artifact_id: sourceArtifactId,
        value,
        created_at: createdAt
      });
      edges.push({ from: metricNodeId, to: taskNodeId, relation: "supports" });
    }

    for (const artifact of result.artifacts) {
      if (artifact.kind !== "figure" && artifact.kind !== "table") continue;
      const artifactNodeId = evidenceId(runId, result.task_id, artifact.kind, artifact.relative_path, artifact.sha256);
      nodes.push({
        id: artifactNodeId,
        kind: artifact.kind,
        label: `${result.task_id}: ${artifact.relative_path}`,
        source_artifact_id: `artifact-${artifact.sha256.slice(0, 16)}`,
        value: artifact.relative_path,
        created_at: createdAt
      });
      edges.push({
        from: artifactNodeId,
        to: taskNodeId,
        relation: artifact.kind === "figure" ? "visualizes" : "derived_from"
      });
    }

    for (const warning of result.warnings) {
      const warningNodeId = evidenceId(runId, result.task_id, "limitation", warning);
      nodes.push({
        id: warningNodeId,
        kind: "limitation",
        label: `${result.task_id} limitation`,
        source_artifact_id: sourceArtifactId,
        value: warning,
        created_at: createdAt
      });
      edges.push({ from: warningNodeId, to: taskNodeId, relation: "limits" });
    }
  }

  return schemas.validate<EvidenceGraph>("evidence-graph", {
    schema_version: "1.0.0",
    run_id: runId,
    nodes,
    edges
  });
}
