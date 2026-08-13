import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  readServerConfig
} from "../src/server/config.js";

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

const compiledAssets = [
  "dist/schemas/coverage-report.v1.json",
  "dist/schemas/evaluation-contract.v1.json",
  "dist/schemas/evidence-graph.v1.json",
  "dist/schemas/experiment-request.v1.json",
  "dist/schemas/experiment-result.v1.json",
  "dist/schemas/problem-spec.v1.json",
  "dist/schemas/task-graph.v1.json",
  "dist/python/modeling_agent/__init__.py",
  "dist/python/modeling_agent/forecasting.py",
  "dist/python/modeling_agent/io.py",
  "dist/python/modeling_agent/metrics.py",
  "dist/python/modeling_agent/runner.py",
  "dist/python/requirements.lock",
  "dist/python/standalone.Dockerfile",
  "dist/python/standalone_reproduce.py"
];

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function waitForExit(child: ChildProcess, timeoutMs?: number): Promise<ExitResult> {
  return new Promise((resolvePromise, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    let timeout: NodeJS.Timeout | undefined;
    const complete = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (timeout) clearTimeout(timeout);
      resolvePromise({ code, signal });
    };
    child.once("close", complete);
    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        child.removeListener("close", complete);
        reject(new Error(`Compiled server did not exit within ${timeoutMs}ms.`));
      }, timeoutMs);
    }
  });
}

async function stopServer(child: ChildProcess): Promise<ExitResult> {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  child.kill("SIGTERM");
  try {
    return await waitForExit(child, 10_000);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await waitForExit(child, 10_000).catch(() => undefined);
    throw error;
  }
}

async function unusedLoopbackPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = probe.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolvePromise) => probe.close(() => resolvePromise()));
    throw new Error("Could not determine a loopback port.");
  }
  const port = address.port;
  await new Promise<void>((resolvePromise, reject) => {
    probe.close((error) => error ? reject(error) : resolvePromise());
  });
  return port;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

beforeAll(async () => {
  const build = await runCommand("npm", ["run", "build"]);
  expect(build.code, `${build.stdout}\n${build.stderr}`).toBe(0);
}, 30_000);

async function waitForHealth(url: string, child: ChildProcess, stderr: () => string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Compiled server exited before health check: ${stderr()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.status === 200) {
        await response.arrayBuffer();
        return;
      }
      await response.arrayBuffer();
    } catch {
      // The listener may still be starting.
    }
    await delay(50);
  }
  throw new Error(`Compiled server did not become healthy: ${stderr()}`);
}

