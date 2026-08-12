import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { InjectPayload } from "light-my-request";
import type { RunDetails, RunOptions } from "../src/orchestrator/orchestrator.js";
import type { RunEvent, RunSummary } from "../src/contracts/types.js";
import {
  buildServer,
  type OrchestratorAdapter,
  type ServerRunResult
} from "../src/server/index.js";

const fixedNow = new Date("2026-08-12T18:30:00.000Z");
const servers: FastifyInstance[] = [];

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: "run-20260812183000-abcdef12",
    package_path: "/home/private/competition-package",
    workspace_path: "/home/private/runs/workspaces/run-20260812183000-abcdef12",
    runtime_kind: "fake",
    execution_kind: "local",
    status: "completed",
    current_stage: "export",
    created_at: "2026-08-12T18:29:00.000Z",
    updated_at: "2026-08-12T18:30:00.000Z",
    error_message: null,
    project_archive: "/home/private/runs/workspaces/run-20260812183000-abcdef12/project.zip",
    ...overrides
  };
}

function event(overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    id: 1,
    run_id: "run-20260812183000-abcdef12",
    stage_id: "export",
    event_type: "run_completed",
    timestamp: "2026-08-12T18:30:00.000Z",
    payload: {
      project_archive: "/home/private/runs/workspaces/run/project.zip",
      stack: "Error: secret\n at /home/private/src/file.ts:1:1",
      token: "top-secret-token"
    },
    ...overrides
  };
}

interface AdapterOverrides {
  listRuns?: () => RunSummary[] | Promise<RunSummary[]>;
  showRun?: (id: string) => RunDetails | undefined | Promise<RunDetails | undefined>;
  run?: (packagePath: string, options: RunOptions) => Promise<ServerRunResult>;
  close?: () => void | Promise<void>;
}

function adapter(overrides: AdapterOverrides = {}): OrchestratorAdapter {
  return {
    listRuns: overrides.listRuns ?? (() => []),
    showRun: overrides.showRun ?? ((id: string) => {
      throw new Error(`Unknown run: ${id}`);
    }),
    run: overrides.run ?? (async () => ({ run: summary() })),
    ...(overrides.close ? { close: overrides.close } : {})
  };
}

function server(orchestrator: OrchestratorAdapter, options: Parameters<typeof buildServer>[0] = { orchestrator }): FastifyInstance {
  const instance = buildServer({
    ...options,
    orchestrator,
    clock: () => fixedNow,
    jobId: () => "job-fixed"
  });
  servers.push(instance);
  return instance;
}

async function waitForJob(instance: FastifyInstance, id: string, expected: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await instance.inject({ method: "GET", url: `/api/jobs/${id}` });
    const body = response.json() as { job?: Record<string, unknown> };
    if (body.job?.status === expected) return body.job;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  }
  throw new Error(`Job ${id} did not reach ${expected}.`);
}

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map(async (instance) => instance.close()));
});

