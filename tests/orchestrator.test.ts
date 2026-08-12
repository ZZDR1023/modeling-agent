import { describe, expect, it } from "vitest";
import { access, appendFile, cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import type { ExperimentResult } from "../src/contracts/types.js";
import type { PythonWorker } from "../src/execution/python-worker.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";

const fixture = join(process.cwd(), "tests", "fixtures", "basic");

describe("fake local vertical slice", () => {
  it("runs the package through execution, evidence, report, and export", async () => {
    const root = await mkdtemp(join(tmpdir(), "modeling-run-"));
    const packageRoot = resolve(root, "package");
    await cp(fixture, packageRoot, { recursive: true });
    const orchestrator = new Orchestrator({ runsRoot: resolve(root, "runs") });
    const result = await orchestrator.run(packageRoot, { runtimeKind: "fake", executionKind: "local" });
    expect(result.status).toBe("completed");
    expect(result.workspacePath).toContain(resolve(root, "runs"));
    expect(result.projectArchive).toMatch(/project\.zip$/);
    expect(result.taskResults).toHaveLength(9);
    expect(result.taskResults.every((item) => item.status === "success")).toBe(true);
    expect(new Set(result.taskResults.map((item) => item.plugin_id))).toEqual(new Set([
      "statistical_analysis",
      "regression_prediction",
      "time_series_forecasting",
      "classification",
      "clustering",
      "evaluation_ranking",
      "optimization",
      "simulation",
      "custom_experiment"
    ]));
    expect(result.evidence.nodes.length).toBeGreaterThan(0);
    expect(result.evidence.nodes.some((node) => node.kind === "metric")).toBe(true);

    const projectRoot = resolve(dirname(result.projectArchive), "project");
    const requiredFiles = [
      "deliverables/report.md",
      "deliverables/report.tex",
      "deliverables/report.pdf",
      "reproducibility/problem-spec.json",
      "reproducibility/task-graph.json",
      "reproducibility/evaluation-contracts.json",
      "reproducibility/evidence-graph.json",
      "reproducibility/experiment-results.json",
      "reproducibility/reproduce.json"
    ];
    await Promise.all(requiredFiles.map((path) => access(resolve(projectRoot, path))));
    await access(result.projectArchive);
    expect(await readFile(resolve(projectRoot, "deliverables/report.md"), "utf8")).toContain("## Experiment Results");
    expect((await readFile(resolve(projectRoot, "deliverables/report.pdf"))).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await readFile(result.projectArchive)).subarray(0, 2).toString()).toBe("PK");
    await appendFile(resolve(packageRoot, "measurements.csv"), "2024-02-10,41,1,83,A\n", "utf8");
    const frozen = await readFile(resolve(projectRoot, "reproducibility/inputs/measurements.csv"), "utf8");
    expect(frozen).not.toContain("2024-02-10,41,1,83,A");
  }, 120_000);

  it("rejects a worker success whose artifact bytes do not match its manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "modeling-tamper-"));
    const worker: PythonWorker = {
      kind: "local",
      async execute(request): Promise<ExperimentResult> {
        const output = resolve(request.output_dir, "table.csv");
        await import("node:fs/promises").then(({ mkdir, writeFile }) => Promise.all([
          mkdir(dirname(output), { recursive: true }),
          writeFile(output, "value\\n1\\n", "utf8")
        ]));
        return new SchemaRegistry().validate<ExperimentResult>("experiment-result", {
          schema_version: "1.0.0",
          run_id: request.run_id,
          attempt_id: request.attempt_id,
          task_id: request.task.id,
          plugin_id: request.task.task_type,
          status: "success",
          selected_method: "tampered",
          method_results: [{ method: "tampered", status: "success", metrics: { metric: 1 }, hard_checks_passed: true, warnings: [] }],
          metrics: { metric: 1 },
          warnings: [],
          artifacts: [{ kind: "table", relative_path: "table.csv", media_type: "text/csv", sha256: "0".repeat(64), size_bytes: 8 }],
          runtime: { started_at: "2024-01-01T00:00:00Z", finished_at: "2024-01-01T00:00:01Z", duration_ms: 1000, python_version: "test" }
        });
      }
    };
    const orchestrator = new Orchestrator({ runsRoot: root, workerFactory: () => worker });
    await expect(orchestrator.run(fixture, { runtimeKind: "fake", executionKind: "local" })).rejects.toThrow(/Artifact identity mismatch/);
    expect(orchestrator.listRuns()[0]?.status).toBe("failed");
  });

  it("reproduces a completed run into a separately verified archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "modeling-reproduce-"));
    const orchestrator = new Orchestrator({ runsRoot: root });
    const packageRoot = resolve(root, "package");
    await cp(fixture, packageRoot, { recursive: true });
    const first = await orchestrator.run(packageRoot, { runtimeKind: "fake", executionKind: "local" });
    await rm(packageRoot, { recursive: true, force: true });
    const reproduced = await orchestrator.reproduce(first.run.id);

    expect(reproduced.status).toBe("completed");
    expect(reproduced.sourceRunId).toBe(first.run.id);
    await access(reproduced.projectArchive);
    expect(reproduced.taskResults.every((item) => item.status === "success")).toBe(true);
  }, 120_000);
});