async function waitForJob(
  url: string,
  child: ChildProcess,
  stderr: () => string
): Promise<{ job: Record<string, unknown>; statuses: string[] }> {
  const statuses: string[] = [];
  for (let attempt = 0; attempt < 720; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Compiled server exited while running job: ${stderr()}`);
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    const body = await response.text();
    if (response.status !== 200) throw new Error(`Unexpected job response ${response.status}: ${body}`);
    const parsed = JSON.parse(body) as { job?: Record<string, unknown> };
    const status = parsed.job?.status;
    if (typeof status !== "string") throw new Error(`Job response omitted status: ${body}`);
    statuses.push(status);
    if (status === "succeeded" || status === "failed") {
      if (!parsed.job) throw new Error(`Job response omitted job: ${body}`);
      return { job: parsed.job, statuses };
    }
    await delay(250);
  }
  throw new Error(`Compiled job did not reach a terminal state: ${stderr()}`);
}

describe("compiled server entry point", () => {
  it("runs a real fake/local HTTP job through archive download", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "modeling-server-main-"));
    const fixture = resolve(process.cwd(), "tests", "fixtures", "basic");
    const port = await unusedLoopbackPort();
    const server = spawn(process.execPath, [resolve(process.cwd(), "dist/src/server/main.js")], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MODELING_AGENT_HOST: "127.0.0.1",
        MODELING_AGENT_PORT: String(port),
        MODELING_AGENT_RUNS_ROOT: runsRoot
      },
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    server.stderr?.setEncoding("utf8");
    server.stderr?.on("data", (chunk: string) => { stderr += chunk; });

    try {
      const baseUrl = `http://127.0.0.1:${port}`;
      await waitForHealth(`${baseUrl}/health`, server, () => stderr);

      const acceptedResponse = await fetch(`${baseUrl}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packagePath: fixture, runtime: "fake", execution: "local" }),
        signal: AbortSignal.timeout(10_000)
      });
      const acceptedBody = await acceptedResponse.text();
      expect(acceptedResponse.status).toBe(202);
      expect(acceptedBody).not.toContain(fixture);
      expect(acceptedBody).not.toMatch(/runs\.sqlite|stack|token/i);
      const accepted = JSON.parse(acceptedBody) as { status: string; job: { id: string; status: string } };
      expect(accepted).toMatchObject({ status: "accepted", job: { status: "queued" } });

      const jobResult = await waitForJob(`${baseUrl}/api/jobs/${accepted.job.id}`, server, () => stderr);
      expect(jobResult.statuses).toContain("running");
      expect(jobResult.job).toMatchObject({
        id: accepted.job.id,
        status: "succeeded",
        runId: expect.stringMatching(/^run-[A-Za-z0-9._-]+$/)
      });
      const runId = jobResult.job.runId as string;
      expect(JSON.stringify(jobResult.job)).not.toContain(fixture);
      expect(JSON.stringify(jobResult.job)).not.toMatch(/runs\.sqlite|stack|token/i);

      const shownResponse = await fetch(`${baseUrl}/api/runs/${runId}`, { signal: AbortSignal.timeout(10_000) });
      const shownBody = await shownResponse.text();
      expect(shownResponse.status).toBe(200);
      expect(shownBody).not.toContain(fixture);
      expect(shownBody).not.toMatch(/package_path|workspace_path|project_archive|runs\.sqlite|stack|token/i);
      const shown = JSON.parse(shownBody) as {
        status: string;
        run: { status: string; archiveAvailable: boolean };
        events: unknown[];
      };
      expect(shown.status).toBe("ok");
      expect(["completed", "completed_with_warnings"]).toContain(shown.run.status);
      expect(shown.run.archiveAvailable).toBe(true);
      expect(shown.events.length).toBeGreaterThan(0);

      const archiveResponse = await fetch(`${baseUrl}/api/runs/${runId}/archive`, { signal: AbortSignal.timeout(10_000) });
      const archiveBytes = Buffer.from(await archiveResponse.arrayBuffer());
      expect(archiveResponse.status).toBe(200);
      expect(archiveResponse.headers.get("content-type")).toMatch(/^application\/zip/);
      expect(archiveBytes.subarray(0, 2).toString()).toBe("PK");
      const downloadedArchive = resolve(runsRoot, "downloaded-project.zip");
      await writeFile(downloadedArchive, archiveBytes);
      const unzip = await runCommand("unzip", ["-t", downloadedArchive]);
      expect(unzip.code, `${unzip.stdout}\n${unzip.stderr}`).toBe(0);

      const exit = await stopServer(server);
      expect(exit).toEqual({ code: 0, signal: null });
    } finally {
      try {
        if (server.exitCode === null && server.signalCode === null) await stopServer(server);
      } finally {
        await rm(runsRoot, { recursive: true, force: true });
      }
    }
  }, 180_000);

  it("copies schemas and standalone runtime assets beside compiled modules", async () => {
    await Promise.all(compiledAssets.map(async (asset) => {
      await expect(access(resolve(process.cwd(), asset))).resolves.toBeUndefined();
    }));
  });
});

describe("compiled server startup boundaries", () => {
  it("rejects a non-loopback host before listening", async () => {
    const port = await unusedLoopbackPort();
    const runsRoot = await mkdtemp(join(tmpdir(), "modeling-server-rejected-"));
    const child = spawn(process.execPath, [resolve(process.cwd(), "dist/src/server/main.js")], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MODELING_AGENT_HOST: "0.0.0.0",
        MODELING_AGENT_PORT: String(port),
        MODELING_AGENT_RUNS_ROOT: runsRoot
      },
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });

    try {
      const exit = await waitForExit(child, 10_000).catch((error: unknown) => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        throw new Error(`Non-loopback server did not exit: ${stderr}`, { cause: error });
      });
      expect(exit).toEqual({ code: 1, signal: null });
      expect(stderr).toMatch(/Refusing unauthenticated non-loopback host/i);
    } finally {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await waitForExit(child, 10_000).catch(() => undefined);
        }
      } finally {
        await rm(runsRoot, { recursive: true, force: true });
      }
    }
  }, 30_000);
});

describe("server configuration", () => {
  it("uses loopback-only defaults", () => {
    expect(readServerConfig({})).toEqual({
      host: DEFAULT_SERVER_HOST,
      port: DEFAULT_SERVER_PORT,
      runsRoot: "runs"
    });
  });

  it("reads explicit host, port, and runs root", () => {
    expect(readServerConfig({
      MODELING_AGENT_HOST: "::1",
      MODELING_AGENT_PORT: "5432",
      MODELING_AGENT_RUNS_ROOT: "./temporary-runs"
    })).toEqual({ host: "::1", port: 5432, runsRoot: "./temporary-runs" });
  });

  it.each(["", "0", "65536", "abc", "43.17"])("rejects invalid port %s", (port) => {
    expect(() => readServerConfig({ MODELING_AGENT_PORT: port })).toThrow(/port/i);
  });
});
