import { SchemaRegistry } from "../contracts/schema-registry.js";
import { FakeRuntimeAdapter } from "./fake-runtime.js";
import { PiRuntimeAdapter } from "./pi-runtime.js";
import type { AgentRuntime } from "./types.js";

type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RuntimeFactoryOptions {
  kind: "fake" | "pi";
  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

export function createRuntime(options: RuntimeFactoryOptions, schemas = new SchemaRegistry()): AgentRuntime {
  if (options.kind === "fake") return new FakeRuntimeAdapter(schemas);
  return new PiRuntimeAdapter({
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {})
  }, schemas);
}
