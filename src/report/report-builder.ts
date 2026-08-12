import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import type { EvidenceGraph, ExperimentResult, ProblemSpec, TaskGraph } from "../contracts/types.js";
import { writeJsonAtomic } from "../infrastructure/json-files.js";
import { createFallbackPdf } from "./pdf.js";

export interface ReportBuildInput {
  runId: string;
  projectRoot: string;
  reproduction: {
    packagePath: string;
    runtimeKind: "fake" | "pi";
    executionKind: "local" | "docker";
  };
  problem: ProblemSpec;
  graph: TaskGraph;
  evaluationContracts: Record<string, unknown>;
  taskResults: ExperimentResult[];
  evidence: EvidenceGraph;
  inputFiles: Array<{ source: string; relativePath: string }>;
}

export interface PdfStatus {
  status: "success";
  renderer: "xelatex" | "builtin";
  warning?: { class: string; message: string };
}

export interface ReportBuildResult {
  projectRoot: string;
  reportMarkdown: string;
  reportTex: string;
  reportPdf?: string;
  pdfStatus: PdfStatus;
  warnings: string[];
}

function escapeTex(value: string): string {
  return value
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([#$%&_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

function metricLines(result: ExperimentResult): string[] {
  const values = Object.entries(result.metrics).map(([name, value]) => `${name}: ${String(value)}`);
  return values.length > 0 ? values : ["No scalar metrics were produced."];
}

function markdown(input: ReportBuildInput): string {
  const lines = [
    `# ${input.problem.title}`,
    "",
    "## Scope",
    "",
    input.problem.summary,
    "",
    "## Frozen Requirements",
    ""
  ];
  for (const requirement of input.problem.requirements) lines.push(`- ${requirement.id}: ${requirement.text}`);
  lines.push("", "## Experiment Results", "");
  for (const result of input.taskResults) {
    lines.push(`### ${result.task_id} (${result.plugin_id})`, "", `Status: **${result.status}**`);
    if (result.selected_method) lines.push("", `Selected method: ${result.selected_method}`);
    lines.push("", "Metrics:");
    for (const metric of metricLines(result)) lines.push(`- ${metric}`);
    if (result.error) lines.push("", `Failure: ${result.error.class}: ${result.error.message}`);
    if (result.warnings.length) {
      lines.push("", "Warnings:");
      for (const warning of result.warnings) lines.push(`- ${warning}`);
    }
    lines.push("");
  }
  lines.push("## Evidence", "", `The evidence graph contains ${input.evidence.nodes.length} nodes and ${input.evidence.edges.length} edges.`, "", "## Reproducibility", "", "Frozen inputs, task graph, evaluation contracts, results, and generated artifacts are included under project/reproducibility/.");
  return `${lines.join("\n")}\n`;
}

function tex(input: ReportBuildInput): string {
  const sections = input.taskResults.map((result) => {
    const metrics = metricLines(result).map((line) => `\\item ${escapeTex(line)}`).join("\n");
    const failure = result.error ? `\\paragraph{Failure} ${escapeTex(`${result.error.class}: ${result.error.message}`)}` : "";
    return `\\subsection*{${escapeTex(`${result.task_id} (${result.plugin_id})`)}}
Status: \\textbf{${escapeTex(result.status)}}.
${result.selected_method ? `Selected method: \\texttt{${escapeTex(result.selected_method)}}.` : ""}
\\begin{itemize}
${metrics}
\\end{itemize}
${failure}`;
  }).join("\n\n");
  const requirements = input.problem.requirements.map((item) => `\\item ${escapeTex(`${item.id}: ${item.text}`)}`).join("\n");
  return `\\documentclass[11pt]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{fontspec}
\\title{${escapeTex(input.problem.title)}}
\\date{}
\\begin{document}
\\maketitle
\\section*{Scope}
${escapeTex(input.problem.summary)}
\\section*{Frozen Requirements}
\\begin{itemize}
${requirements}
\\end{itemize}
\\section*{Experiment Results}
${sections}
\\section*{Evidence}
The evidence graph contains ${input.evidence.nodes.length} nodes and ${input.evidence.edges.length} edges.
\\section*{Reproducibility}
Frozen inputs, contracts, results, and generated artifacts are included with this project.
\\end{document}
`;
}

function execute(command: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stderr });
    });
  });
}

