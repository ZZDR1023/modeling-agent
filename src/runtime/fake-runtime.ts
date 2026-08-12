import { basename, extname } from "node:path";
import type { DataAsset, ProblemRequirement, ProblemSpec, TaskGraph, TaskNode, TaskType } from "../contracts/types.js";
import { SchemaRegistry } from "../contracts/schema-registry.js";
import type { AgentRuntime, StageRequest, StageResponse } from "./types.js";

interface ParserContext {
  packageName: string;
  problemText: string;
  dataAssets: DataAsset[];
}

interface PlannerContext {
  problem: ProblemSpec;
  taskConfigs?: Record<string, Record<string, unknown>>;
}

const keywordRules: Array<[TaskType, RegExp]> = [
  ["time_series_forecasting", /(时间序列|未来.{0,8}预测|趋势预测|forecast|time series)/i],
  ["classification", /(分类|判别|类别|classification|classify)/i],
  ["clustering", /(聚类|分群|cluster)/i],
  ["evaluation_ranking", /(综合评价|评价排序|评价与排序|排名|权重|topsis|层次分析|熵权|evaluation(?: and)? ranking)/i],
  ["optimization", /(优化|最优|调度|分配方案|规划模型|optimization|minimi[sz]e|maximi[sz]e)/i],
  ["simulation", /(仿真|模拟|蒙特卡洛|微分方程|simulation|monte carlo)/i],
  ["regression_prediction", /(回归|预测|拟合|regression|prediction)/i],
  ["statistical_analysis", /(统计|相关|检验|差异|影响因素|statistics?|statistical|correlation|test)/i]
];

function splitRequirements(text: string): ProblemRequirement[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const candidates = lines.filter((line) =>
    /^(?:#{1,4}\s*)?(?:问题|任务|question|task)\s*[一二三四五六七八九十0-9]+[：:.、\s]/i.test(line)
      || /^(?:[（(]?[0-9一二三四五六七八九十]+[）).、])\s*\S+/.test(line)
  );
  const selected = candidates.length > 0 ? candidates : [lines.find((line) => !line.startsWith("#")) ?? text.slice(0, 1000)];
  return selected.map((line, index) => ({
    id: `req-${String(index + 1).padStart(3, "0")}`,
    kind: "question",
    text: line.replace(/^#+\s*/, ""),
    required: true,
    source_excerpt: line
  }));
}

function classifyAll(text: string): TaskType[] {
  const matches = keywordRules.filter(([, pattern]) => pattern.test(text)).map(([type]) => type);
  if (/(custom experiment|custom method|experimental fallback|自定义实验|自定义方法)/i.test(text)) {
    matches.push("custom_experiment");
  }
  return [...new Set(matches.length > 0 ? matches : ["custom_experiment"] as TaskType[])];
}

function inferLanguage(text: string): ProblemSpec["language"] {
  const chinese = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (chinese > 0 && latin > 0) return chinese > latin * 2 ? "zh" : "mixed";
  if (chinese > 0) return "zh";
  if (latin > 0) return "en";
  return "unknown";
}

function titleFromText(text: string, fallback: string): string {
  const heading = text.split(/\r?\n/).find((line) => /^#\s+\S/.test(line.trim()));
  return heading?.replace(/^#\s+/, "").trim() ?? fallback;
}

function inferDefaultConfig(type: TaskType, assets: DataAsset[]): Record<string, unknown> {
  const table = assets.find((asset) => [".csv", ".xlsx", ".xls", ".json", ".parquet"].includes(extname(asset.relative_path).toLowerCase()));
  const base = table ? { data_file: table.relative_path } : {};
  if (type === "regression_prediction" || type === "time_series_forecasting") return { ...base, target_column: "target" };
  if (type === "classification") return { ...base, target_column: "class" };
  if (type === "optimization") return { ...base, objective: "maximize target" };
  if (type === "simulation" || type === "custom_experiment") return { ...base, target_column: "target", operation: "bootstrap_mean" };
  return base;
}

export class FakeRuntimeAdapter implements AgentRuntime {
  readonly kind = "fake" as const;
  readonly #schemas: SchemaRegistry;

  constructor(schemas = new SchemaRegistry()) {
    this.#schemas = schemas;
  }

  async run<T>(request: StageRequest): Promise<StageResponse<T>> {
    const started = performance.now();
    if (request.signal?.aborted) throw new DOMException("Runtime call aborted", "AbortError");

    let value: unknown;
    if (request.workerProfile === "problem_parser") {
      const context = request.context as ParserContext;
      const problem: ProblemSpec = {
        schema_version: "1.0.0",
        problem_id: context.packageName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "problem",
        title: titleFromText(context.problemText, basename(context.packageName)),
        summary: context.problemText.replace(/\s+/g, " ").slice(0, 4000),
        language: inferLanguage(context.problemText),
        requirements: splitRequirements(context.problemText),
        data_assets: context.dataAssets,
        external_data_policy: /(?:自行|外部|网络).{0,12}(?:收集|获取|查找).{0,8}数据/i.test(context.problemText)
          ? "required_pending_approval"
          : "forbidden"
      };
      value = problem;
    } else if (request.workerProfile === "task_planner") {
      const context = request.context as PlannerContext;
      const descriptors = context.problem.requirements
        .filter((requirement) => requirement.kind === "question")
        .flatMap((requirement) => classifyAll(requirement.text).map((taskType) => ({ requirement, taskType })));
      const nodes: TaskNode[] = descriptors.map(({ requirement, taskType }, index) => {
        const explicitConfig = context.taskConfigs?.[requirement.id] ?? {};
        return {
          id: `task-${String(index + 1).padStart(3, "0")}`,
          title: `${taskType}: ${requirement.text}`.slice(0, 200),
          task_type: taskType,
          objective: requirement.text,
          requirement_ids: [requirement.id],
          depends_on: [],
          input_artifact_ids: context.problem.data_assets.map((asset) => asset.artifact_id),
          evidence_level: taskType === "custom_experiment" ? "experimental" : "standard",
          budget: { max_attempts: 3, max_runtime_seconds: 900, max_tokens: Math.min(request.maxTokens, 32000) },
          config: { ...inferDefaultConfig(taskType, context.problem.data_assets), ...explicitConfig }
        };
      });
      value = {
        schema_version: "1.0.0",
        workflow_version: "0.1.0",
        problem_id: context.problem.problem_id,
        nodes
      } satisfies TaskGraph;
    } else {
      throw new Error(`Fake runtime has no deterministic handler for ${request.workerProfile}.`);
    }

    const validated = request.outputSchema ? this.#schemas.validate<T>(request.outputSchema, value) : (value as T);
    const rawText = JSON.stringify(value, null, 2);
    return {
      value: validated,
      rawText,
      runtimeKind: "fake",
      model: "deterministic-fixture-v1",
      provider: "local",
      usage: {
        inputTokens: Math.ceil((request.prompt.length + JSON.stringify(request.context).length) / 4),
        outputTokens: Math.ceil(rawText.length / 4),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0
      },
      durationMs: Math.round(performance.now() - started)
    };
  }

  async dispose(): Promise<void> {}
}
