import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, resolve } from "node:path";
import type { ExperimentRequest, ExperimentResult } from "../contracts/types.js";
import { SchemaRegistry } from "../contracts/schema-registry.js";

export interface PythonWorker {
  readonly kind: "local" | "docker";
  execute(request: ExperimentRequest): Promise<ExperimentResult>;
}

export interface LocalPythonWorkerOptions {
  pythonExecutable?: string;
  pythonRoot?: string;
  timeoutMs?: number;
}

export class PythonWorkerError extends Error {
  readonly errorClass: string;
  constructor(errorClass: string, message: string) {
    super(message);
    this.name = "PythonWorkerError";
    this.errorClass = errorClass;
  }
}

function runProcess(command: string, args: string[], options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new PythonWorkerError("timeout", `Python worker exceeded ${options.timeoutMs}ms.`)));
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      finish(() => reject(new PythonWorkerError("worker_spawn_failure", error.message)));
    });
    child.once("close", (code, signal) => {
      finish(() => resolvePromise({ code: code ?? (signal ? 1 : 0), stdout, stderr }));
    });
  });
}

export class LocalPythonWorker implements PythonWorker {
  readonly kind = "local" as const;
  readonly #pythonExecutable: string;
  readonly #pythonRoot: string;
  readonly #timeoutMs: number;
  readonly #schemas: SchemaRegistry;

  constructor(options: LocalPythonWorkerOptions = {}, schemas = new SchemaRegistry()) {
    this.#pythonExecutable = options.pythonExecutable ?? "python3";
    this.#pythonRoot = resolve(options.pythonRoot ?? new URL("../../python/", import.meta.url).pathname);
    this.#timeoutMs = options.timeoutMs ?? 900_000;
    this.#schemas = schemas;
  }

  async execute(request: ExperimentRequest): Promise<ExperimentResult> {
    const outputDir = resolve(request.output_dir);
    await mkdir(outputDir, { recursive: true });
    const requestPath = resolve(outputDir, "experiment-request.json");
    await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const result = await runProcess(this.#pythonExecutable, ["-m", "modeling_agent.runner", "--request", requestPath], {
      cwd: this.#pythonRoot,
      timeoutMs: this.#timeoutMs,
      env: { ...process.env, PYTHONPATH: process.env.PYTHONPATH ? `${this.#pythonRoot}${delimiter}${process.env.PYTHONPATH}` : this.#pythonRoot }
    });
    const manifestPath = resolve(outputDir, "experiment-result.json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      const detail = result.stderr.trim() || result.stdout.trim() || (error instanceof Error ? error.message : String(error));
      throw new PythonWorkerError("worker_contract_failure", `Python worker did not produce experiment-result.json: ${detail}`);
    }
    const validated = this.#schemas.validate<ExperimentResult>("experiment-result", parsed);
    if (result.code === 0 && validated.status !== "success") {
      throw new PythonWorkerError("worker_process_failure", "Python worker exited successfully while reporting a failed result.");
    }
    return validated;
  }
}

export interface DockerPythonWorkerOptions {
  image?: string;
  timeoutMs?: number;
  pythonRoot?: string;
}

export interface DockerExecutionPlan {
  containerRequest: ExperimentRequest;
  args: string[];
}

export interface HostUser {
  uid: number;
  gid: number;
}

function containerInputPath(file: ExperimentRequest["data_files"][number], index: number): string {
  const filename = file.relative_path.split("/").at(-1) ?? `input-${index}`;
  return `/workspace/input/${index}/${filename}`;
}

function currentHostUser(): HostUser | undefined {
  if (process.platform !== "linux" || !process.getuid || !process.getgid) return undefined;
  return { uid: process.getuid(), gid: process.getgid() };
}

export function buildDockerExecutionPlan(
  request: ExperimentRequest,
  options: { image: string; hostUser?: HostUser }
): DockerExecutionPlan {
  const outputDir = resolve(request.output_dir);
  const containerRequest: ExperimentRequest = {
    ...request,
    output_dir: "/workspace/output",
    data_files: request.data_files.map((file, index) => ({
      ...file,
      absolute_path: containerInputPath(file, index)
    }))
  };
  const hostUser = options.hostUser ?? currentHostUser();
  const args = [
    "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--pids-limit", "256", "--memory", "2g", "--cpus", "2",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m"
  ];
  if (hostUser) args.push("--user", `${hostUser.uid}:${hostUser.gid}`);
  args.push(
    "--workdir", "/opt/modeling-agent",
    "-v", `${outputDir}:/workspace/output:rw`
  );
  for (const [index, file] of request.data_files.entries()) {
    args.push("-v", `${resolve(file.absolute_path)}:${containerInputPath(file, index)}:ro`);
  }
  args.push(options.image, "python", "-m", "modeling_agent.runner", "--request", "/workspace/output/experiment-request.json");
  return { containerRequest, args };
}

export class DockerPythonWorker implements PythonWorker {
  readonly kind = "docker" as const;
  readonly #image: string;
  readonly #timeoutMs: number;
  readonly #pythonRoot: string;
  readonly #schemas: SchemaRegistry;

  constructor(options: DockerPythonWorkerOptions = {}, schemas = new SchemaRegistry()) {
    this.#image = options.image ?? process.env.MODELING_AGENT_PYTHON_IMAGE ?? "modeling-agent-python:0.1-alpha";
    this.#timeoutMs = options.timeoutMs ?? 900_000;
    this.#pythonRoot = resolve(options.pythonRoot ?? new URL("../../python/", import.meta.url).pathname);
    this.#schemas = schemas;
  }

  async execute(request: ExperimentRequest): Promise<ExperimentResult> {
    const outputDir = resolve(request.output_dir);
    await mkdir(outputDir, { recursive: true });
    const requestPath = resolve(outputDir, "experiment-request.json");
    const plan = buildDockerExecutionPlan(request, { image: this.#image });
    await writeFile(requestPath, `${JSON.stringify(plan.containerRequest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    let result: { code: number; stdout: string; stderr: string };
    try {
      result = await runProcess("docker", plan.args, { cwd: this.#pythonRoot, timeoutMs: this.#timeoutMs });
    } catch (error) {
      throw new PythonWorkerError("docker_unavailable", error instanceof Error ? error.message : String(error));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(resolve(outputDir, "experiment-result.json"), "utf8"));
    } catch (error) {
      throw new PythonWorkerError("docker_worker_failure", result.stderr.trim() || (error instanceof Error ? error.message : String(error)));
    }
    const validated = this.#schemas.validate<ExperimentResult>("experiment-result", parsed);
    if (result.code === 0 && validated.status !== "success") {
      throw new PythonWorkerError("docker_worker_failure", "Docker worker exited successfully while reporting a failed result.");
    }
    return validated;
  }
}

export function createPythonWorker(kind: "local" | "docker", options: LocalPythonWorkerOptions & DockerPythonWorkerOptions = {}): PythonWorker {
  return kind === "docker" ? new DockerPythonWorker(options) : new LocalPythonWorker(options);
}
