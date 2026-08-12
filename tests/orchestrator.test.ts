import { describe, expect, it } from "vitest";
import { access, appendFile, cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";
import { SchemaRegistry } from "../src/contracts/schema-registry.js";
import type { ExperimentResult } from "../src/contracts/types.js";
import type { PythonWorker } from "../src/execution/python-worker.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";

const fixture = join(process.cwd(), "tests", "fixtures", "basic");

function runCommand(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

function dockerCopySources(dockerfile: string): string[] {
  const sources: string[] = [];
  for (const line of dockerfile.split("\n")) {
    const match = /^COPY\s+(\S+)\s+\S+\s*$/.exec(line.trim());
    if (match?.[1]) sources.push(match[1]);
  }
  return sources;
}

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
    const archiveEntries = (await runCommand("unzip", ["-Z1", result.projectArchive], process.cwd())).stdout.trim().split("\n");
    expect(archiveEntries.filter((path) => path.endsWith("/experiment-request.json"))).toHaveLength(9);
    expect(archiveEntries.filter((path) => path.endsWith("/experiment-result.json"))).toHaveLength(9);
    expect(archiveEntries.some((path) => path.includes("/figures/") && path.endsWith(".png"))).toBe(true);
    expect(archiveEntries.some((path) => path.includes("/tables/") && path.endsWith(".csv"))).toBe(true);
    expect(archiveEntries).toEqual(expect.arrayContaining([
      "README.md",
      "reproduce.py",
      "reproducibility/environment/requirements.lock",
      "reproducibility/environment/Dockerfile",
      "reproducibility/python/modeling_agent/runner.py"
    ]));
    const projectReadme = await readFile(resolve(projectRoot, "README.md"), "utf8");
    expect(projectReadme).toContain("Python 3.11");
    expect(projectReadme).toContain("python3 -m venv .venv");
    expect(projectReadme).toContain("pip install -r reproducibility/environment/requirements.lock");
    expect(projectReadme.match(/python3 reproduce\.py/g)).toHaveLength(1);
    expect(projectReadme).toContain("docker build -f reproducibility/environment/Dockerfile -t modeling-project-reproducer .");
    expect(projectReadme).toContain("docker run --rm modeling-project-reproducer");
    expect(projectReadme).toContain("offline");
    expect(projectReadme).not.toContain(basename(result.workspacePath));
    expect(projectReadme).not.toContain(process.cwd());

    const dockerfile = await readFile(resolve(projectRoot, "reproducibility/environment/Dockerfile"), "utf8");
    expect(dockerfile).toContain("# Build context: exported project root");
    expect(dockerfile).toContain('CMD ["python", "reproduce.py"]');
    const copySources = dockerCopySources(dockerfile);
    expect(copySources).toEqual(expect.arrayContaining([
      "reproducibility/environment/requirements.lock",
      "reproducibility/python/modeling_agent",
      "reproduce.py",
      "deliverables",
      "reproducibility/inputs",
      "reproducibility/experiments"
    ]));
    for (const source of copySources) {
      expect(isAbsolute(source), source).toBe(false);
      expect(posix.normalize(source), source).not.toMatch(/^\.\.\//);
      await access(resolve(projectRoot, source));
    }
    expect(archiveEntries.some((path) => path.endsWith(".aux"))).toBe(false);
    for (const path of archiveEntries.filter((entry) => /(?:\.(?:json|md|tex|log|py|txt|lock|csv)|Dockerfile)$/.test(entry))) {
      const content = (await runCommand("unzip", ["-p", result.projectArchive, path], process.cwd())).stdout;
      expect(content, path).not.toContain("/home/");
      expect(content, path).not.toContain("/tmp/");
      expect(content, path).not.toContain("runs.sqlite");
    }
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

  it("reproduces a completed archive after unpacking without the repository or run database", async () => {
    const root = await mkdtemp(join(tmpdir(), "modeling-reproduce-"));
    const orchestrator = new Orchestrator({ runsRoot: resolve(root, "runs") });
    const packageRoot = resolve(root, "package");
    await cp(fixture, packageRoot, { recursive: true });
    const first = await orchestrator.run(packageRoot, { runtimeKind: "fake", executionKind: "local" });
    const unpacked = resolve(root, "arbitrary", "unpacked-project");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(unpacked, { recursive: true }));
    const unzip = await runCommand("unzip", ["-q", first.projectArchive, "-d", unpacked], root);
    expect(unzip.code, unzip.stderr).toBe(0);
    await rm(packageRoot, { recursive: true, force: true });
    await rm(resolve(root, "runs"), { recursive: true, force: true });

    const reproduced = await runCommand("python3", ["reproduce.py"], unpacked, { ...process.env, PYTHONPATH: "" });
    expect(reproduced.code, `${reproduced.stdout}\n${reproduced.stderr}`).toBe(0);
    const manifest = JSON.parse(await readFile(resolve(unpacked, "reproduced", "reproduction-result.json"), "utf8")) as { task_count: number; verified_task_count: number; report_pdf: string };
    expect(manifest).toMatchObject({ task_count: 9, verified_task_count: 9, report_pdf: "deliverables/report.pdf" });
    expect((await readFile(resolve(unpacked, "reproduced", "deliverables", "report.pdf"))).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await readdir(resolve(unpacked, "reproduced", "experiments"))).sort()).toHaveLength(9);
  }, 180_000);
});
