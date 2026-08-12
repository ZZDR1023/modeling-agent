import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { RunStore } from "../src/storage/run-store.js";

describe("run and artifact stores", () => {
  it("persists run transitions and events in SQLite", async () => {
    const root = await mkdtemp(join(tmpdir(), "modeling-store-"));
    const store = new RunStore(join(root, "runs.sqlite"));
    const created = store.createRun({
      id: "run-test-1",
      packagePath: "/tmp/package",
      workspacePath: root,
      runtimeKind: "fake",
      executionKind: "local"
    });
    expect(created.status).toBe("queued");
    store.appendEvent({ run_id: created.id, event_type: "started", timestamp: new Date().toISOString(), payload: { ok: true } });
    const updated = store.updateRun(created.id, { status: "completed", current_stage: "export" });
    expect(updated.status).toBe("completed");
    expect(store.listRuns()).toHaveLength(1);
    expect(store.getEvents(created.id)).toHaveLength(1);
    store.close();
  });

  it("writes content-addressed artifacts and blocks unsafe paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "modeling-artifacts-"));
    const artifacts = new ArtifactStore(root);
    const record = await artifacts.putText("run-1", "deliverables/result.json", "{\"ok\":true}\n", "application/json");
    expect(record.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(root, "run-1", "deliverables/result.json"), "utf8")).toContain("ok");
    await expect(artifacts.putText("run-1", "../escape.txt", "nope", "text/plain")).rejects.toThrow(/unsafe/);
  });
});
