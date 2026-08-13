import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import type { RunEvent, RunStatus, RunSummary } from "../contracts/types.js";
import type { RunDetails, RunOptions, RunResult } from "../orchestrator/orchestrator.js";

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const COMPLETED_STATUSES = new Set<RunStatus>(["completed", "completed_with_warnings"]);
const RUN_FAILURE_MESSAGE = "The run failed. Inspect local run artifacts for details.";

export interface ServerRunResult {
  run: Pick<RunSummary, "id">;
}

export interface OrchestratorAdapter {
  listRuns(): RunSummary[] | Promise<RunSummary[]>;
  showRun(id: string): RunDetails | undefined | Promise<RunDetails | undefined>;
  run(packagePath: string, options: RunOptions): Promise<ServerRunResult | RunResult>;
  close?(): void | Promise<void>;
}

export interface BuildServerOptions {
  orchestrator: OrchestratorAdapter;
  host?: string;
  clock?: () => Date;
  jobId?: () => string;
  logger?: boolean;
}

interface CreateRunBody {
  packagePath: string;
  runtime?: "fake" | "pi";
  execution?: "local" | "docker";
  provider?: string;
  model?: string;
  thinking?: (typeof THINKING_LEVELS)[number];
}

interface RunParams {
  id: string;
}

type JobStatus = "queued" | "running" | "succeeded" | "failed";

interface JobRecord {
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  runId?: string;
  error?: ErrorBody;
}

interface ErrorBody {
  class: string;
  message: string;
}

interface PublicRun {
  id: string;
  runtimeKind: RunSummary["runtime_kind"];
  executionKind: RunSummary["execution_kind"];
  status: RunStatus;
  currentStage: string;
  createdAt: string;
  updatedAt: string;
  archiveAvailable: boolean;
  error?: ErrorBody;
}

interface PublicEvent {
  id?: number;
  stageId?: string;
  attemptId?: string;
  eventType: string;
  timestamp: string;
}

class HttpError extends Error {
  readonly statusCode: number;
  readonly errorClass: string;

  constructor(statusCode: number, errorClass: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.errorClass = errorClass;
  }
}

const createRunSchema = {
  type: "object",
  additionalProperties: false,
  required: ["packagePath"],
  properties: {
    packagePath: { type: "string", minLength: 1, maxLength: 4096 },
    runtime: { type: "string", enum: ["fake", "pi"] },
    execution: { type: "string", enum: ["local", "docker"] },
    provider: { type: "string", minLength: 1, maxLength: 128, pattern: "^[^\\u0000-\\u001F\\u007F]+$" },
    model: { type: "string", minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u001F\\u007F]+$" },
    thinking: { type: "string", enum: THINKING_LEVELS }
  }
} as const;

const runParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9._-]+$" }
  }
} as const;

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  return match !== null && match.slice(1).every((part) => Number(part) <= 255);
}

function errorEnvelope(errorClass: string, message: string): { status: "failed"; error: ErrorBody } {
  return { status: "failed", error: { class: errorClass, message } };
}

function isUnknownRunError(error: unknown): boolean {
  return error instanceof Error && /^Unknown run(?::|\b)/i.test(error.message);
}

async function getRun(orchestrator: OrchestratorAdapter, id: string): Promise<RunDetails | undefined> {
  try {
    return await orchestrator.showRun(id);
  } catch (error) {
    if (isUnknownRunError(error)) return undefined;
    throw error;
  }
}

function publicRun(run: RunSummary): PublicRun {
  const result: PublicRun = {
    id: run.id,
    runtimeKind: run.runtime_kind,
    executionKind: run.execution_kind,
    status: run.status,
    currentStage: run.current_stage,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    archiveAvailable: COMPLETED_STATUSES.has(run.status) && run.project_archive !== null
  };
  if (run.status === "failed") result.error = { class: "run_failure", message: RUN_FAILURE_MESSAGE };
  return result;
}

function publicEvent(event: RunEvent): PublicEvent {
  return {
    ...(event.id === undefined ? {} : { id: event.id }),
    ...(event.stage_id === undefined ? {} : { stageId: event.stage_id }),
    ...(event.attempt_id === undefined ? {} : { attemptId: event.attempt_id }),
    eventType: event.event_type,
    timestamp: event.timestamp
  };
}

