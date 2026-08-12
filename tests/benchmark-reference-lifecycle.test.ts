import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { BenchmarkManifest } from "../src/benchmark/types.js";

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
  throw new Error("timed out waiting for benchmark adapter signal");
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

describe("benchmark reference lifecycle", () => {
  it("does not open included reference bytes before the adapter completes", async () => {
    const root = await mkdtemp(join(tmpdir(), "benchmark-reference-lifecycle-"));
    const signal = resolve(root, "adapter-started");
    const release = resolve(root, "adapter-release");
    const reference = resolve(root, "reference/reference.txt");
    const movedReference = resolve(root, "reference/reference-moved.txt");
    const childScript = resolve(root, "child.mts");
    await mkdir(resolve(root, "package"));
    await mkdir(resolve(root, "reference"));
    await writeFile(resolve(root, "package/problem.md"), "Synthetic lifecycle package.\n", "utf8");
    await writeFile(reference, "REFERENCE-LIFECYCLE-SECRET-314159265358979\n", "utf8");
    const manifest: BenchmarkManifest = {
      schema_version: "1.0.0",
      case_id: "synthetic-reference-lifecycle",
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
      reference_policy: { access: "scoring_only", availability: "included", relative_path: "reference/reference.txt", sha256: null },
      runtime: { agent_adapter_id: "lifecycle-agent-v1", one_shot_adapter_id: "lifecycle-one-shot-v1" },
      execution: { kind: "local", network_access: "disabled" },
      budget: { max_wall_time_ms: 5_000, max_tokens: null, max_cost_usd: null, max_human_review_minutes: null },
      allowed_task_types: ["statistical_analysis"],
      expected_task_types: ["statistical_analysis"],
      hard_checks: [{ id: "answer-present", description: "A synthetic answer is present." }]
    };
    await writeFile(childScript, `
import { access, writeFile } from "node:fs/promises";
import { runBenchmarkCase } from ${JSON.stringify(resolve(process.cwd(), "src/benchmark/runner.ts"))};
const [root, signal, release] = process.argv.slice(2);
const manifest = ${JSON.stringify(manifest)};
const result = await runBenchmarkCase({
  case_root: root,
  manifest,
  adapter: {
    id: "lifecycle-agent-v1",
    variant: "agent",
    run: async () => {
      await writeFile(signal, "ready");
      while (true) {
        try { await access(release); break; } catch { await new Promise((resolvePromise) => setTimeout(resolvePromise, 10)); }
      }
      return {
        status: "success",
        observed_task_types: ["statistical_analysis"],
        hard_checks: [{ id: "answer-present", passed: true }],
        artifacts: ["answer.md"],
        evidence: ["answer-evidence"],
        usage: { token_count: null, cost_usd: null },
        output_text: "Synthetic result."
      };
    }
  },
  identity: { commit: "lifecycle-child-v1", environment: "node-child-v1" }
});
process.stdout.write(JSON.stringify(result));
`, "utf8");

    const child = spawn(resolve(process.cwd(), "node_modules/.bin/tsx"), [childScript, root, signal, release], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    try {
      await waitForFile(signal);
      await rename(reference, movedReference);
      await writeFile(release, "go");
      const exit = await waitForExit(child);
      expect(exit.code).toBe(1);
      expect(exit.stdout).toBe("");
      expect(exit.stderr).toMatch(/ENOENT|unavailable/i);
    } finally {
      child.kill("SIGKILL");
    }
  }, 15_000);
});
