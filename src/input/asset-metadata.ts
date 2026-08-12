import { open as openFile } from "node:fs/promises";
import { extname } from "node:path";
import {
  PackageImportError,
  type AssetMetadata,
  type ImageAssetMetadata,
  type ImportLimits,
  type XlsxSheetMetadata
} from "./types.js";
import { readBoundedZip } from "./zip-reader.js";
import {
  attributeValue,
  PACKAGE_RELATIONSHIPS_NAMESPACE,
  parseXml,
  SPREADSHEETML_NAMESPACE
} from "./xml.js";

const OFFICE_DOCUMENT_RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XLSX_ZIP_CODES = {
  corrupt: "metadata_unreadable",
  encrypted: "metadata_unreadable",
  zipSlip: "metadata_unreadable",
  entryLimit: "metadata_limit",
  uncompressedLimit: "metadata_limit"
} as const;

function checkedImage(format: ImageAssetMetadata["format"], width: number, height: number, path: string, limits: ImportLimits): ImageAssetMetadata {
  const pixels = width * height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new PackageImportError("metadata_unreadable", `Invalid ${format.toUpperCase()} dimensions.`, { path });
  }
  if (!Number.isSafeInteger(pixels) || pixels > limits.maxImagePixels) {
    throw new PackageImportError("metadata_limit", `Image has ${pixels} pixels; limit is ${limits.maxImagePixels}.`, {
      path,
      actual: pixels,
      limit: limits.maxImagePixels
    });
  }
  return { kind: "image", format, width, height };
}

async function readPrefix(path: string, length: number): Promise<Buffer> {
  const handle = await openFile(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function pngMetadata(bytes: Buffer, path: string, limits: ImportLimits): ImageAssetMetadata {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new PackageImportError("metadata_unreadable", "Invalid PNG header.", { path });
  }
  return checkedImage("png", bytes.readUInt32BE(16), bytes.readUInt32BE(20), path, limits);
}

const JPEG_START_OF_FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegMetadata(bytes: Buffer, path: string, limits: ImportLimits, sourceBytes: number): ImageAssetMetadata {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new PackageImportError("metadata_unreadable", "Invalid JPEG header.", { path });
  }
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2) throw new PackageImportError("metadata_unreadable", "Invalid JPEG segment length.", { path });
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (offset + 7 > bytes.length) break;
      return checkedImage("jpeg", bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3), path, limits);
    }
    offset += segmentLength;
  }
  const code = bytes.length < sourceBytes ? "metadata_limit" : "metadata_unreadable";
  throw new PackageImportError(code, "JPEG dimensions were not found within the bounded header scan.", {
    path,
    actual: bytes.length,
    limit: limits.maxImageHeaderBytes
  });
}

async function imageMetadata(path: string, sourceBytes: number, extension: string, limits: ImportLimits): Promise<ImageAssetMetadata> {
  const bytes = await readPrefix(path, Math.min(sourceBytes, limits.maxImageHeaderBytes));
  if (extension === ".png") return pngMetadata(bytes, path, limits);
  return jpegMetadata(bytes, path, limits, sourceBytes);
}

interface WorkbookSheet {
  name: string;
  relationshipId: string;
}

function workbookSheets(xml: Buffer, path: string, sheetLimit: number, byteLimit: number): WorkbookSheet[] {
  if (xml.length > byteLimit) {
    throw new PackageImportError("metadata_limit", `XLSX workbook metadata exceeds ${byteLimit} bytes.`, {
      path,
      actual: xml.length,
      limit: byteLimit
    });
  }
  const sheets: WorkbookSheet[] = [];
  parseXml(xml, {
    openTag(tag) {
      if (tag.uri !== SPREADSHEETML_NAMESPACE || tag.local !== "sheet") return;
      const name = attributeValue(tag, "name");
      const relationshipId = attributeValue(tag, "id", OFFICE_DOCUMENT_RELATIONSHIPS_NAMESPACE);
      if (!name || !relationshipId) throw new PackageImportError("metadata_unreadable", "XLSX sheet is missing a name or relationship id.", { path });
      sheets.push({ name, relationshipId });
      if (sheets.length > sheetLimit) {
        throw new PackageImportError("metadata_limit", `XLSX has more than ${sheetLimit} sheets.`, {
          path,
          actual: sheets.length,
          limit: sheetLimit
        });
      }
    }
  });
  return sheets;
}