function publicJob(job: JobRecord): JobRecord {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.runId === undefined ? {} : { runId: job.runId }),
    ...(job.error === undefined ? {} : { error: job.error })
  };
}

function runOptions(body: CreateRunBody): RunOptions {
  return {
    runtimeKind: body.runtime ?? "fake",
    executionKind: body.execution ?? "local",
    ...(body.provider === undefined ? {} : { provider: body.provider }),
    ...(body.model === undefined ? {} : { model: body.model }),
    ...(body.thinking === undefined ? {} : { thinkingLevel: body.thinking })
  };
}

const ARCHIVE_GONE_MESSAGE = "The project archive is no longer available.";
const ARCHIVE_UNAVAILABLE_CODES = new Set(["EACCES", "ELOOP", "ENOENT", "ENOTDIR", "EPERM"]);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function isArchiveUnavailable(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && ARCHIVE_UNAVAILABLE_CODES.has(code);
}

function isWithin(root: string, candidate: string): boolean {
  const candidateRelative = relative(root, candidate);
  return candidateRelative === ""
    || (!isAbsolute(candidateRelative) && candidateRelative !== ".." && !candidateRelative.startsWith(`..${sep}`));
}

function archiveGone(): HttpError {
  return new HttpError(410, "archive_gone", ARCHIVE_GONE_MESSAGE);
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  return typeof error.statusCode === "number" ? error.statusCode : undefined;
}

function hasZipSignature(signature: Buffer, bytesRead: number): boolean {
  if (bytesRead < 4 || signature[0] !== 0x50 || signature[1] !== 0x4b) return false;
  return (signature[2] === 0x03 && signature[3] === 0x04)
    || (signature[2] === 0x05 && signature[3] === 0x06)
    || (signature[2] === 0x07 && signature[3] === 0x08);
}

interface OpenArchive {
  handle: FileHandle;
  size: number;
}

