import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExperimentRequest, TaskNode } from "../src/contracts/types.js";
import { buildDockerExecutionPlan, LocalPythonWorker } from "../src/execution/python-worker.js";
import { fileIdentity } from "../src/infrastructure/hash.js";

async function request(root: string, targetColumn: string): Promise<ExperimentRequest> {
  const dataPath = resolve(root, "data.csv");
  await writeFile(dataPath, "x,target\n1,2\n2,4\n3,6\n4,8\n5,10\n6,12\n7,14\n8,16\n", "utf8");
  const identity = await fileIdentity(dataPath);
  const task: TaskNode = {
    id: "task-001",
    title: "Regression",
    task_type: "regression_prediction",
    objective: "Fit a held-out regression model.",
    requirement_ids: ["req-001"],
    depends_on: [],
    input_artifact_ids: ["input-data"],
    evidence_level: "standard",
    budget: { max_attempts: 1, max_runtime_seconds: 60, max_tokens: 1000 },
    config: { target_column: targetColumn }
  };
  return {
    schema_version: "1.0.0",
    run_id: "run-test",
    attempt_id: "task-001-attempt-001",
    task,
    evaluation_contract: {
      schema_version: "1.0.0",
      contract_id: "eval-task-001",
      task_id: task.id,
      task_type: task.task_type,
      primary_objective: task.objective,
      metrics: [{ name: "mae", direction: "minimize", role: "primary" }],
      hard_checks: ["execution_succeeded"],
      selection_rule: "Minimize MAE.",
      frozen_at: "2024-01-01T00:00:00Z"
    },
    data_files: [{ artifact_id: "input-data", relative_path: "data.csv", absolute_path: dataPath, media_type: "text/csv", size_bytes: identity.sizeBytes, sha256: identity.sha256 }],
    output_dir: resolve(root, "output"),
    random_seed: 7,
    task_config: { target_column: targetColumn }
  };
}

describe("Python workers", () => {
  it("returns a schema-valid structured task failure instead of throwing on runner exit 1", async () => {
    const root = await mkdtemp(join(tmpdir(), "modeling-worker-"));
    await mkdir(resolve(root, "output"), { recursive: true });
    const result = await new LocalPythonWorker().execute(await request(root, "missing"));
    expect(result.status).toBe("failed");
    expect(result.error?.class).toBe("data_quality_blocker");
    expect(result.error?.fingerprint).toMatch(/^[a-f0-9]{16}$/);
  });

  it("rewrites Docker request paths to match read-only input and writable output mounts", async () => {
    const root = await mkdtemp(join(tmpdir(), "modeling-docker-plan-"));
    const experimentRequest = await request(root, "target");
    const plan = buildDockerExecutionPlan(experimentRequest, {
      image: "modeling-agent-python:test",
      hostUser: { uid: 12345, gid: 23456 }
    });

    expect(plan.containerRequest.output_dir).toBe("/workspace/output");
    expect(plan.containerRequest.data_files[0]?.absolute_path).toBe("/workspace/input/0/data.csv");
    expect(JSON.stringify(plan.containerRequest)).not.toContain(root);
    expect(plan.args).toEqual(expect.arrayContaining([
      "--user", "12345:23456",
      "--read-only",
      "--workdir", "/opt/modeling-agent",
      "-v", `${resolve(root, "data.csv")}:/workspace/input/0/data.csv:ro`,
      "-v", `${resolve(root, "output")}:/workspace/output:rw`,
      "modeling-agent-python:test", "python", "-m", "modeling_agent.runner", "--request", "/workspace/output/experiment-request.json"
    ]));
    expect(plan.args[plan.args.indexOf("--user") + 1]).toBe("12345:23456");
    expect(plan.args.filter((argument) => argument.endsWith(":ro"))).toContain(`${resolve(root, "data.csv")}:/workspace/input/0/data.csv:ro`);
    expect(plan.args.filter((argument) => argument.endsWith(":rw"))).toContain(`${resolve(root, "output")}:/workspace/output:rw`);
    expect(plan.args.slice(-6)).toEqual([
      "modeling-agent-python:test", "python", "-m", "modeling_agent.runner", "--request", "/workspace/output/experiment-request.json"
    ]);
  });
});
