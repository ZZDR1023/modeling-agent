import type { SchemaName } from "../contracts/schema-registry.js";

export type WorkerProfile = "problem_parser" | "task_planner" | "report_writer" | "diagnostic";

export interface StageRequest<TContext = unknown> {
  runId: string;
  stageId: string;
  workerProfile: WorkerProfile;
  systemPrompt: string;
  prompt: string;
  context: TContext;
  outputSchema?: SchemaName;
  maxTokens: number;
  signal?: AbortSignal;
}

export interface RuntimeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

export interface StageResponse<T> {
  value: T;
  rawText: string;
  runtimeKind: "fake" | "pi";
  model: string;
  provider: string;
  usage: RuntimeUsage;
  durationMs: number;
}

export interface AgentRuntime {
  readonly kind: "fake" | "pi";
  run<T>(request: StageRequest): Promise<StageResponse<T>>;
  dispose(): Promise<void>;
}
