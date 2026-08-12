import { spawn } from "node:child_process";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const fixture = join(process.cwd(), "tests", "fixtures", "basic");

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], runsRoot: string): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli/main.ts", "--runs-root", runsRoot, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
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

function parseJson(result: CommandResult): unknown {
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}

describe("CLI lifecycle", () => {
  it("supports run, list, show, export, and reproduce", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "modeling-cli-"));
    const run = parseJson(await runCli(["run", fixture, "--runtime", "fake", "--execution", "local", "--json"], runsRoot)) as {
      run: { id: string };
      projectArchive: string;
    };
    await access(run.projectArchive);

    const list = parseJson(await runCli(["list", "--json"], runsRoot)) as Array<{ id: string }>;
    expect(list.map((item) => item.id)).toContain(run.run.id);

    const shown = parseJson(await runCli(["show", run.run.id, "--json"], runsRoot)) as {
      run: { id: string; status: string };
      events: unknown[];
    };
    expect(shown.run).toMatchObject({ id: run.run.id, status: "completed" });
    expect(shown.events.length).toBeGreaterThan(0);

    const exportPath = resolve(runsRoot, "exports", `${run.run.id}.zip`);
    const exported = parseJson(await runCli(["export", run.run.id, exportPath, "--json"], runsRoot)) as { destination: string; sha256: string };
    expect(exported.destination).toBe(exportPath);
    expect(exported.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await readFile(exportPath)).subarray(0, 2).toString()).toBe("PK");

    const reproduced = parseJson(await runCli(["reproduce", run.run.id, "--json"], runsRoot)) as {
      sourceRunId: string;
      run: { id: string };
      projectArchive: string;
    };
    expect(reproduced.sourceRunId).toBe(run.run.id);
    expect(reproduced.run.id).not.toBe(run.run.id);
    await access(reproduced.projectArchive);
  }, 180_000);
});
