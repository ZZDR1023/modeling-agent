import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowPath = ".github/workflows/ci.yml";
const ciBadgeMarkdown = "[![CI](https://github.com/ZZDR1023/modeling-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/ZZDR1023/modeling-agent/actions/workflows/ci.yml)";

function readmeExplanatoryText(source: string): string {
  let insideFence = false;
  return source
    .split("\n")
    .filter((line) => {
      if (line.trim().startsWith("```")) {
        insideFence = !insideFence;
        return false;
      }
      return !insideFence;
    })
    .join("\n")
    .replace(/`[^`\n]+`/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "");
}

interface WorkflowStep {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
}

interface WorkflowJob {
  "runs-on"?: string;
  permissions?: Record<string, unknown>;
  steps?: WorkflowStep[];
}

interface WorkflowTriggers {
  push?: { branches?: string[] };
  pull_request?: unknown;
}

interface Workflow {
  name?: string;
  on?: WorkflowTriggers;
  permissions?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
}

function workflowCommands(steps: WorkflowStep[]): string[] {
  return steps.flatMap((step) => typeof step.run === "string" ? [step.run] : []);
}

function stepUsing(steps: WorkflowStep[], action: string): WorkflowStep {
  const step = steps.find((candidate) => candidate.uses?.startsWith(`${action}@`));
  expect(step, `missing ${action} step`).toBeDefined();
  return step!;
}

function expectCommand(commands: string[], command: string): void {
  expect(commands.some((script) => script.split("\n").some((line) => line.trim() === command)), `missing exact command: ${command}`).toBe(true);
}

describe("repository engineering contract", () => {
  it("defines a structurally valid least-privilege CI job with pinned runtimes and npm lifecycle commands", async () => {
    const source = await readFile(workflowPath, "utf8");
    const workflow = parse(source) as Workflow;
    const jobs = Object.values(workflow.jobs ?? {});
    expect(jobs).toHaveLength(1);
    expect(workflow.on).toEqual({
      push: { branches: ["main"] },
      pull_request: null
    });

    const job = jobs[0]!;
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toBeUndefined();

    const steps = job.steps ?? [];
    expect(stepUsing(steps, "actions/checkout").uses).toBe("actions/checkout@v7");
    expect(stepUsing(steps, "actions/setup-node")).toMatchObject({
      uses: "actions/setup-node@v7",
      with: { "node-version": 24, cache: "npm" }
    });
    expect(stepUsing(steps, "actions/setup-python")).toMatchObject({
      uses: "actions/setup-python@v7",
      with: { "python-version": "3.11" }
    });

    const commands = workflowCommands(steps);
    for (const command of ["npm ci", "npm run check", "npm run build", "npm run smoke"]) {
      expectCommand(commands, command);
    }
  });

  it("reproduces the fresh smoke archive independently and machine-checks the complete result", async () => {
    const workflow = parse(await readFile(workflowPath, "utf8")) as Workflow;
    const steps = Object.values(workflow.jobs ?? {})[0]?.steps ?? [];
    const scripts = workflowCommands(steps).join("\n");

    expect(scripts).toContain("mktemp -d");
    expect(scripts).toContain("MODELING_AGENT_RUNS_ROOT");
    expect(scripts).toMatch(/find\s+"?\$\{?RUNS_ROOT\}?"?\s+-type f -name ['\"]project\\?\.zip['\"]/);
    expect(scripts).toMatch(/cp\s+.*project.*\.zip/i);
    expect(scripts).toMatch(/unzip\s+.*-d/);
    expect(scripts).toMatch(/rm\s+-rf\s+"?\$\{?RUNS_ROOT\}?"?/);
    expect(scripts).toContain("python3 reproduce.py");
    expect(scripts).toContain("reproduced/reproduction-result.json");
    expect(scripts).toContain("verified_artifact_count");
    expect(scripts).toContain("verified_task_count");
    expect(scripts).toContain("%PDF-");
    expect(scripts).toMatch(/status[^\n]*success/);
    expect(scripts).toMatch(/verified_task_count[^\n]*9/);
    expect(scripts).toMatch(/artifact[^\n]*40/i);
    expect(scripts).toContain('renderer = result.get("report_renderer")');
    expect(scripts).toContain('if renderer == "xelatex":');
    expect(scripts).toContain('elif renderer == "builtin":');
    expect(scripts).toMatch(/warning[^\n]*(?:None|null)/);
    expect(scripts).toContain('assert "xelatex" in normalized_warning, result');
    expect(scripts).toContain('assert "unavailable" in normalized_warning or "fail" in normalized_warning, result');
    expect(scripts).toContain('assert "bundled" in normalized_warning and "fallback" in normalized_warning, result');
    expect(scripts).toMatch(/reproduced[^\n]*report_pdf/);
    expect(scripts).not.toMatch(/run-[0-9]{8,}/);
    expect(scripts).not.toMatch(/docker\s+(?:build|push)|--runtime\s+pi|runs\.sqlite|secrets\./i);
  });

  it("documents the project primarily in Chinese and links the exact CI badge without a status legend", async () => {
    const readme = await readFile("README.md", "utf8");
    expect(readme).toContain(ciBadgeMarkdown);
    for (const removedLegendText of [
      "徽章说明",
      "绿色 / `passing`",
      "红色 / `failing`"
    ]) {
      expect(readme).not.toContain(removedLegendText);
    }

    for (const passage of [
      "## 架构",
      "## 开发状态",
      "## 前置条件",
      "## 完整命令",
      "## 安全边界",
      "## 许可证与材料版权",
      "当前版本并不成熟",
      "不代表具备获奖级表现",
      "任务族共 9 类",
      "本地执行路径是当前 alpha 阶段支持的基线",
      "每个导出的 `project.zip` 都是独立可复现的软件包"
    ]) {
      expect(readme).toContain(passage);
    }

    const explanatoryText = readmeExplanatoryText(readme);
    const chineseCharacterCount = explanatoryText.match(/\p{Script=Han}/gu)?.length ?? 0;
    const latinCharacterCount = explanatoryText.match(/[A-Za-z]/g)?.length ?? 0;
    expect(chineseCharacterCount, "README should contain substantial Chinese explanatory prose").toBeGreaterThan(500);
    expect(
      chineseCharacterCount / (chineseCharacterCount + latinCharacterCount),
      "Chinese characters should be the clear majority of non-code explanatory language characters"
    ).toBeGreaterThan(0.6);
  });

  it("carries the complete standard Apache License 2.0 text", async () => {
    const license = await readFile("LICENSE", "utf8");
    for (const passage of [
      "Apache License\n                           Version 2.0, January 2004",
      "1. Definitions.",
      "2. Grant of Copyright License.",
      "3. Grant of Patent License.",
      "4. Redistribution.",
      "5. Submission of Contributions.",
      "6. Trademarks.",
      "7. Disclaimer of Warranty.",
      "8. Limitation of Liability.",
      "9. Accepting Warranty or Additional Liability.",
      "END OF TERMS AND CONDITIONS",
      "APPENDIX: How to apply the Apache License to your work.",
      "Copyright 2026 modeling-agent contributors"
    ]) {
      expect(license).toContain(passage);
    }
    expect(license.length).toBeGreaterThan(10_000);
  });
});
