import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileIdentity, sha256Text } from "../infrastructure/hash.js";
import type { DataAsset } from "../contracts/types.js";
import { inspectAssetMetadata } from "./asset-metadata.js";
import { extractDocx } from "./docx-extractor.js";
import { extractPdf } from "./pdf-extractor.js";
import {
  PackageImportError,
  type AssetMetadata,
  type ImportedPackage,
  type ImportLimits,
  type ImportOptions,
  type ImportWarning,
  type ProblemExtractionMetadata
} from "./types.js";

export {
  PackageImportError,
  type AssetMetadata,
  type ImportedPackage,
  type ImportLimits,
  type ImportOptions,
  type ImportWarning,
  type ProblemExtractionMetadata
} from "./types.js";

/**
 * Problem candidates are selected by these precedence groups, from highest to
 * lowest. Markdown spellings intentionally share one precedence group; if more
 * than one candidate exists in the selected group, import fails rather than
 * depending on directory enumeration order.
 */
export const PROBLEM_CANDIDATE_PRIORITY = [
  ["problem.md", "problem.markdown"],
  ["problem.txt"],
  ["problem.pdf"],
  ["problem.docx"]
] as const;

export const DEFAULT_IMPORT_LIMITS: Readonly<ImportLimits> = Object.freeze({
  maxProblemBytes: 32 * 1024 * 1024,
  maxTextCharacters: 2_000_000,
  maxPackageEntries: 10_000,
  maxPackageDepth: 64,
  maxAssetBytes: 2 * 1024 * 1024 * 1024,
  maxPdfPages: 500,
  maxPdfCharacters: 2_000_000,
  maxDocxZipEntries: 2_000,
  maxDocxUncompressedBytes: 128 * 1024 * 1024,
  maxDocxXmlPartBytes: 16 * 1024 * 1024,
  maxDocxCharacters: 2_000_000,
  maxMetadataBytes: 128 * 1024 * 1024,
  maxMetadataZipEntries: 10_000,
  maxMetadataUncompressedBytes: 256 * 1024 * 1024,
  maxXlsxSheets: 1_000,
  maxXlsxWorkbookBytes: 4 * 1024 * 1024,
  maxXlsxRelationshipsBytes: 4 * 1024 * 1024,
  maxXlsxWorksheetBytes: 1024 * 1024,
  maxImageHeaderBytes: 1024 * 1024,
  maxImagePixels: 250_000_000
});

const MACRO_ENABLED_EXTENSIONS = new Set([".docm", ".dotm"]);

const SUPPORTED_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".pdf",
  ".docx",
  ".csv",
  ".json",
  ".xlsx",
  ".xls",
  ".parquet",
  ".png",
  ".jpg",
  ".jpeg"
]);

function mediaType(path: string): string {
  const extension = extname(path).toLowerCase();
  const types: Record<string, string> = {
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".txt": "text/plain",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
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

function normalizedLimits(overrides: Partial<ImportLimits> | undefined): ImportLimits {
  const limits = { ...DEFAULT_IMPORT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`Import limit ${name} must be a positive safe integer.`);
    }
  }
  return limits;
}

function normalizeRelative(root: string, target: string): string {
  const value = relative(root, target).split(sep).join("/");
  if (!value || value.startsWith("../") || value === ".." || isAbsolute(value)) {
    throw new PackageImportError("unsafe_path", `Unsafe path outside package: ${value || target}`, { path: value || target });
  }
  return value;
}

export async function resolveSafePath(rootPath: string, relativePath: string): Promise<string> {
  const requestedRoot = resolve(rootPath);
  const requestedStat = await lstat(requestedRoot);
  if (requestedStat.isSymbolicLink()) throw new PackageImportError("symlink_input", `Symlink inputs are not allowed: ${rootPath}`, { path: rootPath });
  const root = await realpath(requestedRoot);
  if (isAbsolute(relativePath)) {
    throw new PackageImportError("unsafe_path", `Unsafe absolute path outside package: ${relativePath}`, { path: relativePath });
  }
  const candidate = resolve(root, relativePath);
  const normalized = normalizeRelative(root, candidate);
  const parentReal = await realpath(resolve(root, normalized, ".."));
  if (parentReal !== root && !parentReal.startsWith(`${root}${sep}`)) {
    throw new PackageImportError("unsafe_path", `Unsafe path outside package: ${relativePath}`, { path: relativePath });
  }
  try {
    const candidateStat = await lstat(candidate);
    if (candidateStat.isSymbolicLink()) {
      throw new PackageImportError("symlink_input", `Symlink inputs are not allowed: ${relativePath}`, { path: relativePath });
    }
    const targetReal = await realpath(candidate);
    if (targetReal !== root && !targetReal.startsWith(`${root}${sep}`)) {
      throw new PackageImportError("unsafe_path", `Unsafe path outside package: ${relativePath}`, { path: relativePath });
    }
  } catch (error) {
    if (error instanceof PackageImportError) throw error;
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") throw error;
  }
  return candidate;
}

interface WalkState {
  entries: number;
}