async function buildPdf(texPath: string, reportPath: string, title: string, outputDirectory: string): Promise<PdfStatus> {
  const reportPdf = resolve(outputDirectory, "report.pdf");
  try {
    const result = await execute("xelatex", ["-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-output-directory", outputDirectory, texPath], outputDirectory, 120_000);
    if (result.code === 0) return { status: "success", renderer: "xelatex" };
    const message = result.stderr.trim().slice(0, 2000) || `xelatex exited with ${result.code}.`;
    await writeFile(reportPdf, createFallbackPdf(title, await readFile(reportPath, "utf8")), { mode: 0o600 });
    return { status: "success", renderer: "builtin", warning: { class: "xelatex_failure", message } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeFile(reportPdf, createFallbackPdf(title, await readFile(reportPath, "utf8")), { mode: 0o600 });
    return { status: "success", renderer: "builtin", warning: { class: "xelatex_unavailable", message } };
  }
}

export class ReportBuilder {
  async build(input: ReportBuildInput): Promise<ReportBuildResult> {
    const projectRoot = resolve(input.projectRoot);
    const deliverables = resolve(projectRoot, "deliverables");
    const reproducibility = resolve(projectRoot, "reproducibility");
    await Promise.all([mkdir(deliverables, { recursive: true }), mkdir(reproducibility, { recursive: true })]);
    const reportMarkdown = resolve(deliverables, "report.md");
    const reportTex = resolve(deliverables, "report.tex");
    await Promise.all([
      writeFile(reportMarkdown, markdown(input), { encoding: "utf8", mode: 0o600 }),
      writeFile(reportTex, tex(input), { encoding: "utf8", mode: 0o600 }),
      writeJsonAtomic(resolve(reproducibility, "problem-spec.json"), input.problem),
      writeJsonAtomic(resolve(reproducibility, "task-graph.json"), input.graph),
      writeJsonAtomic(resolve(reproducibility, "evaluation-contracts.json"), input.evaluationContracts),
      writeJsonAtomic(resolve(reproducibility, "evidence-graph.json"), input.evidence),
      writeJsonAtomic(resolve(reproducibility, "experiment-results.json"), input.taskResults),
      writeJsonAtomic(resolve(reproducibility, "reproduce.json"), {
        schema_version: "1.0.0",
        source_run_id: input.runId,
        package_path: input.reproduction.packagePath,
        runtime_kind: input.reproduction.runtimeKind,
        execution_kind: input.reproduction.executionKind,
        command: `npm run cli -- reproduce ${input.runId}`
      })
    ]);
    const inputRoot = resolve(reproducibility, "inputs");
    for (const file of input.inputFiles) {
      const destination = resolve(inputRoot, file.relativePath);
      if (destination !== inputRoot && !destination.startsWith(`${inputRoot}/`)) {
        throw new Error(`Unsafe reproducibility input path: ${file.relativePath}`);
      }
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(file.source, destination);
    }
    const pdfStatus = await buildPdf(reportTex, reportMarkdown, input.problem.title, deliverables);
    const reportPdf = resolve(deliverables, "report.pdf");
    const warnings = pdfStatus.warning ? [`${pdfStatus.warning.class}: ${pdfStatus.warning.message}`] : [];
    const generated = resolve(deliverables, `${basename(reportTex, ".tex")}.pdf`);
    if (pdfStatus.renderer === "xelatex" && generated !== reportPdf) await copyFile(generated, reportPdf);
    await writeJsonAtomic(resolve(deliverables, "report-status.json"), pdfStatus);
    return { projectRoot, reportMarkdown, reportTex, reportPdf, pdfStatus, warnings };
  }
}