function worksheetRelationships(xml: Buffer, path: string, byteLimit: number): Map<string, string> {
  if (xml.length > byteLimit) {
    throw new PackageImportError("metadata_limit", `XLSX relationships metadata exceeds ${byteLimit} bytes.`, {
      path,
      actual: xml.length,
      limit: byteLimit
    });
  }
  const relationships = new Map<string, string>();
  parseXml(xml, {
    openTag(tag) {
      if (tag.uri !== PACKAGE_RELATIONSHIPS_NAMESPACE || tag.local !== "Relationship") return;
      const id = attributeValue(tag, "Id");
      const target = attributeValue(tag, "Target");
      const type = attributeValue(tag, "Type");
      if (!id || !target || !type?.endsWith("/worksheet")) return;
      if (attributeValue(tag, "TargetMode")?.toLowerCase() === "external") {
        throw new PackageImportError("metadata_unreadable", "External XLSX worksheet relationship is not followed.", { path });
      }
      if (target.startsWith("/") || target.includes("\\") || target.split("/").includes("..")) {
        throw new PackageImportError("metadata_unreadable", `Unsafe XLSX worksheet target: ${target}`, { path });
      }
      relationships.set(id, `xl/${target}`);
    }
  });
  return relationships;
}

function worksheetDimension(xml: Buffer, path: string, limit: number): string | undefined {
  if (xml.length > limit) {
    throw new PackageImportError("metadata_limit", `XLSX worksheet metadata part exceeds ${limit} bytes.`, {
      path,
      actual: xml.length,
      limit
    });
  }
  let dimension: string | undefined;
  parseXml(xml, {
    openTag(tag) {
      if (dimension === undefined && tag.uri === SPREADSHEETML_NAMESPACE && tag.local === "dimension") {
        dimension = attributeValue(tag, "ref");
      }
    }
  });
  return dimension;
}

async function xlsxMetadata(path: string, sourceBytes: number, limits: ImportLimits): Promise<AssetMetadata> {
  if (sourceBytes > limits.maxMetadataBytes) {
    throw new PackageImportError("metadata_limit", `XLSX is ${sourceBytes} bytes; metadata inspection limit is ${limits.maxMetadataBytes}.`, {
      path,
      actual: sourceBytes,
      limit: limits.maxMetadataBytes
    });
  }
  try {
    const archive = await readBoundedZip(
      path,
      { maxEntries: limits.maxMetadataZipEntries, maxUncompressedBytes: limits.maxMetadataUncompressedBytes },
      XLSX_ZIP_CODES,
      (name) => name === "xl/workbook.xml" || name === "xl/_rels/workbook.xml.rels" || name.startsWith("xl/worksheets/")
    );
    const workbook = archive.entries.get("xl/workbook.xml");
    const relationshipXml = archive.entries.get("xl/_rels/workbook.xml.rels");
    if (!workbook || !relationshipXml) throw new PackageImportError("metadata_unreadable", "XLSX is missing workbook metadata parts.", { path });
    const sheetRecords = workbookSheets(workbook, path, limits.maxXlsxSheets, limits.maxXlsxWorkbookBytes);
    const relationships = worksheetRelationships(relationshipXml, path, limits.maxXlsxRelationshipsBytes);
    const sheets: XlsxSheetMetadata[] = sheetRecords.map((sheet) => {
      const target = relationships.get(sheet.relationshipId);
      if (!target) throw new PackageImportError("metadata_unreadable", `XLSX relationship ${sheet.relationshipId} is missing.`, { path });
      const worksheet = archive.entries.get(target);
      if (!worksheet) throw new PackageImportError("metadata_unreadable", `XLSX worksheet part is missing: ${target}`, { path });
      const dimension = worksheetDimension(worksheet, target, limits.maxXlsxWorksheetBytes);
      return dimension === undefined ? { name: sheet.name } : { name: sheet.name, dimension };
    });
    return {
      kind: "spreadsheet",
      format: "xlsx",
      sheets,
      zipEntries: archive.entryCount,
      uncompressedBytes: archive.uncompressedBytes
    };
  } catch (error) {
    if (error instanceof PackageImportError) throw error;
    const cause = error instanceof Error ? error.message : String(error);
    throw new PackageImportError("metadata_unreadable", `Could not read XLSX metadata: ${cause}`, { path, cause });
  }
}

export async function inspectAssetMetadata(
  path: string,
  sourceBytes: number,
  limits: ImportLimits
): Promise<AssetMetadata | undefined> {
  const extension = extname(path).toLowerCase();
  if (extension === ".xlsx") return xlsxMetadata(path, sourceBytes, limits);
  if (extension === ".png" || extension === ".jpg" || extension === ".jpeg") return imageMetadata(path, sourceBytes, extension, limits);
  if (extension === ".csv") return { kind: "bounded-inventory", format: "csv" };
  if (extension === ".json") return { kind: "bounded-inventory", format: "json" };
  if (extension === ".xls") return { kind: "bounded-inventory", format: "xls" };
  if (extension === ".parquet") return { kind: "bounded-inventory", format: "parquet" };
  return undefined;
}
