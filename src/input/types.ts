import type { DataAsset } from "../contracts/types.js";

export type PackageImportErrorCode =
  | "ambiguous_problem"
  | "problem_missing"
  | "problem_empty"
  | "problem_file_limit"
  | "problem_encoding"
  | "package_entry_limit"
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
    super(message, { cause: details.cause });
    this.name = "PackageImportError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export interface ImportLimits {
  maxProblemBytes: number;
  maxTextCharacters: number;
  maxPackageEntries: number;
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