async function openArchive(workspacePath: string, archivePath: string): Promise<OpenArchive> {
  const workspaceRoot = resolve(workspacePath);
  const candidatePath = resolve(archivePath);
  if (!isWithin(workspaceRoot, candidatePath) || candidatePath === workspaceRoot) throw archiveGone();

  let canonicalWorkspace: string;
  try {
    canonicalWorkspace = await realpath(workspaceRoot);
  } catch (error) {
    if (isArchiveUnavailable(error)) throw archiveGone();
    throw error;
  }

  let workspaceHandle: FileHandle | undefined;
  let archiveHandle: FileHandle | undefined;
  try {
    workspaceHandle = await open(
      workspaceRoot,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
    );
    const openedWorkspace = await realpath(`/proc/self/fd/${workspaceHandle.fd}`);
    const workspaceStat = await workspaceHandle.stat({ bigint: true });
    if (openedWorkspace !== canonicalWorkspace || !workspaceStat.isDirectory()) throw archiveGone();

    const archiveRelative = relative(workspaceRoot, candidatePath);
    archiveHandle = await open(
      `/proc/self/fd/${workspaceHandle.fd}/${archiveRelative}`,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
    );
    const canonicalArchive = await realpath(`/proc/self/fd/${archiveHandle.fd}`);
    if (!isWithin(canonicalWorkspace, canonicalArchive) || canonicalArchive === canonicalWorkspace) {
      throw archiveGone();
    }

    const archiveStat = await archiveHandle.stat();
    const stableWorkspaceStat = await workspaceHandle.stat({ bigint: true });
    if (workspaceStat.dev !== stableWorkspaceStat.dev || workspaceStat.ino !== stableWorkspaceStat.ino) {
      throw archiveGone();
    }
    if (!archiveStat.isFile()) throw archiveGone();
    const signature = Buffer.alloc(4);
    const { bytesRead } = await archiveHandle.read(signature, 0, signature.length, 0);
    if (!hasZipSignature(signature, bytesRead)) throw archiveGone();

    const result = { handle: archiveHandle, size: archiveStat.size };
    archiveHandle = undefined;
    return result;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (isArchiveUnavailable(error)) throw archiveGone();
    throw error;
  } finally {
    await archiveHandle?.close().catch(() => undefined);
    await workspaceHandle?.close().catch(() => undefined);
  }
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error(`Refusing unauthenticated non-loopback host: ${host}`);
  }

  const clock = options.clock ?? (() => new Date());
  const nextJobId = options.jobId ?? (() => `job-${randomUUID()}`);
  const jobs = new Map<string, JobRecord>();
  const activeRuns = new Set<Promise<void>>();
  const server = Fastify({
    logger: options.logger ?? false,
    ajv: {
      customOptions: { coerceTypes: false, removeAdditional: false }
    }
  });

  server.setErrorHandler((error, request, reply) => {
    if ((typeof error === "object" && error !== null && "validation" in error && error.validation) || statusCode(error) === 400) {
      void reply.status(400).send(errorEnvelope("invalid_request", "Request validation failed."));
      return;
    }
    if (statusCode(error) === 415) {
      void reply.status(415).send(errorEnvelope("unsupported_media_type", "Content-Type must be application/json."));
      return;
    }
    if (error instanceof HttpError) {
      void reply.status(error.statusCode).send(errorEnvelope(error.errorClass, error.message));
      return;
    }
    request.log.error({ err: error }, "Request failed");
    void reply.status(500).send(errorEnvelope("internal_error", "The server could not complete the request."));
  });

  server.setNotFoundHandler((_request, reply) => reply
    .status(404)
    .send(errorEnvelope("route_not_found", "Route not found.")));

  server.get("/health", async () => ({ status: "ok" }));

  server.get("/api/runs", async () => ({
    status: "ok",
    runs: (await options.orchestrator.listRuns()).map(publicRun)
  }));

  server.get<{ Params: RunParams }>("/api/runs/:id", { schema: { params: runParamsSchema } }, async (request) => {
    const details = await getRun(options.orchestrator, request.params.id);
    if (!details) throw new HttpError(404, "run_not_found", "Run not found.");
    return {
      status: "ok",
      run: publicRun(details.run),
      events: details.events.map(publicEvent)
    };
  });

  server.post<{ Body: CreateRunBody }>("/api/runs", { schema: { body: createRunSchema } }, async (request, reply) => {
    const id = nextJobId();
    if (jobs.has(id)) {
      throw new HttpError(409, "job_id_conflict", "A job with the generated id already exists.");
    }
    const timestamp = clock().toISOString();
    const job: JobRecord = { id, status: "queued", createdAt: timestamp, updatedAt: timestamp };
    jobs.set(id, job);

    let task!: Promise<void>;
    task = Promise.resolve().then(async () => {
      job.status = "running";
      job.updatedAt = clock().toISOString();
      try {
        const result = await options.orchestrator.run(request.body.packagePath, runOptions(request.body));
        job.status = "succeeded";
        job.runId = result.run.id;
        job.updatedAt = clock().toISOString();
      } catch {
        job.status = "failed";
        job.error = { class: "run_failure", message: RUN_FAILURE_MESSAGE };
        job.updatedAt = clock().toISOString();
      }
    }).finally(() => {
      activeRuns.delete(task);
    });
    activeRuns.add(task);

    return reply.status(202).send({ status: "accepted", job: publicJob(job) });
  });

  server.get<{ Params: RunParams }>("/api/jobs/:id", { schema: { params: runParamsSchema } }, async (request) => {
    const job = jobs.get(request.params.id);
    if (!job) throw new HttpError(404, "job_not_found", "Job not found.");
    return { status: "ok", job: publicJob(job) };
  });

  server.get<{ Params: RunParams }>("/api/runs/:id/archive", { schema: { params: runParamsSchema } }, async (request, reply) => {
    const details = await getRun(options.orchestrator, request.params.id);
    if (!details) throw new HttpError(404, "run_not_found", "Run not found.");
    const archive = details.run.project_archive;
    if (!COMPLETED_STATUSES.has(details.run.status) || archive === null) {
      throw new HttpError(409, "archive_not_ready", "The run does not have a completed project archive.");
    }
    const openedArchive = await openArchive(details.run.workspace_path, archive);
    const archiveStream = openedArchive.handle.createReadStream({ autoClose: true, start: 0 });
    const filename = "project.zip";
    return reply
      .type("application/zip")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .header("Content-Length", String(openedArchive.size))
      .send(archiveStream);
  });

  server.addHook("onClose", async () => {
    await Promise.allSettled([...activeRuns]);
    await options.orchestrator.close?.();
  });

  return server;
}

export type { FastifyInstance, FastifyReply, FastifyRequest };
