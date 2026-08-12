import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileIdentity, sha256Text } from "../infrastructure/hash.js";
import type { DataAsset } from "../contracts/types.js";

const SUPPORTED_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".csv", ".json", ".xlsx", ".xls", ".parquet", ".png", ".jpg", ".jpeg"]);

export interface ImportedPackage {
  rootPath: string;
  problemPath: string;
  problemText: string;
  dataAssets: DataAsset[];
  dataPaths: Map<string, string>;
}

function mediaType(path: string): string {
  const extension = extname(path).toLowerCase();
  const types: Record<string, string> = {
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".json": "application/json",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".parquet": "application/vnd.apache.parquet",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg"
  };
  return types[extension] ?? "application/octet-stream";
}

function normalizeRelative(root: string, target: string): string {
  const value = relative(root, target).split(sep).join("/");
  if (!value || value.startsWith("../") || value === ".." || isAbsolute(value)) {
    throw new Error(`Unsafe path outside package: ${value || target}`);
  }
  return value;
}

export async function resolveSafePath(rootPath: string, relativePath: string): Promise<string> {
  const root = await realpath(rootPath);
  if (isAbsolute(relativePath)) throw new Error(`Unsafe absolute path outside package: ${relativePath}`);
  const candidate = resolve(root, relativePath);
  const normalized = normalizeRelative(root, candidate);
  const parentReal = await realpath(resolve(root, normalized, ".."));
  if (parentReal !== root && !parentReal.startsWith(`${root}${sep}`)) {
    throw new Error(`Unsafe path outside package: ${relativePath}`);
  }
  let targetReal: string;
  try {
    targetReal = await realpath(candidate);
  } catch {
    targetReal = candidate;
  }
  if (targetReal !== root && !targetReal.startsWith(`${root}${sep}`)) {
    throw new Error(`Unsafe path outside package: ${relativePath}`);
  }
  return candidate;
}

async function walk(root: string, directory: string, files: string[]): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(root, absolute, files);
    } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      files.push(absolute);
    } else if (entry.isSymbolicLink()) {
      throw new Error(`Symlink inputs are not allowed: ${entry.name}`);
    }
  }
}

export async function importPackage(packagePath: string): Promise<ImportedPackage> {
  const root = await realpath(resolve(packagePath));
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new Error(`Package path is not a directory: ${packagePath}`);
  const files: string[] = [];
  await walk(root, root, files);
  const problemPath = files.find((path) => ["problem.md", "problem.markdown", "problem.txt"].includes(basename(path).toLowerCase()));
  if (!problemPath) throw new Error("Package must contain problem.md, problem.markdown, or problem.txt.");
  const problemText = await readFile(problemPath, "utf8");
  if (!problemText.trim()) throw new Error("Problem statement is empty.");

  const dataAssets: DataAsset[] = [];
  const dataPaths = new Map<string, string>();
  for (const path of files.filter((item) => item !== problemPath)) {
    const relativePath = normalizeRelative(root, path);
    const identity = await fileIdentity(path);
    const asset: DataAsset = {
      artifact_id: `input-${sha256Text(`${relativePath}:${identity.sha256}`).slice(0, 12)}`,
      relative_path: relativePath,
      media_type: mediaType(path),
      size_bytes: identity.sizeBytes,
      sha256: identity.sha256
    };
    dataAssets.push(asset);
    dataPaths.set(asset.artifact_id, path);
  }
  return { rootPath: root, problemPath, problemText, dataAssets, dataPaths };
}