async function walk(
  root: string,
  directory: string,
  files: string[],
  limits: ImportLimits,
  state: WalkState,
  depth: number
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const absolute = resolve(directory, entry.name);
    state.entries += 1;
    if (state.entries > limits.maxPackageEntries) {
      throw new PackageImportError("package_entry_limit", `Package has more than ${limits.maxPackageEntries} filesystem entries.`, {
        actual: state.entries,
        limit: limits.maxPackageEntries
      });
    }
    const relativePath = normalizeRelative(root, absolute);
    const current = await lstat(absolute);
    if (current.isSymbolicLink()) {
      throw new PackageImportError("symlink_input", `Symlink inputs are not allowed: ${relativePath}`, { path: relativePath });
    }
    if (current.isDirectory()) {
      const childDepth = depth + 1;
      if (childDepth > limits.maxPackageDepth) {
        throw new PackageImportError("package_depth_limit", `Package directory depth exceeds ${limits.maxPackageDepth}.`, {
          path: relativePath,
          actual: childDepth,
          limit: limits.maxPackageDepth
        });
      }
      // Hidden entries consume the traversal budget, but hidden directories are not recursed into.
      if (entry.name.startsWith(".")) continue;
      const resolvedDirectory = await realpath(absolute);
      if (resolvedDirectory !== root && !resolvedDirectory.startsWith(`${root}${sep}`)) {
        throw new PackageImportError("unsafe_path", "Directory changed outside package during traversal.", { path: relativePath });
      }
      const checked = await lstat(absolute);
      if (!checked.isDirectory() || checked.isSymbolicLink() || checked.dev !== current.dev || checked.ino !== current.ino) {
        throw new PackageImportError("unsafe_path", "Directory changed during traversal.", { path: relativePath });
      }
      await walk(root, resolvedDirectory, files, limits, state, childDepth);
      continue;
    }
    // Hidden entries consume the traversal budget, but hidden files are not inventoried.
    if (entry.name.startsWith(".")) continue;
    const extension = extname(entry.name).toLowerCase();
    if (current.isFile() && MACRO_ENABLED_EXTENSIONS.has(extension)) {
      throw new PackageImportError("docx_macro_enabled", `Macro-enabled Word input is not allowed: ${relativePath}`, {
        path: relativePath
      });
    } else if (current.isFile() && SUPPORTED_EXTENSIONS.has(extension)) {
      files.push(absolute);
    }
  }
}

function selectProblem(root: string, files: string[]): string {
  const byName = new Map<string, string[]>();
  for (const path of files) {
    const name = basename(path).toLowerCase();
    const candidates = byName.get(name) ?? [];
    candidates.push(path);
    byName.set(name, candidates);
  }
  for (const group of PROBLEM_CANDIDATE_PRIORITY) {
    const candidates = group.flatMap((name) => byName.get(name) ?? []).sort((left, right) => left.localeCompare(right, "en"));
    if (candidates.length === 0) continue;
    if (candidates.length > 1) {
      const relativeCandidates = candidates.map((path) => normalizeRelative(root, path));
      throw new PackageImportError(
        "ambiguous_problem",
        `Multiple problem statements share the selected priority: ${relativeCandidates.join(", ")}`,
        { candidates: relativeCandidates }
      );
    }
    const selected = candidates[0];
    if (selected === undefined) break;
    return selected;
  }
  throw new PackageImportError(
    "problem_missing",
    "Package must contain problem.md, problem.markdown, problem.txt, problem.pdf, or problem.docx."
  );
}

function decodeUtf8(bytes: Buffer, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    const value = error instanceof Error ? error.message : String(error);
    const cause = value.replace(/[\r\n\t]+/g, " ").slice(0, 240);
    throw new PackageImportError("problem_encoding", `Problem statement is not valid UTF-8: ${path}`, { path, cause });
  }
}

async function extractProblem(
  problemPath: string,
  identity: { sha256: string; sizeBytes: number },
  limits: ImportLimits
): Promise<{ text: string; metadata: ProblemExtractionMetadata }> {
  const extension = extname(problemPath).toLowerCase();
  if (extension === ".pdf") return extractPdf(problemPath, identity, limits);
  if (extension === ".docx") return extractDocx(problemPath, identity, limits);
  if (identity.sizeBytes > limits.maxProblemBytes) {
    throw new PackageImportError("problem_file_limit", `Problem statement is ${identity.sizeBytes} bytes; limit is ${limits.maxProblemBytes}.`, {
      path: problemPath,
      actual: identity.sizeBytes,
      limit: limits.maxProblemBytes
    });
  }
  const text = decodeUtf8(await readFile(problemPath), problemPath);
  if (text.length > limits.maxTextCharacters) {
    throw new PackageImportError("problem_file_limit", `Problem statement exceeds ${limits.maxTextCharacters} characters.`, {
      path: problemPath,
      actual: text.length,
      limit: limits.maxTextCharacters
    });
  }
  if (!text.trim()) throw new PackageImportError("problem_empty", "Problem statement is empty.", { path: problemPath });
  return {
    text,
    metadata: {
      format: extension === ".txt" ? "text" : "markdown",
      sourceBytes: identity.sizeBytes,
      sha256: identity.sha256,
      extractedCharacters: text.length,
      extractor: "utf8-v1"
    }
  };
}

