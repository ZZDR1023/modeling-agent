import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileIdentity, sha256Text } from "../infrastructure/hash.js";
import type { ProducedArtifact } from "../contracts/types.js";

export class ArtifactStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  get root(): string {
    return this.#root;
  }

  async putText(runId: string, relativePath: string, value: string, mediaType = "text/plain", kind: ProducedArtifact["kind"] = "other"): Promise<ProducedArtifact> {
    const destination = this.#safe(runId, relativePath);
    await mkdir(resolve(destination, ".."), { recursive: true });
    await writeFile(destination, value, { encoding: "utf8", mode: 0o600 });
    return this.#record(destination, runId, relativePath, mediaType, kind);
  }

  async putBuffer(runId: string, relativePath: string, value: Uint8Array, mediaType = "application/octet-stream", kind: ProducedArtifact["kind"] = "other"): Promise<ProducedArtifact> {
    const destination = this.#safe(runId, relativePath);
    await mkdir(resolve(destination, ".."), { recursive: true });
    await writeFile(destination, value, { mode: 0o600 });
    return this.#record(destination, runId, relativePath, mediaType, kind);
  }

  async putFile(runId: string, relativePath: string, sourcePath: string, mediaType = "application/octet-stream", kind: ProducedArtifact["kind"] = "other"): Promise<ProducedArtifact> {
    const destination = this.#safe(runId, relativePath);
    await mkdir(resolve(destination, ".."), { recursive: true });
    await copyFile(sourcePath, destination);
    return this.#record(destination, runId, relativePath, mediaType, kind);
  }

  async read(runId: string, relativePath: string): Promise<Buffer> {
    return readFile(this.#safe(runId, relativePath));
  }

  path(runId: string, relativePath = ""): string {
    return this.#safe(runId, relativePath || ".");
  }

  async inventory(runId: string): Promise<ProducedArtifact[]> {
    const root = this.path(runId);
    const { readdir } = await import("node:fs/promises");
    const records: ProducedArtifact[] = [];
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile()) {
          const relativePath = relative(this.path(runId), path).split(sep).join("/");
          const identity = await fileIdentity(path);
          records.push({ kind: inferKind(relativePath), relative_path: relativePath, media_type: mediaTypeFor(relativePath), sha256: identity.sha256, size_bytes: identity.sizeBytes });
        }
      }
    };
    try {
      await stat(root);
      await visit(root);
    } catch {
      return [];
    }
    return records;
  }

  #safe(runId: string, relativePath: string): string {
    if (isAbsolute(runId) || isAbsolute(relativePath)) throw new Error("unsafe artifact path: absolute paths are forbidden");
    const runRoot = resolve(this.#root, runId);
    const candidate = resolve(runRoot, relativePath);
    const rel = relative(runRoot, candidate);
    if (rel === "" || rel === ".") return runRoot;
    if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new Error(`unsafe artifact path: ${relativePath}`);
    return candidate;
  }

  async #record(destination: string, runId: string, relativePath: string, mediaType: string, kind: ProducedArtifact["kind"]): Promise<ProducedArtifact> {
    const identity = await fileIdentity(destination);
    return { kind, relative_path: relativePath.split(sep).join("/"), media_type: mediaType, sha256: identity.sha256, size_bytes: identity.sizeBytes };
  }
}

function mediaTypeFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".tex")) return "application/x-tex";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".zip")) return "application/zip";
  return "application/octet-stream";
}

function inferKind(path: string): ProducedArtifact["kind"] {
  if (path.toLowerCase().endsWith(".png")) return "figure";
  if (path.toLowerCase().endsWith(".csv")) return "table";
  if (path.toLowerCase().endsWith(".py")) return "code";
  return "other";
}

export function artifactId(record: Pick<ProducedArtifact, "sha256" | "relative_path">): string {
  return `artifact-${sha256Text(`${record.relative_path}:${record.sha256}`).slice(0, 16)}`;
}