describe("Fastify server baseline", () => {
  it("reports health without enabling CORS", async () => {
    const instance = server(adapter());
    const response = await instance.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://untrusted.example" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it.each(["0.0.0.0", "::", "192.168.1.9", "example.com"])("rejects unauthenticated non-loopback host %s", (host) => {
    expect(() => buildServer({ orchestrator: adapter(), host })).toThrow(/loopback/i);
  });

  it.each(["127.0.0.1", "127.0.0.2", "::1", "localhost"])("accepts loopback host %s", async (host) => {
    const instance = buildServer({ orchestrator: adapter(), host });
    servers.push(instance);
    expect((await instance.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("strictly rejects malformed run requests and unknown fields", async () => {
    const run = vi.fn(async () => ({ run: summary() }));
    const instance = server(adapter({ run }));
    const invalidBodies: InjectPayload[] = [
      {},
      { packagePath: 42 },
      { packagePath: "/package", unknown: true },
      { packagePath: "/package", runtime: "other" },
      { packagePath: "/package", execution: "remote" },
      { packagePath: "/package", provider: "p".repeat(129) },
      { packagePath: "/package", model: "m".repeat(257) },
      { packagePath: "/package", thinking: "extreme" }
    ];

    for (const body of invalidBodies) {
      const response = await instance.inject({ method: "POST", url: "/api/runs", payload: body });
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(response.json()).toEqual({
        status: "failed",
        error: { class: "invalid_request", message: "Request validation failed." }
      });
    }

    const malformed = await instance.inject({
      method: "POST",
      url: "/api/runs",
      headers: { "content-type": "application/json" },
      payload: "{not-json"
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({
      status: "failed",
      error: { class: "invalid_request", message: "Request validation failed." }
    });

    const unsupported = await instance.inject({
      method: "POST",
      url: "/api/runs",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("package")
    });
    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.json()).toEqual({
      status: "failed",
      error: { class: "unsupported_media_type", message: "Content-Type must be application/json." }
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("returns 202 immediately, applies defaults, and tracks a successful background job", async () => {
    let finish: ((value: ServerRunResult) => void) | undefined;
    const pending = new Promise<ServerRunResult>((resolvePromise) => { finish = resolvePromise; });
    const run = vi.fn(() => pending);
    const instance = server(adapter({ run }));

    const response = await instance.inject({
      method: "POST",
      url: "/api/runs",
      payload: { packagePath: "/adapter/validates/this" }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      status: "accepted",
      job: {
        id: "job-fixed",
        status: "queued",
        createdAt: fixedNow.toISOString(),
        updatedAt: fixedNow.toISOString()
      }
    });
    expect(response.body).not.toContain("/adapter/validates/this");
    await waitForJob(instance, "job-fixed", "running");
    expect(run).toHaveBeenCalledWith("/adapter/validates/this", {
      runtimeKind: "fake",
      executionKind: "local"
    });

    finish?.({ run: summary({ id: "run-success" }) });
    expect(await waitForJob(instance, "job-fixed", "succeeded")).toEqual({
      id: "job-fixed",
      status: "succeeded",
      createdAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
      runId: "run-success"
    });
  });

  it("passes bounded optional runtime settings to the adapter", async () => {
    const run = vi.fn(async () => ({ run: summary({ id: "run-pi" }) }));
    const instance = server(adapter({ run }));

    const response = await instance.inject({
      method: "POST",
      url: "/api/runs",
      payload: {
        packagePath: "relative-package",
        runtime: "pi",
        execution: "docker",
        provider: "anthropic",
        model: "claude-model",
        thinking: "high"
      }
    });

    expect(response.statusCode).toBe(202);
    await waitForJob(instance, "job-fixed", "succeeded");
    expect(run).toHaveBeenCalledWith("relative-package", {
      runtimeKind: "pi",
      executionKind: "docker",
      provider: "anthropic",
      model: "claude-model",
      thinkingLevel: "high"
    });
  });

  it("atomically rejects a duplicate generated job id under concurrent requests", async () => {
    let finish: ((value: ServerRunResult) => void) | undefined;
    const pending = new Promise<ServerRunResult>((resolvePromise) => { finish = resolvePromise; });
    const run = vi.fn(() => pending);
    const instance = server(adapter({ run }));

    const responses = await Promise.all([
      instance.inject({ method: "POST", url: "/api/runs", payload: { packagePath: "one" } }),
      instance.inject({ method: "POST", url: "/api/runs", payload: { packagePath: "two" } })
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 409]);
    const conflict = responses.find((response) => response.statusCode === 409);
    expect(conflict?.json()).toEqual({
      status: "failed",
      error: { class: "job_id_conflict", message: "A job with the generated id already exists." }
    });
    expect(run).toHaveBeenCalledTimes(1);
    finish?.({ run: summary() });
    await waitForJob(instance, "job-fixed", "succeeded");
  });

  it("contains background rejections without leaking paths, stacks, tokens, or database details", async () => {
    const instance = server(adapter({
      run: async () => {
        throw new Error("token=secret failed at /home/private/run/runs.sqlite\nSTACK INTERNAL_ENV=value");
      }
    }));

    expect((await instance.inject({
      method: "POST",
      url: "/api/runs",
      payload: { packagePath: "/home/private/package" }
    })).statusCode).toBe(202);

    const failed = await waitForJob(instance, "job-fixed", "failed");
    expect(failed).toEqual({
      id: "job-fixed",
      status: "failed",
      createdAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
      error: { class: "run_failure", message: "The run failed. Inspect local run artifacts for details." }
    });
    expect(JSON.stringify(failed)).not.toMatch(/secret|token|stack|\/home\/|runs\.sqlite|INTERNAL_ENV/i);
  });

  it("returns stable 404 envelopes for unknown jobs and routes", async () => {
    const instance = server(adapter());
    const response = await instance.inject({ method: "GET", url: "/api/jobs/missing-job" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      status: "failed",
      error: { class: "job_not_found", message: "Job not found." }
    });

    const route = await instance.inject({ method: "GET", url: "/does-not-exist" });
    expect(route.statusCode).toBe(404);
    expect(route.json()).toEqual({
      status: "failed",
      error: { class: "route_not_found", message: "Route not found." }
    });
  });

  it("lists and shows only safe public run and event fields", async () => {
    const run = summary({ status: "failed", error_message: "ENOENT /home/private/package token=secret" });
    const details = { run, events: [event()] };
    const instance = server(adapter({
      listRuns: () => [run],
      showRun: (id) => id === run.id ? details : undefined
    }));

    const listed = await instance.inject({ method: "GET", url: "/api/runs" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      status: "ok",
      runs: [{
        id: run.id,
        runtimeKind: "fake",
        executionKind: "local",
        status: "failed",
        currentStage: "export",
        createdAt: run.created_at,
        updatedAt: run.updated_at,
        archiveAvailable: false,
        error: { class: "run_failure", message: "The run failed. Inspect local run artifacts for details." }
      }]
    });

    const shown = await instance.inject({ method: "GET", url: `/api/runs/${run.id}` });
    expect(shown.statusCode).toBe(200);
    expect(shown.json()).toEqual({
      status: "ok",
      run: (listed.json() as { runs: unknown[] }).runs[0],
      events: [{
        id: 1,
        stageId: "export",
        eventType: "run_completed",
        timestamp: "2026-08-12T18:30:00.000Z"
      }]
    });
    expect(`${listed.body}${shown.body}`).not.toMatch(/package_path|workspace_path|project_archive|error_message|\/home\/|token|stack|runs\.sqlite/i);
  });

  it("returns a stable 404 when the adapter cannot find a run", async () => {
    const instance = server(adapter());
    const response = await instance.inject({ method: "GET", url: "/api/runs/run-missing" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      status: "failed",
      error: { class: "run_not_found", message: "Run not found." }
    });
  });

  it("gates archives by run state and file availability, then streams the verified archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "modeling-server-archive-"));
    const archive = resolve(root, "project.zip");
    const invalidArchive = resolve(root, "invalid-project.zip");
    const missingArchive = resolve(root, "missing-project.zip");
    const bytes = Buffer.from("PK\u0003\u0004archive-bytes", "binary");
    await Promise.all([
      writeFile(archive, bytes),
      writeFile(invalidArchive, "not a zip", "utf8")
    ]);
    const runs = new Map<string, RunDetails>([
      ["run-running", { run: summary({ id: "run-running", status: "running", workspace_path: root, project_archive: archive }), events: [] }],
      ["run-no-archive", { run: summary({ id: "run-no-archive", workspace_path: root, project_archive: null }), events: [] }],
      ["run-gone", { run: summary({ id: "run-gone", workspace_path: root, project_archive: missingArchive }), events: [] }],
      ["run-invalid", { run: summary({ id: "run-invalid", workspace_path: root, project_archive: invalidArchive }), events: [] }],
      ["run-outside", { run: summary({ id: "run-outside", workspace_path: resolve(root, "other-workspace"), project_archive: archive }), events: [] }],
      ["run-ready", { run: summary({ id: "run-ready", workspace_path: root, project_archive: archive }), events: [] }]
    ]);
    const instance = server(adapter({ showRun: (id) => runs.get(id) }));

    expect((await instance.inject({ method: "GET", url: "/api/runs/run-unknown/archive" })).statusCode).toBe(404);
    const running = await instance.inject({ method: "GET", url: "/api/runs/run-running/archive" });
    expect(running.statusCode).toBe(409);
    expect(running.json()).toEqual({
      status: "failed",
      error: { class: "archive_not_ready", message: "The run does not have a completed project archive." }
    });
    expect((await instance.inject({ method: "GET", url: "/api/runs/run-no-archive/archive" })).statusCode).toBe(409);
    const gone = await instance.inject({ method: "GET", url: "/api/runs/run-gone/archive" });
    expect(gone.statusCode).toBe(410);
    expect(gone.json()).toEqual({
      status: "failed",
      error: { class: "archive_gone", message: "The project archive is no longer available." }
    });

    const invalid = await instance.inject({ method: "GET", url: "/api/runs/run-invalid/archive" });
    expect(invalid.statusCode).toBe(410);
    expect(invalid.json()).toEqual({
      status: "failed",
      error: { class: "archive_gone", message: "The project archive is no longer available." }
    });

    const outside = await instance.inject({ method: "GET", url: "/api/runs/run-outside/archive" });
    expect(outside.statusCode).toBe(410);
    expect(outside.json()).toEqual({
      status: "failed",
      error: { class: "archive_gone", message: "The project archive is no longer available." }
    });
    expect(outside.rawPayload).not.toEqual(bytes);

    const traversal = await instance.inject({ method: "GET", url: "/api/runs/%2Fetc%2Fpasswd/archive" });
    expect(traversal.statusCode).toBe(400);
    expect(traversal.json()).toEqual({
      status: "failed",
      error: { class: "invalid_request", message: "Request validation failed." }
    });

    const ready = await instance.inject({ method: "GET", url: "/api/runs/run-ready/archive" });
    expect(ready.statusCode).toBe(200);
    expect(ready.headers["content-type"]).toMatch(/^application\/zip/);
    expect(ready.headers["content-disposition"]).toBe("attachment; filename=\"project.zip\"");
    expect(ready.headers["content-length"]).toBe(String(bytes.length));
    expect(ready.rawPayload).toEqual(bytes);

    await rm(root, { recursive: true, force: true });
  });

  it("rejects a final archive symlink without returning bytes from outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "modeling-server-archive-symlink-"));
    try {
      const workspace = resolve(root, "workspace");
      const outsideArchive = resolve(root, "outside.zip");
      const archive = resolve(workspace, "project.zip");
      const outsideBytes = Buffer.from("PK\u0003\u0004OUTSIDE-HOST-SECRET", "binary");
      await mkdir(workspace);
      await writeFile(outsideArchive, outsideBytes);
      await symlink(outsideArchive, archive);
      const instance = server(adapter({
        showRun: (id) => id === "run-symlink"
          ? { run: summary({ id, workspace_path: workspace, project_archive: archive }), events: [] }
          : undefined
      }));

      const response = await instance.inject({ method: "GET", url: "/api/runs/run-symlink/archive" });

      expect(response.statusCode).toBe(410);
      expect(response.json()).toEqual({
        status: "failed",
        error: { class: "archive_gone", message: "The project archive is no longer available." }
      });
      expect(response.rawPayload).not.toEqual(outsideBytes);
      expect(response.body).not.toContain("OUTSIDE-HOST-SECRET");
      expect((await lstat(archive)).isSymbolicLink()).toBe(true);
      expect(await readlink(archive)).toBe(outsideArchive);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an archive reached through an intermediate symlink outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "modeling-server-archive-chain-"));
    try {
      const workspace = resolve(root, "workspace");
      const outsideDirectory = resolve(root, "outside");
      const outsideArchive = resolve(outsideDirectory, "project.zip");
      const archive = resolve(workspace, "link", "project.zip");
      const outsideBytes = Buffer.from("PK\u0003\u0004OUTSIDE-DIRECTORY-SECRET", "binary");
      await Promise.all([mkdir(workspace), mkdir(outsideDirectory)]);
      await writeFile(outsideArchive, outsideBytes);
      await symlink(outsideDirectory, resolve(workspace, "link"));
      const instance = server(adapter({
        showRun: (id) => id === "run-directory-symlink"
          ? { run: summary({ id, workspace_path: workspace, project_archive: archive }), events: [] }
          : undefined
      }));

      const response = await instance.inject({ method: "GET", url: "/api/runs/run-directory-symlink/archive" });

      expect(response.statusCode).toBe(410);
      expect(response.json()).toEqual({
        status: "failed",
        error: { class: "archive_gone", message: "The project archive is no longer available." }
      });
      expect(response.rawPayload).not.toEqual(outsideBytes);
      expect(response.body).not.toContain("OUTSIDE-DIRECTORY-SECRET");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("converts unexpected request-time adapter failures to a non-sensitive 500 envelope", async () => {
    const instance = server(adapter({
      listRuns: () => {
        throw new Error("database /home/private/runs.sqlite token=secret stack");
      }
    }));
    const response = await instance.inject({ method: "GET", url: "/api/runs" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      status: "failed",
      error: { class: "internal_error", message: "The server could not complete the request." }
    });
    expect(response.body).not.toMatch(/database|\/home\/|runs\.sqlite|token|secret|stack/i);
  });

  it("invokes the optional adapter close only once across repeated server.close calls", async () => {
    const close = vi.fn(async () => undefined);
    const instance = server(adapter({ close }));
    await Promise.all([instance.close(), instance.close()]);
    expect(close).toHaveBeenCalledTimes(1);
    const index = servers.indexOf(instance);
    if (index >= 0) servers.splice(index, 1);
  });

  it("waits for active background jobs before invoking the optional adapter close", async () => {
    let finish: ((value: ServerRunResult) => void) | undefined;
    const pending = new Promise<ServerRunResult>((resolvePromise) => { finish = resolvePromise; });
    const close = vi.fn(async () => undefined);
    const instance = server(adapter({ run: () => pending, close }));
    expect((await instance.inject({
      method: "POST",
      url: "/api/runs",
      payload: { packagePath: "package" }
    })).statusCode).toBe(202);
    await waitForJob(instance, "job-fixed", "running");

    const closing = instance.close();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(close).not.toHaveBeenCalled();
    finish?.({ run: summary() });
    await closing;
    expect(close).toHaveBeenCalledTimes(1);
    const index = servers.indexOf(instance);
    if (index >= 0) servers.splice(index, 1);
  });
});
