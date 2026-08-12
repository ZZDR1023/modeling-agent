import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, relative, resolve, sep } from "node:path";
import type { EvidenceGraph, EvidenceNode, ExperimentResult, ProblemSpec, TaskGraph } from "../contracts/types.js";
import { fileIdentity, sha256Text } from "../infrastructure/hash.js";
import { writeJsonAtomic } from "../infrastructure/json-files.js";
import { createFallbackPdf } from "./pdf.js";

export interface ReportBuildInput {
  runId: string;
  projectRoot: string;
  reproduction: {
    runtimeKind: "fake" | "pi";
    executionKind: "local" | "docker";
  };
  pythonVersion?: string;
  problem: ProblemSpec;
  graph: TaskGraph;
  evaluationContracts: Record<string, unknown>;
  taskResults: ExperimentResult[];
  evidence: EvidenceGraph;
  inputFiles: Array<{ source: string; relativePath: string }>;
  committedExperimentsRoot: string;
  pythonSourceRoot: string;
  pythonRequirementsPath: string;
  pythonDockerfilePath: string;
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

interface TaskEvidence {
  metrics: EvidenceNode[];
  artifacts: EvidenceNode[];
}

interface ReproductionFile {
  path: string;
  sha256: string;
  size_bytes: number;
}

interface ReproductionTask {
  task_id: string;
  attempt_id: string;
  request: string;
  expected_result: string;
  expected_artifacts: ReproductionFile[];
}

function escapeTex(value: string): string {
  return value
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([#$%&_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

function taskIdFromEvidence(node: EvidenceNode): string | undefined {
  const metricMatch = /^([^\.]+)\./.exec(node.label);
  if (metricMatch?.[1]) return metricMatch[1];
  const artifactMatch = /^([^:]+):\s/.exec(node.label);
  if (artifactMatch?.[1]) return artifactMatch[1];
  const claimMatch = /^(\S+)\s/.exec(node.label);
  return claimMatch?.[1];
}

function evidenceForTask(evidence: EvidenceGraph, taskId: string): TaskEvidence {
  const nodes = evidence.nodes.filter((node) => taskIdFromEvidence(node) === taskId);
  return {
    metrics: nodes.filter((node) => node.kind === "metric").sort((left, right) => left.label.localeCompare(right.label)),
    artifacts: nodes.filter((node) => node.kind === "figure" || node.kind === "table").sort((left, right) => left.label.localeCompare(right.label))
  };
}

function evidenceMetricLines(evidence: TaskEvidence): string[] {
  const values = evidence.metrics.map((node) => {
    const name = node.label.includes(".") ? node.label.slice(node.label.indexOf(".") + 1) : node.label;
    return `${name}: ${String(node.value)} (\`${node.id}\`)`;
  });
  return values.length > 0 ? values : ["No scalar metric evidence was produced."];
}

function artifactDisplay(node: EvidenceNode): string {
  return typeof node.value === "string" ? node.value : node.label;
}

function projectReadme(pythonVersion: string): string {
  return `# Reproducible Modeling Project

This archive is a standalone snapshot of a completed modeling project. It contains the final report, frozen inputs and experiment records, the Python execution source, and manifests used to verify reproduced outputs.

## Contents

- \`deliverables/\`: frozen report source, PDF, and renderer status.
- \`reproducibility/inputs/\`: frozen problem statement and input data.
- \`reproducibility/experiments/\`: frozen requests, expected results, figures, tables, and JSON artifacts.
- \`reproducibility/python/\`: packaged experiment runtime source.
- \`reproducibility/environment/\`: locked Python dependencies and the standalone Dockerfile.
- \`reproduce.py\`: package verification, experiment replay, artifact hash checks, and PDF rebuild.

## Local reproduction

Python ${pythonVersion} is required. From the extracted project root, create an isolated environment and install the locked dependencies (this installation requires access to a compatible Python package index unless the wheels are already cached):

\`\`\`sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r reproducibility/environment/requirements.lock
\`\`\`

Run the single reproduction command from the extracted project root:

\`\`\`sh
python3 reproduce.py
\`\`\`

A successful run prints a JSON object with \`"status": "success"\`, reports all frozen tasks as verified, and writes \`reproduced/reproduction-result.json\` plus \`reproduced/deliverables/report.pdf\`.

## Docker reproduction

Use the extracted project root as the build context. Building needs network access to download the base image and locked Python packages unless both are already cached; running the completed image does not require network access.

On Linux, create the host output directory and run the container with your numeric user and group IDs:

\`\`\`sh
docker build -f reproducibility/environment/Dockerfile -t modeling-project-reproducer .
mkdir -p reproduced
docker run --rm --user "\$(id -u):\$(id -g)" --mount type=bind,src="\$(pwd)/reproduced",dst=/opt/modeling-project/reproduced modeling-project-reproducer
\`\`\`

The bind mount keeps reproduced outputs on the host after the ephemeral container exits. The command uses Linux \`id\` and POSIX shell substitution; on Docker Desktop for macOS or Windows, create an equivalent host directory, use a path accepted by that shell, and omit or adapt \`--user\` if numeric Linux IDs are unavailable.

## Offline use and known limitations

Reproduction itself uses only packaged files and makes no network requests. A fully offline first-time setup requires a compatible Python 3.11 environment with every locked dependency already installed or cached, or a prebuilt Docker image; the archive does not include dependency wheels or the Docker base image. Results can also vary or fail on unsupported Python versions, platforms without compatible binary packages, insufficient memory, or modified package files. XeLaTeX is optional: if it is absent or cannot compile the report, the bundled fallback renderer still creates a valid PDF and records a warning.
`;
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
    const taskEvidence = evidenceForTask(input.evidence, result.task_id);
    lines.push(`### ${result.task_id} (${result.plugin_id})`, "", `Status: **${result.status}**`);
    if (result.selected_method) lines.push("", `Selected method: ${result.selected_method}`);
    lines.push("", "Metrics (resolved from the Evidence Graph):");
    for (const metric of evidenceMetricLines(taskEvidence)) lines.push(`- ${metric}`);
    if (taskEvidence.artifacts.length > 0) {
      lines.push("", "Figures and tables:");
      for (const artifact of taskEvidence.artifacts) lines.push(`- ${artifact.kind}: ${artifactDisplay(artifact)} (\`${artifact.id}\`)`);
    }
    if (result.error) lines.push("", `Failure: ${result.error.class}: ${result.error.message}`);
    if (result.warnings.length) {
      lines.push("", "Warnings:");
      for (const warning of result.warnings) lines.push(`- ${warning}`);
    }
    lines.push("");
  }
  lines.push(
    "## Evidence Appendix",
    "",
    `The evidence graph contains ${input.evidence.nodes.length} nodes and ${input.evidence.edges.length} edges. Exact numeric values above are rendered only from metric evidence nodes.`,
    ""
  );
  for (const node of input.evidence.nodes.filter((item) => item.kind === "figure" || item.kind === "table").sort((left, right) => left.id.localeCompare(right.id))) {
    lines.push(`- ${node.id} [${node.kind}]: ${artifactDisplay(node)}`);
  }
  lines.push(
    "",
    "## Reproducibility",
    "",
    "Frozen inputs, requests, expected results, experiment artifacts, Python execution code, dependency manifests, and the standalone reproduction command are included in this project package."
  );
  return `${lines.join("\n")}\n`;
}

function tex(input: ReportBuildInput): string {
  const sections = input.taskResults.map((result) => {
    const taskEvidence = evidenceForTask(input.evidence, result.task_id);
    const metrics = evidenceMetricLines(taskEvidence).map((line) => `\\item ${escapeTex(line.replaceAll("`", ""))}`).join("\n");
    const artifacts = taskEvidence.artifacts.length > 0
      ? `\\paragraph{Figures and tables}\n\\begin{itemize}\n${taskEvidence.artifacts.map((node) => `\\item ${escapeTex(`${node.kind}: ${artifactDisplay(node)} (${node.id})`)}`).join("\n")}\n\\end{itemize}`
      : "";
    const failure = result.error ? `\\paragraph{Failure} ${escapeTex(`${result.error.class}: ${result.error.message}`)}` : "";
    return `\\subsection*{${escapeTex(`${result.task_id} (${result.plugin_id})`)}}
Status: \\textbf{${escapeTex(result.status)}}.
${result.selected_method ? `Selected method: \\texttt{${escapeTex(result.selected_method)}}.` : ""}
\\paragraph{Evidence-backed metrics}
\\begin{itemize}
${metrics}
\\end{itemize}
${artifacts}
${failure}`;
  }).join("\n\n");
  const requirements = input.problem.requirements.map((item) => `\\item ${escapeTex(`${item.id}: ${item.text}`)}`).join("\n");
  const appendix = input.evidence.nodes
    .filter((node) => node.kind === "figure" || node.kind === "table")
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((node) => `\\item ${escapeTex(`${node.id} [${node.kind}]: ${artifactDisplay(node)}`)}`)
    .join("\n");
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
\\section*{Evidence Appendix}
The evidence graph contains ${input.evidence.nodes.length} nodes and ${input.evidence.edges.length} edges. Exact numeric values above are rendered only from metric evidence nodes.
\\begin{itemize}
${appendix}
\\end{itemize}
\\section*{Reproducibility}
Frozen inputs, requests, expected results, experiment artifacts, Python execution code, dependency manifests, and the standalone reproduction command are included with this project.
\\end{document}
`;
}

function execute(command: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

function sanitizeBuildLog(value: string, roots: string[]): string {
  let sanitized = value;
  for (const root of [...roots].sort((left, right) => right.length - left.length)) {
    if (root) sanitized = sanitized.split(root).join("<host-path>");
  }
  sanitized = sanitized
    .replace(/(?:[A-Za-z]:)?\/(?:home|tmp|private\/tmp|var\/tmp)\/[^\s'"()]+/g, "<host-path>")
    .replace(/\\(?:Users|Temp)\\[^\s'"()]+/gi, "<host-path>");
  return sanitized.slice(0, 20_000);
}

async function buildPdf(texPath: string, reportPath: string, title: string, outputDirectory: string, projectRoot: string): Promise<PdfStatus> {
  const reportPdf = resolve(outputDirectory, "report.pdf");
  const buildLog = resolve(outputDirectory, "build.log");
  try {
    const result = await execute("xelatex", ["-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-output-directory", outputDirectory, basename(texPath)], outputDirectory, 120_000);
    await writeFile(buildLog, sanitizeBuildLog(`${result.stdout}\n${result.stderr}`, [projectRoot, outputDirectory, process.cwd()]), { encoding: "utf8", mode: 0o600 });
    if (result.code === 0) return { status: "success", renderer: "xelatex" };
    const message = result.stderr.trim().slice(0, 2000) || `xelatex exited with ${result.code}.`;
    await writeFile(reportPdf, createFallbackPdf(title, await readFile(reportPath, "utf8")), { mode: 0o600 });
    return { status: "success", renderer: "builtin", warning: { class: "xelatex_failure", message } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeFile(buildLog, sanitizeBuildLog(message, [projectRoot, outputDirectory, process.cwd()]), { encoding: "utf8", mode: 0o600 });
    await writeFile(reportPdf, createFallbackPdf(title, await readFile(reportPath, "utf8")), { mode: 0o600 });
    return { status: "success", renderer: "builtin", warning: { class: "xelatex_unavailable", message } };
  } finally {
    await Promise.all([
      rm(resolve(outputDirectory, "report.aux"), { force: true }),
      rm(resolve(outputDirectory, "report.log"), { force: true }),
      rm(resolve(outputDirectory, "report.out"), { force: true }),
      rm(resolve(outputDirectory, "report.toc"), { force: true })
    ]);
  }
}

function assertProjectRelative(value: string): string {
  const normalized = value.split(sep).join("/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) throw new Error(`Unsafe project-relative path: ${value}`);
  return normalized;
}

function rewriteRequestForPackage(request: unknown, taskId: string): Record<string, unknown> {
  if (!request || typeof request !== "object") throw new Error(`Invalid frozen request for ${taskId}.`);
  const record = structuredClone(request) as Record<string, unknown>;
  const dataFiles = record.data_files;
  if (!Array.isArray(dataFiles)) throw new Error(`Frozen request has no data_files for ${taskId}.`);
  record.run_id = "standalone-project";
  record.output_dir = `reproduced/experiments/${taskId}`;
  record.data_files = dataFiles.map((item) => {
    if (!item || typeof item !== "object") throw new Error(`Invalid data file in frozen request for ${taskId}.`);
    const file = { ...(item as Record<string, unknown>) };
    const relativePath = assertProjectRelative(String(file.relative_path ?? ""));
    file.absolute_path = `reproducibility/inputs/${relativePath}`;
    return file;
  });
  return record;
}

async function copyExperimentArtifacts(sourceRoot: string, destinationRoot: string, taskResults: ExperimentResult[]): Promise<ReproductionTask[]> {
  const tasks: ReproductionTask[] = [];
  await mkdir(destinationRoot, { recursive: true });
  for (const result of taskResults) {
    const attemptRoot = resolve(sourceRoot, result.task_id, result.attempt_id);
    const destination = resolve(destinationRoot, result.task_id, result.attempt_id);
    await cp(attemptRoot, destination, { recursive: true });
    const requestPath = resolve(destination, "experiment-request.json");
    const request = JSON.parse(await readFile(requestPath, "utf8")) as unknown;
    await writeJsonAtomic(requestPath, rewriteRequestForPackage(request, result.task_id));
    const expectedArtifacts: ReproductionFile[] = [];
    for (const artifact of result.artifacts) {
      if (artifact.relative_path.endsWith("/experiment-request.json")) continue;
      expectedArtifacts.push({ path: artifact.relative_path.split("/").slice(3).join("/"), sha256: artifact.sha256, size_bytes: artifact.size_bytes });
    }
    tasks.push({
      task_id: result.task_id,
      attempt_id: result.attempt_id,
      request: relative(destinationRoot, requestPath).split(sep).join("/"),
      expected_result: relative(destinationRoot, resolve(destination, "experiment-result.json")).split(sep).join("/"),
      expected_artifacts: expectedArtifacts.sort((left, right) => left.path.localeCompare(right.path))
    });
  }
  return tasks.sort((left, right) => left.task_id.localeCompare(right.task_id));
}

async function manifestFiles(root: string): Promise<ReproductionFile[]> {
  const files: ReproductionFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const identity = await fileIdentity(path);
        files.push({ path: relative(root, path).split(sep).join("/"), sha256: identity.sha256, size_bytes: identity.sizeBytes });
      }
    }
  };
  await visit(root);
  return files;
}

async function copyRuntime(input: ReportBuildInput, reproducibility: string): Promise<void> {
  const pythonDestination = resolve(reproducibility, "python", "modeling_agent");
  await cp(input.pythonSourceRoot, pythonDestination, {
    recursive: true,
    filter: (source) => !source.split(sep).includes("__pycache__") && !source.endsWith(".pyc")
  });
  const environment = resolve(reproducibility, "environment");
  await mkdir(environment, { recursive: true });
  await Promise.all([
    copyFile(input.pythonRequirementsPath, resolve(environment, "requirements.lock")),
    copyFile(input.pythonDockerfilePath, resolve(environment, "Dockerfile"))
  ]);
}

export class ReportBuilder {
  async build(input: ReportBuildInput): Promise<ReportBuildResult> {
    const projectRoot = resolve(input.projectRoot);
    const deliverables = resolve(projectRoot, "deliverables");
    const reproducibility = resolve(projectRoot, "reproducibility");
    await rm(projectRoot, { recursive: true, force: true });
    await Promise.all([mkdir(deliverables, { recursive: true }), mkdir(reproducibility, { recursive: true })]);
    const reportMarkdown = resolve(deliverables, "report.md");
    const reportTex = resolve(deliverables, "report.tex");
    await Promise.all([
      writeFile(resolve(projectRoot, "README.md"), projectReadme(input.pythonVersion ?? "3.11"), { encoding: "utf8", mode: 0o600 }),
      writeFile(reportMarkdown, markdown(input), { encoding: "utf8", mode: 0o600 }),
      writeFile(reportTex, tex(input), { encoding: "utf8", mode: 0o600 }),
      writeJsonAtomic(resolve(reproducibility, "problem-spec.json"), input.problem),
      writeJsonAtomic(resolve(reproducibility, "task-graph.json"), input.graph),
      writeJsonAtomic(resolve(reproducibility, "evaluation-contracts.json"), input.evaluationContracts),
      writeJsonAtomic(resolve(reproducibility, "evidence-graph.json"), input.evidence),
      writeJsonAtomic(resolve(reproducibility, "experiment-results.json"), input.taskResults)
    ]);
    const inputRoot = resolve(reproducibility, "inputs");
    for (const file of input.inputFiles) {
      const destination = resolve(inputRoot, file.relativePath);
      if (destination !== inputRoot && !destination.startsWith(`${inputRoot}${sep}`)) throw new Error(`Unsafe reproducibility input path: ${file.relativePath}`);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(file.source, destination);
    }
    await copyRuntime(input, reproducibility);
    const tasks = await copyExperimentArtifacts(input.committedExperimentsRoot, resolve(reproducibility, "experiments"), input.taskResults);
    const pdfStatus = await buildPdf(reportTex, reportMarkdown, input.problem.title, deliverables, projectRoot);
    const reportPdf = resolve(deliverables, "report.pdf");
    const warnings = pdfStatus.warning ? [`${pdfStatus.warning.class}: ${pdfStatus.warning.message}`] : [];
    const generated = resolve(deliverables, `${basename(reportTex, ".tex")}.pdf`);
    if (pdfStatus.renderer === "xelatex" && generated !== reportPdf) await copyFile(generated, reportPdf);
    await writeJsonAtomic(resolve(deliverables, "report-status.json"), pdfStatus);
    await writeJsonAtomic(resolve(reproducibility, "reproduce.json"), {
      schema_version: "2.0.0",
      runtime_kind: input.reproduction.runtimeKind,
      execution_kind: input.reproduction.executionKind,
      command: "python3 reproduce.py",
      python_module: "modeling_agent.runner",
      dependency_manifest: "reproducibility/environment/requirements.lock",
      dockerfile: "reproducibility/environment/Dockerfile",
      tasks
    });
    const scriptSource = resolve(new URL("../../python/standalone_reproduce.py", import.meta.url).pathname);
    await copyFile(scriptSource, resolve(projectRoot, "reproduce.py"));
    const files = await manifestFiles(projectRoot);
    await writeJsonAtomic(resolve(reproducibility, "package-manifest.json"), {
      schema_version: "1.0.0",
      manifest_sha256: sha256Text(JSON.stringify(files)),
      files
    });
    return { projectRoot, reportMarkdown, reportTex, reportPdf, pdfStatus, warnings };
  }
}
