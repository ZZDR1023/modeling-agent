type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
import { FakeRuntimeAdapter } from "./fake-runtime.js";
import { PiRuntimeAdapter } from "./pi-runtime.js";
import type { AgentRuntime } from "./types.js";

export interface RuntimeFactoryOptions {
  kind: "fake" | "pi";
  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

export function createRuntime(options: RuntimeFactoryOptions): AgentRuntime {
  if (options.kind === "fake") return new FakeRuntimeAdapter();
  return new PiRuntimeAdapter({
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {})
  });
}
