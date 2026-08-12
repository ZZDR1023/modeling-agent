#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { Orchestrator } from "../orchestrator/orchestrator.js";

interface RootOptions {
  runsRoot: string;
}

function print(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) process.stdout.write(`${JSON.stringify(item)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function runSummary(result: Awaited<ReturnType<Orchestrator["run"]>>): Record<string, unknown> {
  return {
    run: result.run,
    status: result.status,
    workspacePath: result.workspacePath,
    taskCount: result.taskResults.length,
    successfulTaskCount: result.taskResults.filter((item) => item.status === "success").length,
    evidenceNodeCount: result.evidence.nodes.length,
    reportMarkdown: result.report.reportMarkdown,
    reportTex: result.report.reportTex,
    reportPdf: result.report.reportPdf,
    pdfStatus: result.report.pdfStatus,
    projectArchive: result.projectArchive
  };
}

function orchestrator(command: Command): Orchestrator {
  const root = command.optsWithGlobals<RootOptions>().runsRoot;
  return new Orchestrator({ runsRoot: resolve(root) });
}

const program = new Command();
program
  .name("modeling-agent")
  .description("Run and inspect evidence-backed mathematical modeling projects.")
  .option("--runs-root <path>", "Run database and workspace root", process.env.MODELING_AGENT_RUNS_ROOT ?? "runs");

program.command("run")
  .description("Run a problem package through the full local lifecycle.")
  .argument("<package-path>")
  .option("--runtime <kind>", "fake or pi", "fake")
  .option("--execution <kind>", "local or docker", "local")
  .option("--provider <provider>")
  .option("--model <model>")
  .option("--thinking-level <level>")
  .option("--json", "Print structured JSON")
  .action(async (packagePath: string, options: { runtime: string; execution: string; provider?: string; model?: string; thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; json?: boolean }, command: Command) => {
    if (options.runtime !== "fake" && options.runtime !== "pi") throw new Error(`Unsupported runtime: ${options.runtime}`);
    if (options.execution !== "local" && options.execution !== "docker") throw new Error(`Unsupported execution kind: ${options.execution}`);
    const result = await orchestrator(command).run(packagePath, {
      runtimeKind: options.runtime,
      executionKind: options.execution,
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {})
    });
    print(runSummary(result), options.json ?? false);
  });

program.command("list")
  .description("List known runs.")
  .option("--json", "Print structured JSON")
  .action((options: { json?: boolean }, command: Command) => {
    print(orchestrator(command).listRuns(), options.json ?? false);
  });

program.command("show")
  .description("Show a run and its append-only event log.")
  .argument("<run-id>")
  .option("--json", "Print structured JSON")
  .action((id: string, options: { json?: boolean }, command: Command) => {
    print(orchestrator(command).showRun(id), options.json ?? false);
  });

program.command("export")
  .description("Copy and verify a completed project archive.")
  .argument("<run-id>")
  .argument("[destination]")
  .option("--json", "Print structured JSON")
  .action(async (id: string, destination: string | undefined, options: { json?: boolean }, command: Command) => {
    print(await orchestrator(command).exportRun(id, destination), options.json ?? false);
  });

program.command("reproduce")
  .description("Re-run a completed run from its frozen package and execution settings.")
  .argument("<run-id>")
  .option("--json", "Print structured JSON")
  .action(async (id: string, options: { json?: boolean }, command: Command) => {
    const result = await orchestrator(command).reproduce(id);
    print({ sourceRunId: result.sourceRunId, ...runSummary(result) }, options.json ?? false);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ status: "failed", error: { class: "cli_failure", message } })}\n`);
  process.exitCode = 1;
});
