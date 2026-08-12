import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RunEvent, RunStatus, RunSummary } from "../contracts/types.js";

export interface CreateRunInput {
  id: string;
  packagePath: string;
  workspacePath: string;
  runtimeKind: RunSummary["runtime_kind"];
  executionKind: RunSummary["execution_kind"];
}

export interface RunUpdate {
  status?: RunStatus;
  current_stage?: string;
  error_message?: string | null;
  project_archive?: string | null;
}

type Row = Record<string, unknown>;

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : asString(value);
}

function mapRun(row: Row): RunSummary {
  return {
    id: asString(row.id),
    package_path: asString(row.package_path),
    workspace_path: asString(row.workspace_path),
    runtime_kind: asString(row.runtime_kind) as RunSummary["runtime_kind"],
    execution_kind: asString(row.execution_kind) as RunSummary["execution_kind"],
    status: asString(row.status) as RunStatus,
    current_stage: asString(row.current_stage),
    created_at: asString(row.created_at),
    updated_at: asString(row.updated_at),
    error_message: asNullableString(row.error_message),
    project_archive: asNullableString(row.project_archive)
  };
}

export class RunStore {
  readonly #db: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.#db = new DatabaseSync(databasePath, { timeout: 5000 });
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        package_path TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        runtime_kind TEXT NOT NULL CHECK(runtime_kind IN ('fake', 'pi')),
        execution_kind TEXT NOT NULL CHECK(execution_kind IN ('local', 'docker')),
        status TEXT NOT NULL,
        current_stage TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        error_message TEXT,
        project_archive TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        stage_id TEXT,
        attempt_id TEXT,
        event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        payload_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS run_events_run_id_idx ON run_events(run_id, id);
    `);
  }

  createRun(input: CreateRunInput): RunSummary {
    const now = new Date().toISOString();
    this.#db.prepare(`
      INSERT INTO runs (id, package_path, workspace_path, runtime_kind, execution_kind, status, current_stage, created_at, updated_at, error_message, project_archive)
      VALUES (?, ?, ?, ?, ?, 'queued', 'import', ?, ?, NULL, NULL)
    `).run(input.id, input.packagePath, input.workspacePath, input.runtimeKind, input.executionKind, now, now);
    const run = this.getRun(input.id);
    if (!run) throw new Error(`Run was not created: ${input.id}`);
    return run;
  }

  getRun(id: string): RunSummary | undefined {
    const row = this.#db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
    return row ? mapRun(row) : undefined;
  }

  listRuns(): RunSummary[] {
    const rows = this.#db.prepare("SELECT * FROM runs ORDER BY created_at DESC").all() as Row[];
    return rows.map(mapRun);
  }

  updateRun(id: string, update: RunUpdate): RunSummary {
    const current = this.getRun(id);
    if (!current) throw new Error(`Unknown run: ${id}`);
    const next: RunUpdate = {
      status: update.status ?? current.status,
      current_stage: update.current_stage ?? current.current_stage,
      error_message: update.error_message === undefined ? current.error_message : update.error_message,
      project_archive: update.project_archive === undefined ? current.project_archive : update.project_archive
    };
    const now = new Date().toISOString();
    const nextStatus = next.status ?? current.status;
    const nextStage = next.current_stage ?? current.current_stage;
    const nextError = next.error_message === undefined ? current.error_message : next.error_message;
    const nextArchive = next.project_archive === undefined ? current.project_archive : next.project_archive;
    this.#db.prepare(`
      UPDATE runs SET status = ?, current_stage = ?, updated_at = ?, error_message = ?, project_archive = ? WHERE id = ?
    `).run(nextStatus, nextStage, now, nextError, nextArchive, id);
    const result = this.getRun(id);
    if (!result) throw new Error(`Run disappeared during update: ${id}`);
    return result;
  }

  appendEvent(event: Omit<RunEvent, "id">): number {
    const result = this.#db.prepare(`
      INSERT INTO run_events (run_id, stage_id, attempt_id, event_type, timestamp, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.run_id,
      event.stage_id ?? null,
      event.attempt_id ?? null,
      event.event_type,
      event.timestamp,
      JSON.stringify(event.payload)
    );
    return Number(result.lastInsertRowid);
  }

  getEvents(runId: string): RunEvent[] {
    const rows = this.#db.prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY id").all(runId) as Row[];
    return rows.map((row) => ({
      id: Number(row.id),
      run_id: asString(row.run_id),
      ...(row.stage_id ? { stage_id: asString(row.stage_id) } : {}),
      ...(row.attempt_id ? { attempt_id: asString(row.attempt_id) } : {}),
      event_type: asString(row.event_type),
      timestamp: asString(row.timestamp),
      payload: JSON.parse(asString(row.payload_json)) as Record<string, unknown>
    }));
  }

  close(): void {
    this.#db.close();
  }
}