export async function importPackage(packagePath: string, options: ImportOptions = {}): Promise<ImportedPackage> {
  const limits = normalizedLimits(options.limits);
  const requestedRoot = resolve(packagePath);
  const requestedStat = await lstat(requestedRoot);
  if (requestedStat.isSymbolicLink()) {
    throw new PackageImportError("symlink_input", `Symlink package roots are not allowed: ${packagePath}`, { path: packagePath });
  }
  if (!requestedStat.isDirectory()) throw new Error(`Package path is not a directory: ${packagePath}`);
  const root = await realpath(requestedRoot);
  const checkedRoot = await lstat(requestedRoot);
  if (!checkedRoot.isDirectory()
    || checkedRoot.isSymbolicLink()
    || checkedRoot.dev !== requestedStat.dev
    || checkedRoot.ino !== requestedStat.ino) {
    throw new PackageImportError("unsafe_path", "Package root changed during import.", { path: packagePath });
  }
  const files: string[] = [];
  await walk(root, root, files, limits, { entries: 0 }, 0);
  const problemPath = selectProblem(root, files);
  const problemBeforeStat = await lstat(problemPath);
  if (!problemBeforeStat.isFile() || problemBeforeStat.isSymbolicLink()) {
    throw new PackageImportError("symlink_input", `Problem input changed or became a symlink during import: ${problemPath}`, { path: problemPath });
  }
  if (problemBeforeStat.size > limits.maxProblemBytes) {
    throw new PackageImportError("problem_file_limit", `Problem statement is ${problemBeforeStat.size} bytes; limit is ${limits.maxProblemBytes}.`, {
      path: problemPath,
      actual: problemBeforeStat.size,
      limit: limits.maxProblemBytes
    });
  }
  const problemIdentity = await fileIdentity(problemPath);
  const problem = await extractProblem(problemPath, problemIdentity, limits);
  const problemAfterStat = await lstat(problemPath);
  if (!problemAfterStat.isFile()
    || problemAfterStat.isSymbolicLink()
    || problemBeforeStat.dev !== problemAfterStat.dev
    || problemBeforeStat.ino !== problemAfterStat.ino
    || problemBeforeStat.size !== problemAfterStat.size
    || problemBeforeStat.mtimeMs !== problemAfterStat.mtimeMs) {
    throw new PackageImportError("unsafe_path", `Problem input changed while being extracted: ${problemPath}`, { path: problemPath });
  }

  const dataAssets: DataAsset[] = [];
  const dataPaths = new Map<string, string>();
  const assetMetadata: Record<string, AssetMetadata> = {};
  const warnings: ImportWarning[] = [];
  for (const path of files.filter((item) => item !== problemPath)) {
    const relativePath = normalizeRelative(root, path);
    const beforeStat = await lstat(path);
    if (!beforeStat.isFile() || beforeStat.isSymbolicLink()) {
      throw new PackageImportError("symlink_input", `Input changed or became a symlink during import: ${relativePath}`, { path: relativePath });
    }
    if (beforeStat.size > limits.maxAssetBytes) {
      throw new PackageImportError("asset_file_limit", `Asset ${relativePath} is ${beforeStat.size} bytes; limit is ${limits.maxAssetBytes}.`, {
        path: relativePath,
        actual: beforeStat.size,
        limit: limits.maxAssetBytes
      });
    }
    const identity = await fileIdentity(path);
    const afterStat = await lstat(path);
    if (!afterStat.isFile()
      || afterStat.isSymbolicLink()
      || beforeStat.dev !== afterStat.dev
      || beforeStat.ino !== afterStat.ino
      || beforeStat.size !== afterStat.size
      || beforeStat.mtimeMs !== afterStat.mtimeMs) {
      throw new PackageImportError("unsafe_path", `Input changed while being inventoried: ${relativePath}`, { path: relativePath });
    }
    const asset: DataAsset = {
      artifact_id: `input-${sha256Text(`${relativePath}:${identity.sha256}`).slice(0, 12)}`,
      relative_path: relativePath,
      media_type: mediaType(path),
      size_bytes: identity.sizeBytes,
      sha256: identity.sha256
    };
    dataAssets.push(asset);
    dataPaths.set(asset.artifact_id, path);
    try {
      const metadata = await inspectAssetMetadata(path, identity.sizeBytes, limits);
      if (metadata) assetMetadata[asset.artifact_id] = metadata;
    } catch (error) {
      if (!(error instanceof PackageImportError) || (error.code !== "metadata_unreadable" && error.code !== "metadata_limit")) throw error;
      warnings.push({ code: error.code, path: relativePath, message: error.message });
    }
  }
  return {
    rootPath: root,
    problemPath,
    problemText: problem.text,
    dataAssets,
    dataPaths,
    problemMetadata: problem.metadata,
    assetMetadata,
    warnings
  };
}
