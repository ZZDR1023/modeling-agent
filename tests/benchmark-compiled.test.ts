import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");

async function runNode(args: string[], timeout = 15_000): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, args, {
    cwd: repositoryRoot,
    timeout,
    env: { ...process.env, NODE_NO_WARNINGS: "1" }
  });
}

describe("compiled benchmark entrypoints", () => {
  it("runs the built synthetic CLI from the repository root without exposing the host output path", async () => {
    const output = await mkdtemp(join(tmpdir(), "benchmark-compiled-output-"));
    const { stdout, stderr } = await runNode(["dist/src/benchmark/run-synthetic.js", "--output", output]);

    expect(stderr).toBe("");
    expect(stdout).not.toContain(output);
    expect(stdout).not.toMatch(/\/(?:home|Users|tmp)\//);
    expect(JSON.parse(stdout)).toEqual({
      suite_id: "synthetic-v1",
      total_runs: 4,
      completed_runs: 4,
      json_report: "benchmark-report.json",
      markdown_report: "benchmark-report.md"
    });
    expect(JSON.parse(await readFile(resolve(output, "benchmark-report.json"), "utf8"))).toMatchObject({
      suite_id: "synthetic-v1",
      summary: { total_runs: 4, completed_runs: 4 }
    });
  });

  it("keeps a referenced timeout alive in an otherwise handle-free child process until a hard-error result is emitted", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "benchmark-timeout-child-"));
    const child = resolve(fixture, "timeout-child.mjs");
    await writeFile(child, `
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runBenchmarkCase } from ${JSON.stringify(pathToFileURL(resolve(repositoryRoot, "dist/src/benchmark/runner.js")).href)};

const root = process.argv[2];
await mkdir(resolve(root, "package"), { recursive: true });
await writeFile(resolve(root, "package/problem.md"), "Synthetic timeout package.\\n", "utf8");
const manifest = {
  schema_version: "1.0.0",
  case_id: "synthetic-timeout-child",
  package_path: "package",
  license: {
    name: "CC0 1.0 Universal",
    spdx_id: "CC0-1.0",
    copyright_holder: "modeling-agent contributors",
    source_url: null,
    redistribution: "permitted",
    notice_path: null
  },
  blind_policy: {
    mode: "blind",
    solve_input: "package_only",
    same_problem_answers: "block",
    minimum_reference_match_characters: 24
  },
  reference_policy: { access: "scoring_only", availability: "unavailable", relative_path: null, sha256: null },
  runtime: { agent_adapter_id: "timeout-agent-v1", one_shot_adapter_id: "timeout-one-shot-v1" },
  execution: { kind: "local", network_access: "disabled" },
  budget: { max_wall_time_ms: 40, max_tokens: null, max_cost_usd: null, max_human_review_minutes: null },
  allowed_task_types: ["statistical_analysis"],
  expected_task_types: ["statistical_analysis"],
  hard_checks: [{ id: "answer-present", description: "A synthetic answer is present." }]
};
const result = await runBenchmarkCase({
  case_root: root,
  manifest,
  adapter: { id: "timeout-agent-v1", variant: "agent", run: async () => new Promise(() => undefined) },
  identity: { commit: "timeout-child-v1", environment: "node-child-v1" }
});
process.stdout.write(JSON.stringify(result));
`, "utf8");

    const { stdout, stderr } = await runNode([child, fixture], 5_000);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      outcome: "hard_error",
      metrics: {
        completion: { status: "measured", value: false },
        hard_error: { status: "measured", value: true }
      }
    });
  });
});
