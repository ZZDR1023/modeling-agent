import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { EvidenceGraph, ExperimentResult, ProblemSpec, TaskGraph } from "../src/contracts/types.js";
import { ReportBuilder } from "../src/report/report-builder.js";

const problem: ProblemSpec = {
  schema_version: "1.0.0",
  problem_id: "problem-report",
  title: "Evidence report",
  summary: "A report rendering contract test.",
  language: "en",
  requirements: [{ id: "req-001", kind: "question", text: "Report the metric.", required: true, source_excerpt: "Report the metric." }],
  data_assets: [],
  external_data_policy: "forbidden"
};

const graph: TaskGraph = {
  schema_version: "1.0.0",
  workflow_version: "0.1.0",
  problem_id: problem.problem_id,
  nodes: [{
    id: "task-001",
    title: "Metric task",
    task_type: "statistical_analysis",
    objective: "Produce a metric.",
    requirement_ids: ["req-001"],
    depends_on: [],
    input_artifact_ids: [],
    evidence_level: "standard",
    budget: { max_attempts: 1, max_runtime_seconds: 60, max_tokens: 1000 },
    config: {}
  }]
};

const taskResult: ExperimentResult = {
  schema_version: "1.0.0",
  run_id: "run-report",
  attempt_id: "task-001-attempt-001",
  task_id: "task-001",
  plugin_id: "statistical_analysis",
  status: "success",
  selected_method: "descriptive_statistics",
  method_results: [{ method: "descriptive_statistics", status: "success", metrics: { score: 111 }, hard_checks_passed: true, warnings: [] }],
  metrics: { score: 111 },
  warnings: [],
  artifacts: [
    { kind: "figure", relative_path: "experiments/task-001/task-001-attempt-001/figures/score.png", media_type: "image/png", sha256: "a".repeat(64), size_bytes: 3 },
    { kind: "table", relative_path: "experiments/task-001/task-001-attempt-001/tables/score.csv", media_type: "text/csv", sha256: "b".repeat(64), size_bytes: 3 }
  ],
  runtime: { started_at: "2024-01-01T00:00:00Z", finished_at: "2024-01-01T00:00:01Z", duration_ms: 1000, python_version: "3.11" }
};

const evidence: EvidenceGraph = {
  schema_version: "1.0.0",
  run_id: "run-report",
  nodes: [
    { id: "evidence-1111111111111111", kind: "claim", label: "task-001 statistical_analysis status", source_artifact_id: "artifact-status", value: "success", created_at: "2024-01-01T00:00:00Z" },
    { id: "evidence-2222222222222222", kind: "metric", label: "task-001.score", source_artifact_id: "artifact-table", value: 222, created_at: "2024-01-01T00:00:00Z" },
    { id: "evidence-3333333333333333", kind: "figure", label: "task-001: experiments/task-001/task-001-attempt-001/figures/score.png", source_artifact_id: "artifact-figure", value: "experiments/task-001/task-001-attempt-001/figures/score.png", created_at: "2024-01-01T00:00:00Z" },
    { id: "evidence-4444444444444444", kind: "table", label: "task-001: experiments/task-001/task-001-attempt-001/tables/score.csv", source_artifact_id: "artifact-table", value: "experiments/task-001/task-001-attempt-001/tables/score.csv", created_at: "2024-01-01T00:00:00Z" }
  ],
  edges: [
    { from: "evidence-2222222222222222", to: "evidence-1111111111111111", relation: "supports" },
    { from: "evidence-3333333333333333", to: "evidence-1111111111111111", relation: "visualizes" },
    { from: "evidence-4444444444444444", to: "evidence-1111111111111111", relation: "derived_from" }
  ]
};

describe("ReportBuilder evidence channel", () => {
  it("renders exact metrics and artifact references from the Evidence Graph, not raw task results", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "modeling-report-"));
    const input = resolve(root, "input.csv");
    const committed = resolve(root, "committed");
    const pythonSource = resolve(root, "python");
    await writeFile(input, "value\n1\n", "utf8");
    await writeFile(resolve(root, "requirements.lock"), "numpy==2.2.6\n", "utf8");
    await writeFile(resolve(root, "Dockerfile"), "FROM python:3.11-slim\n", "utf8");
    const attempt = resolve(committed, "task-001", "task-001-attempt-001");
    await import("node:fs/promises").then(({ mkdir }) => Promise.all([mkdir(attempt, { recursive: true }), mkdir(pythonSource)]));
    await writeFile(resolve(attempt, "experiment-request.json"), `${JSON.stringify({ schema_version: "1.0.0", run_id: "run-report", attempt_id: "task-001-attempt-001", task: graph.nodes[0], evaluation_contract: {}, data_files: [{ relative_path: "input.csv" }], output_dir: "/tmp/original", random_seed: 1 }, null, 2)}\n`, "utf8");
    await writeFile(resolve(attempt, "experiment-result.json"), `${JSON.stringify(taskResult, null, 2)}\n`, "utf8");

    const report = await new ReportBuilder().build({
      runId: "run-report",
      projectRoot: resolve(root, "project"),
      reproduction: { runtimeKind: "fake", executionKind: "local" },
      problem,
      graph,
      evaluationContracts: {},
      taskResults: [taskResult],
      evidence,
      inputFiles: [{ source: input, relativePath: "input.csv" }],
      committedExperimentsRoot: committed,
      pythonSourceRoot: pythonSource,
      pythonRequirementsPath: resolve(root, "requirements.lock"),
      pythonDockerfilePath: resolve(root, "Dockerfile"),
      pythonVersion: "3.10.12"
    });
    const markdown = await readFile(report.reportMarkdown, "utf8");
    expect(markdown).toContain("score: 222 (`evidence-2222222222222222`)");
    expect(markdown).not.toContain("score: 111");
    expect(markdown).toContain("evidence-3333333333333333");
    expect(markdown).toContain("evidence-4444444444444444");

    const projectReadme = await readFile(resolve(report.projectRoot, "README.md"), "utf8");
    expect(projectReadme).toContain("The frozen experiment records were originally produced and verified with Python 3.10.12.");
    expect(projectReadme).toContain("a Python environment compatible with the packaged `requirements.lock`");
    expect(projectReadme).toContain("the packaged Dockerfile's fixed environment");
    expect(projectReadme).not.toContain("Python 3.10.12 is required");
    expect(projectReadme).not.toContain("compatible Python 3.11 environment");
    expect(projectReadme).toContain("pip install -r reproducibility/environment/requirements.lock");
    expect(projectReadme.match(/python3 reproduce\.py/g)).toHaveLength(1);
    expect(projectReadme).toContain("docker build -f reproducibility/environment/Dockerfile -t modeling-project-reproducer .");
    expect(projectReadme).toContain("mkdir -p reproduced");
    expect(projectReadme).toContain("--user \"$(id -u):$(id -g)\"");
    expect(projectReadme).toContain("--mount type=bind,src=\"$(pwd)/reproduced\",dst=/opt/modeling-project/reproduced");
    expect(projectReadme).toContain("The bind mount keeps reproduced outputs on the host after the ephemeral container exits.");
    expect(projectReadme).toContain("Linux");
    expect(projectReadme).not.toContain("run-report");
    expect(projectReadme).not.toContain(root);
  });
});
