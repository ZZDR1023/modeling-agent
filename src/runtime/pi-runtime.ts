import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader
} from "@earendil-works/pi-coding-agent";
import type { InputSource } from "@earendil-works/pi-coding-agent";

type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
import { SchemaRegistry } from "../contracts/schema-registry.js";
import { extractJson } from "./json-output.js";
import type { AgentRuntime, StageRequest, StageResponse } from "./types.js";

function isolatedResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {}
  };
}

export interface PiRuntimeOptions {
  agentDir?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

export class PiRuntimeAdapter implements AgentRuntime {
  readonly kind = "pi" as const;
  readonly #schemas: SchemaRegistry;
  readonly #options: PiRuntimeOptions;
  #modelRuntime: ModelRuntime | undefined;

  constructor(options: PiRuntimeOptions = {}, schemas = new SchemaRegistry()) {
    this.#options = options;
    this.#schemas = schemas;
  }

  async run<T>(request: StageRequest): Promise<StageResponse<T>> {
    const started = performance.now();
    const modelRuntime = await this.#getModelRuntime();
    const configuredModel = this.#options.provider && this.#options.model
      ? modelRuntime.getModel(this.#options.provider, this.#options.model)
      : undefined;
    if (this.#options.provider && this.#options.model && !configuredModel) {
      throw new Error(`Configured model not found: ${this.#options.provider}/${this.#options.model}`);
    }

    const settings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 }
    });
    const loader = isolatedResourceLoader(request.systemPrompt);
    const createOptions = {
      noTools: "all" as const,
      modelRuntime,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
      settingsManager: settings,
      ...(configuredModel ? { model: configuredModel } : {}),
      ...(this.#options.thinkingLevel ? { thinkingLevel: this.#options.thinkingLevel } : {})
    };
    const { session } = await createAgentSession(createOptions);
    let text = "";
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        text += event.assistantMessageEvent.delta;
      }
    });
    const abort = () => void session.abort();
    request.signal?.addEventListener("abort", abort, { once: true });

    try {
      await session.prompt(`${request.prompt}\n\nCONTEXT_JSON:\n${JSON.stringify(request.context)}`, {
        expandPromptTemplates: false,
        source: "extension" as InputSource
      });
      if (!text.trim()) {
        const assistant = [...session.messages].reverse().find((message) => message.role === "assistant");
        if (assistant && Array.isArray(assistant.content)) {
          text = assistant.content
            .filter((part): part is { type: "text"; text: string } => part.type === "text")
            .map((part) => part.text)
            .join("");
        }
      }
      const parsed = extractJson(text);
      const value = request.outputSchema ? this.#schemas.validate<T>(request.outputSchema, parsed) : (parsed as T);
      const stats = session.getSessionStats();
      return {
        value,
        rawText: text,
        runtimeKind: "pi",
        model: session.model?.id ?? "unknown",
        provider: session.model?.provider ?? "unknown",
        usage: {
          inputTokens: stats.tokens.input,
          outputTokens: stats.tokens.output,
          cacheReadTokens: stats.tokens.cacheRead,
          cacheWriteTokens: stats.tokens.cacheWrite,
          cost: stats.cost
        },
        durationMs: Math.round(performance.now() - started)
      };
    } finally {
      request.signal?.removeEventListener("abort", abort);
      unsubscribe();
      session.dispose();
      await settings.flush();
    }
  }

  async dispose(): Promise<void> {
    this.#modelRuntime = undefined;
  }

  async #getModelRuntime(): Promise<ModelRuntime> {
    if (!this.#modelRuntime) {
      const options = this.#options.agentDir ? { authPath: `${this.#options.agentDir}/auth.json`, modelsPath: `${this.#options.agentDir}/models.json` } : undefined;
      this.#modelRuntime = await ModelRuntime.create(options);
    }
    return this.#modelRuntime;
  }
}
