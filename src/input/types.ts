import { createHash } from "node:crypto";
import type { DataAsset } from "../contracts/types.js";

const MAX_CAUSE_FINGERPRINT_INPUT = 4096;
const MAX_PUBLIC_PATH_LENGTH = 160;
const MAX_PUBLIC_CANDIDATES = 16;

function diagnosticFingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value.slice(0, MAX_CAUSE_FINGERPRINT_INPUT)).digest("hex").slice(0, 16)}`;
}

function isPrivatePath(value: string): boolean {
  return value.startsWith("/")
    || value.startsWith("\\")
    || /^[A-Za-z]:[\\/]/.test(value)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

function publicDiagnosticPath(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (/\r|\n|\t/.test(value) || isPrivatePath(value) || value === ".." || value.startsWith("../")) return undefined;
  if (value.length > MAX_PUBLIC_PATH_LENGTH
    || value.includes("%")
    || value.includes("\\")
    || value.includes("?")
    || value.includes("#")
    || value.split("/").some((segment) => segment === ".." || segment === ".")) {
    return diagnosticFingerprint(value);
  }
  return value;
}

export type PackageImportErrorCode =
  | "ambiguous_problem"
  | "problem_missing"
  | "problem_empty"
  | "problem_file_limit"
  | "problem_encoding"
  | "package_entry_limit"
  | "package_depth_limit"
  | "asset_file_limit"
  | "symlink_input"
  | "unsafe_path"
  | "pdf_tool_unavailable"
  | "pdf_corrupt"
  | "pdf_encrypted"
  | "pdf_empty"
  | "pdf_page_limit"
  | "pdf_character_limit"
  | "docx_corrupt"
  | "docx_encrypted"
  | "docx_macro_enabled"
  | "docx_external_relationship"
  | "docx_zip_slip"
  | "docx_zip_entry_limit"
  | "docx_uncompressed_limit"
  | "docx_character_limit"
  | "docx_empty"
  | "metadata_unreadable"
  | "metadata_limit";

const PUBLIC_ERROR_MESSAGES: Readonly<Record<PackageImportErrorCode, string>> = Object.freeze({
  ambiguous_problem: "Problem statement selection is ambiguous.",
  problem_missing: "Package does not contain a supported problem statement.",
  problem_empty: "Problem statement is empty.",
  problem_file_limit: "Problem statement exceeds an import limit.",
  problem_encoding: "Problem statement encoding is invalid.",
  package_entry_limit: "Package exceeds the filesystem entry limit.",
  package_depth_limit: "Package exceeds the filesystem depth limit.",
  asset_file_limit: "An input asset exceeds an import limit.",
  symlink_input: "Symlink inputs are not allowed.",
  unsafe_path: "Unsafe path outside package.",
  pdf_tool_unavailable: "The local PDF extractor is unavailable.",
  pdf_corrupt: "PDF input could not be parsed.",
  pdf_encrypted: "Encrypted PDF files are not allowed.",
  pdf_empty: "PDF contains no extractable text.",
  pdf_page_limit: "PDF exceeds the page limit.",
  pdf_character_limit: "PDF extraction exceeds the character limit.",
  docx_corrupt: "DOCX input could not be parsed.",
  docx_encrypted: "Encrypted DOCX files are not allowed.",
  docx_macro_enabled: "Macro-enabled DOCX files are not allowed.",
  docx_external_relationship: "DOCX contains a non-internal relationship.",
  docx_zip_slip: "DOCX contains an unsafe archive path.",
  docx_zip_entry_limit: "DOCX exceeds the archive entry limit.",
  docx_uncompressed_limit: "DOCX exceeds the uncompressed-byte limit.",
  docx_character_limit: "DOCX extraction exceeds the character limit.",
  docx_empty: "DOCX body contains no extractable text.",
  metadata_unreadable: "Input metadata could not be read safely.",
  metadata_limit: "Input metadata exceeds an inspection limit."
});

export interface PackageImportErrorDetails {
  path?: string;
  candidates?: string[];
  limit?: number;
  actual?: number;
  cause?: string;
}

export class PackageImportError extends Error {
  readonly code: PackageImportErrorCode;
  readonly details: Readonly<PackageImportErrorDetails>;

  constructor(code: PackageImportErrorCode, message: string, details: PackageImportErrorDetails = {}) {
    void message;
    const { cause, path, candidates, ...safeDetails } = details;
    const normalizedCause = cause?.replace(/[\r\n\t]+/g, " ").slice(0, MAX_CAUSE_FINGERPRINT_INPUT);
    const boundedCause = normalizedCause === undefined ? undefined : diagnosticFingerprint(normalizedCause);
    const boundedDetails: PackageImportErrorDetails = { ...safeDetails };
    const publicPath = publicDiagnosticPath(path);
    if (publicPath !== undefined) boundedDetails.path = publicPath;
    if (candidates !== undefined) {
      boundedDetails.candidates = candidates.slice(0, MAX_PUBLIC_CANDIDATES).map((candidate) => publicDiagnosticPath(candidate) ?? diagnosticFingerprint(candidate));
    }
    if (boundedCause !== undefined) boundedDetails.cause = boundedCause;
    super(PUBLIC_ERROR_MESSAGES[code], boundedCause === undefined ? undefined : { cause: boundedCause });
    this.name = "PackageImportError";
    this.code = code;
    this.details = Object.freeze(boundedDetails);
  }
}

export interface ImportLimits {
  maxProblemBytes: number;
  maxTextCharacters: number;
  maxPackageEntries: number;
  maxPackageDepth: number;
  maxAssetBytes: number;
  maxPdfPages: number;
  maxPdfCharacters: number;
  maxDocxZipEntries: number;
  maxDocxUncompressedBytes: number;
  maxDocxXmlPartBytes: number;
  maxDocxCharacters: number;
  maxMetadataBytes: number;
  maxMetadataZipEntries: number;
  maxMetadataUncompressedBytes: number;
  maxXlsxSheets: number;
  maxXlsxWorkbookBytes: number;
  maxXlsxRelationshipsBytes: number;
  maxXlsxWorksheetBytes: number;
  maxImageHeaderBytes: number;
  maxImagePixels: number;
}

export interface ImportOptions {
  limits?: Partial<ImportLimits>;
}

export interface ProblemExtractionMetadata {
  format: "markdown" | "text" | "pdf" | "docx";
  sourceBytes: number;
  sha256: string;
  extractedCharacters: number;
  extractor: string;
  pages?: number;
  zipEntries?: number;
  uncompressedBytes?: number;
}

export interface XlsxSheetMetadata {
  name: string;
  dimension?: string;
}

export interface XlsxAssetMetadata {
  kind: "spreadsheet";
  format: "xlsx";
  sheets: XlsxSheetMetadata[];
  zipEntries: number;
  uncompressedBytes: number;
}

export interface ImageAssetMetadata {
  kind: "image";
  format: "png" | "jpeg";
  width: number;
  height: number;
}

export interface BoundedAssetMetadata {
  kind: "bounded-inventory";
  format: "csv" | "json" | "xls" | "parquet";
}

export type AssetMetadata = XlsxAssetMetadata | ImageAssetMetadata | BoundedAssetMetadata;

export interface ImportWarning {
  code: "metadata_unreadable" | "metadata_limit";
  path: string;
  message: string;
}

export interface ImportedPackage {
  rootPath: string;
  problemPath: string;
  problemText: string;
  dataAssets: DataAsset[];
  dataPaths: Map<string, string>;
  problemMetadata?: ProblemExtractionMetadata;
  assetMetadata?: Record<string, AssetMetadata>;
  warnings?: ImportWarning[];
}
