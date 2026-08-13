import { open as openFile } from "node:fs/promises";
import { posix } from "node:path";
import { PackageImportError, type ImportLimits, type ProblemExtractionMetadata } from "./types.js";
import { readBoundedZip } from "./zip-reader.js";
import { attributeValue, PACKAGE_RELATIONSHIPS_NAMESPACE, parseXml, WORDPROCESSINGML_NAMESPACE } from "./xml.js";

interface DocxExtraction {
  text: string;
  metadata: ProblemExtractionMetadata;
}

const WORD_DOCUMENT_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const OFFICE_DOCUMENT_RELATIONSHIP = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const OFFICE_DOCUMENT_RELATIONSHIP_KEY = OFFICE_DOCUMENT_RELATIONSHIP.toLowerCase();
const CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types";
const MAIN_DOCUMENT_PART = "/word/document.xml";
const PACKAGE_RELATIONSHIPS_PART = "_rels/.rels";
const CFB_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_SIGNATURES = [Buffer.from("PK\u0003\u0004", "binary"), Buffer.from("PK\u0005\u0006", "binary"), Buffer.from("PK\u0007\u0008", "binary")];
const MAX_CAUSE_LENGTH = 240;

const DOCX_ZIP_CODES = {
  corrupt: "docx_corrupt",
  encrypted: "docx_encrypted",
  zipSlip: "docx_zip_slip",
  entryLimit: "docx_zip_entry_limit",
  uncompressedLimit: "docx_uncompressed_limit"
} as const;

function causeMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\r\n\t]+/g, " ").slice(0, MAX_CAUSE_LENGTH);
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

function hasSignature(prefix: Buffer, signature: Buffer): boolean {
  return prefix.length >= signature.length && prefix.subarray(0, signature.length).equals(signature);
}

async function classifyContainer(path: string): Promise<void> {
  const prefix = await readPrefix(path, CFB_SIGNATURE.length);
  if (hasSignature(prefix, CFB_SIGNATURE)) {
    throw new PackageImportError("docx_encrypted", "Encrypted Office containers are not allowed.", { path });
  }
  if (!ZIP_SIGNATURES.some((signature) => hasSignature(prefix, signature))) {
    throw new PackageImportError("docx_corrupt", "DOCX is neither a ZIP package nor an encrypted Office container.", { path });
  }
}

function macroMarker(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (/macro|vba|activex/i.test(value)) return true;
  const decoded = decodePercentEscapes(value);
  return decoded !== undefined && /macro|vba|activex/i.test(decoded.value);
}

interface DecodedValue {
  value: string;
  changed: boolean;
}

function decodePercentEscapes(value: string): DecodedValue | undefined {
  if (!value.includes("%")) return { value, changed: false };
  let decoded = value;
  let changed = false;
  for (let depth = 0; depth < 4 && decoded.includes("%"); depth += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return undefined;
      decoded = next;
      changed = true;
    } catch {
      return undefined;
    }
  }
  return decoded.includes("%") ? undefined : { value: decoded, changed };
}

interface CanonicalPartName {
  value: string;
  changed: boolean;
}

function canonicalPartName(value: string): CanonicalPartName | undefined {
  const decoded = decodePercentEscapes(value);
  if (decoded === undefined
    || !decoded.value
    || /[\u0000-\u001f\u007f]/.test(decoded.value)
    || decoded.value.includes("\\")
    || decoded.value.includes("?")
    || decoded.value.includes("#")) return undefined;
  const normalized = decoded.value.normalize("NFC");
  const withLeadingSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  const segments = withLeadingSlash.split("/");
  const canonical: string[] = [];
  let changed = decoded.changed || normalized !== decoded.value;
  for (const [index, segment] of segments.entries()) {
    if (segment === "") {
      if (index !== 0) changed = true;
      continue;
    }
    if (segment === ".") {
      changed = true;
      continue;
    }
    if (segment === "..") return undefined;
    canonical.push(segment);
  }
  const result = `/${canonical.join("/")}`;
  return { value: result, changed: changed || result !== withLeadingSlash };
}

interface CanonicalArchiveEntry {
  key: string;
  partName: string;
}

function canonicalArchiveEntry(name: string): CanonicalArchiveEntry | undefined {
  const isDirectory = name.endsWith("/");
  const partName = isDirectory ? name.slice(0, -1) : name;
  if (!partName || name.startsWith("/") || partName.endsWith("/")) return undefined;
  const canonical = canonicalPartName(partName);
  if (canonical === undefined || canonical.changed || canonical.value !== `/${partName}`) return undefined;
  const normalized = partName.normalize("NFC");
  return { key: `/${normalized}`.toLowerCase(), partName };
}

function entryIndicatesMacro(entry: CanonicalArchiveEntry): boolean {
  const partName = entry.partName.normalize("NFC").toLowerCase();
  const baseName = posix.basename(partName);
  return macroMarker(partName) || (baseName.endsWith(".bin") && baseName.includes("office"));
}

function isContentTypesPart(name: string): boolean {
  return !name.endsWith("/") && name.toLowerCase() === "[content_types].xml";
}

function isRelationshipPart(name: string): boolean {
  return !name.endsWith("/") && name.toLowerCase().endsWith(".rels");
}

function validateContentTypes(xml: Buffer, path: string): void {
  const defaults = new Set<string>();
  const overrides = new Set<string>();
  let documentContentType: string | undefined;
  let documentOverrideCount = 0;
  let depth = 0;
  let rootSeen = false;

  parseXml(xml, {
    openTag(tag) {
      const parentDepth = depth;
      depth += 1;
      if (parentDepth === 0) {
        rootSeen = true;
        if (tag.uri !== CONTENT_TYPES_NAMESPACE || tag.local !== "Types") {
          throw new PackageImportError("docx_corrupt", "DOCX content types XML has an invalid root element.", { path });
        }
        return;
      }
      if (tag.uri !== CONTENT_TYPES_NAMESPACE || (tag.local !== "Default" && tag.local !== "Override")) return;
      if (parentDepth !== 1) {
        throw new PackageImportError("docx_corrupt", "DOCX content type declarations must be direct children of Types.", { path });
      }
      const contentType = attributeValue(tag, "ContentType")?.trim();
      if (!contentType) {
        throw new PackageImportError("docx_corrupt", "DOCX content type declaration is incomplete.", { path });
      }
      if (macroMarker(contentType)) {
        throw new PackageImportError("docx_macro_enabled", "Macro-enabled or VBA content types are not allowed.", { path });
      }

      if (tag.local === "Default") {
        const extension = attributeValue(tag, "Extension")?.trim();
        if (!extension || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(extension)) {
          throw new PackageImportError("docx_corrupt", "DOCX default content type has an invalid extension.", { path });
        }
        if (macroMarker(extension)) {
          throw new PackageImportError("docx_macro_enabled", "Macro-enabled or VBA content types are not allowed.", { path });
        }
        const key = extension.toLowerCase();
        if (defaults.has(key)) {
          throw new PackageImportError("docx_corrupt", "DOCX contains ambiguous default content type declarations.", { path });
        }
        defaults.add(key);
        return;
      }

      const partName = attributeValue(tag, "PartName")?.trim();
      if (!partName || !partName.startsWith("/")) {
        throw new PackageImportError("docx_corrupt", "DOCX override content type has an invalid part name.", { path });
      }
      if (macroMarker(partName)) {
        throw new PackageImportError("docx_macro_enabled", "VBA package parts are not allowed.", { path });
      }
      const canonical = canonicalPartName(partName);
      if (canonical === undefined || canonical.changed) {
        throw new PackageImportError("docx_corrupt", "DOCX override content type has an unsafe or non-canonical part name.", { path });
      }
      const key = canonical.value.toLowerCase();
      if (overrides.has(key)) {
        throw new PackageImportError("docx_corrupt", "DOCX contains ambiguous override content type declarations.", { path });
      }
      overrides.add(key);
      if (key === MAIN_DOCUMENT_PART) {
        if (canonical.value !== MAIN_DOCUMENT_PART) {
          throw new PackageImportError("docx_corrupt", "DOCX main document override has ambiguous casing.", { path });
        }
        documentOverrideCount += 1;
        documentContentType = contentType;
      }
    },
    closeTag() {
      depth -= 1;
    }
  });

  if (!rootSeen || depth !== 0 || documentOverrideCount !== 1 || documentContentType === undefined) {
    throw new PackageImportError("docx_corrupt", "DOCX content types must declare word/document.xml exactly once.", { path });
  }
  if (documentContentType !== WORD_DOCUMENT_CONTENT_TYPE) {
    throw new PackageImportError("docx_corrupt", "Unexpected DOCX main document content type.", { path });
  }
}

interface ResolvedRelationshipTarget {
  partName: string;
  changed: boolean;
}

function relationshipSourceDirectory(path: string): string[] | undefined {
  if (path === PACKAGE_RELATIONSHIPS_PART) return [];
  const segments = path.split("/");
  const fileName = segments.at(-1);
  if (fileName === undefined
    || segments.length < 2
    || segments.at(-2) !== "_rels"
    || !fileName.toLowerCase().endsWith(".rels")
    || fileName.length === ".rels".length) return undefined;
  return segments.slice(0, -2);
}

function resolveInternalTarget(target: string, relationshipPath: string): ResolvedRelationshipTarget | undefined {
  const sourceDirectory = relationshipSourceDirectory(relationshipPath);
  const trimmed = target.trim();
  const decoded = decodePercentEscapes(trimmed);
  if (sourceDirectory === undefined
    || decoded === undefined
    || !decoded.value
    || /[\u0000-\u001f\u007f]/.test(decoded.value)
    || decoded.value.includes("\\")
    || decoded.value.includes("?")
    || decoded.value.includes("#")
    || decoded.value.startsWith("//")
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded.value)) return undefined;

  const segments = decoded.value.startsWith("/") ? [] : [...sourceDirectory];
  let changed = target !== trimmed || decoded.changed;
  for (const [index, segment] of decoded.value.split("/").entries()) {
    if (segment === "") {
      if (index !== 0) changed = true;
      continue;
    }
    if (segment === ".") {
      changed = true;
      continue;
    }
    if (segment === "..") {
      changed = true;
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) return undefined;
  return { partName: `/${segments.join("/")}`, changed };
}

interface RelationshipSummary {
  officeDocumentTargets: ResolvedRelationshipTarget[];
}

function validateRelationships(xml: Buffer, path: string): RelationshipSummary {
  const ids = new Set<string>();
  const officeDocumentTargets: ResolvedRelationshipTarget[] = [];
  let depth = 0;
  let rootSeen = false;

  parseXml(xml, {
    openTag(tag) {
      const parentDepth = depth;
      depth += 1;
      if (parentDepth === 0) {
        rootSeen = true;
        if (tag.uri !== PACKAGE_RELATIONSHIPS_NAMESPACE || tag.local !== "Relationships") {
          throw new PackageImportError("docx_corrupt", "DOCX relationships XML has an invalid root element.", { path });
        }
        return;
      }
      if (tag.uri !== PACKAGE_RELATIONSHIPS_NAMESPACE || tag.local !== "Relationship") return;
      if (parentDepth !== 1) {
        throw new PackageImportError("docx_corrupt", "DOCX relationships must be direct children of Relationships.", { path });
      }
      const rawTargetMode = attributeValue(tag, "TargetMode");
      const targetMode = rawTargetMode === undefined ? undefined : decodePercentEscapes(rawTargetMode.trim())?.value.trim().toLowerCase();
      if (rawTargetMode !== undefined && (targetMode === undefined || targetMode !== "internal")) {
        throw new PackageImportError("docx_external_relationship", "Non-internal DOCX relationship mode is not allowed.", { path });
      }

      const id = attributeValue(tag, "Id")?.trim();
      const type = attributeValue(tag, "Type")?.trim();
      const target = attributeValue(tag, "Target");
      if (!id || ids.has(id) || !target?.trim()) {
        throw new PackageImportError("docx_corrupt", "DOCX relationships contain a missing or duplicate required value.", { path });
      }
      const resolvedTarget = resolveInternalTarget(target, path);
      if (resolvedTarget === undefined) {
        throw new PackageImportError("docx_external_relationship", "DOCX relationship target is external or escapes the package.", { path });
      }
      if (!type) {
        throw new PackageImportError("docx_corrupt", "DOCX relationships contain a missing or duplicate required value.", { path });
      }
      ids.add(id);
      if (macroMarker(type) || macroMarker(resolvedTarget.partName)) {
        throw new PackageImportError("docx_macro_enabled", "Macro or VBA relationships are not allowed.", { path });
      }
      if (decodePercentEscapes(type)?.value.toLowerCase() === OFFICE_DOCUMENT_RELATIONSHIP_KEY) officeDocumentTargets.push(resolvedTarget);
    },
    closeTag() {
      depth -= 1;
    }
  });

  if (!rootSeen || depth !== 0) {
    throw new PackageImportError("docx_corrupt", "DOCX relationships XML is incomplete.", { path });
  }
  return { officeDocumentTargets };
}

function validatePackageRelationships(summary: RelationshipSummary, path: string): void {
  if (summary.officeDocumentTargets.length !== 1) {
    throw new PackageImportError("docx_corrupt", "DOCX package must contain exactly one officeDocument relationship.", { path });
  }
  const target = summary.officeDocumentTargets[0];
  if (target === undefined || target.changed || target.partName !== MAIN_DOCUMENT_PART) {
    throw new PackageImportError("docx_corrupt", "DOCX package does not point to word/document.xml as its main document.", { path });
  }
}

function parseBody(xml: Buffer, path: string, characterLimit: number): string {
  const pieces: string[] = [];
  let collectingText = false;
  let characterCount = 0;
  const append = (text: string): void => {
    characterCount += text.length;
    if (characterCount > characterLimit) {
      throw new PackageImportError("docx_character_limit", `DOCX body exceeds ${characterLimit} characters.`, {
        path,
        actual: characterCount,
        limit: characterLimit
      });
    }
    pieces.push(text);
  };
  parseXml(xml, {
    openTag(tag) {
      if (tag.uri !== WORDPROCESSINGML_NAMESPACE) return;
      if (tag.local === "t" || tag.local === "instrText") collectingText = true;
      else if (tag.local === "tab") append("\t");
      else if (tag.local === "br" || tag.local === "cr") append("\n");
    },
    closeTag(tag) {
      if (tag.uri !== WORDPROCESSINGML_NAMESPACE) return;
      if (tag.local === "t" || tag.local === "instrText") collectingText = false;
      else if (tag.local === "p") append("\n");
      else if (tag.local === "tc") append("\t");
    },
    text(text) {
      if (collectingText) append(text);
    }
  });
  return pieces.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export async function extractDocx(
  path: string,
  identity: { sha256: string; sizeBytes: number },
  limits: ImportLimits
): Promise<DocxExtraction> {
  if (identity.sizeBytes > limits.maxProblemBytes) {
    throw new PackageImportError("problem_file_limit", `DOCX is ${identity.sizeBytes} bytes; limit is ${limits.maxProblemBytes}.`, {
      path,
      actual: identity.sizeBytes,
      limit: limits.maxProblemBytes
    });
  }
  try {
    await classifyContainer(path);
    const archive = await readBoundedZip(
      path,
      { maxEntries: limits.maxDocxZipEntries, maxUncompressedBytes: limits.maxDocxUncompressedBytes },
      DOCX_ZIP_CODES,
      (name) => isContentTypesPart(name) || name.toLowerCase() === "word/document.xml" || isRelationshipPart(name)
    );
    const contentTypes = archive.entries.get("[Content_Types].xml");
    const packageRelationships = archive.entries.get("_rels/.rels");
    const document = archive.entries.get("word/document.xml");
    if (!contentTypes || !packageRelationships || !document) {
      throw new PackageImportError("docx_corrupt", "DOCX is missing required OOXML parts.", { path });
    }
    for (const [name, xml] of archive.entries) {
      if (xml.length > limits.maxDocxXmlPartBytes) {
        throw new PackageImportError("docx_uncompressed_limit", `DOCX XML part ${name} exceeds ${limits.maxDocxXmlPartBytes} bytes.`, {
          path: name,
          actual: xml.length,
          limit: limits.maxDocxXmlPartBytes
        });
      }
    }
    const canonicalEntries = new Set<string>();
    for (const name of archive.entryNames) {
      if (macroMarker(name)) {
        throw new PackageImportError("docx_macro_enabled", "Macro or VBA package parts are not allowed.", { path });
      }
      const canonical = canonicalArchiveEntry(name);
      if (canonical === undefined) {
        throw new PackageImportError("docx_corrupt", "DOCX contains an unsafe or non-canonical package part name.", { path: name });
      }
      if (canonicalEntries.has(canonical.key)) {
        throw new PackageImportError("docx_corrupt", "DOCX contains case-ambiguous package part names.", { path: name });
      }
      canonicalEntries.add(canonical.key);
      if (entryIndicatesMacro(canonical)) {
        throw new PackageImportError("docx_macro_enabled", "Macro or VBA package parts are not allowed.", { path });
      }
    }
    validateContentTypes(contentTypes, path);
    const packageSummary = validateRelationships(packageRelationships, "_rels/.rels");
    validatePackageRelationships(packageSummary, "_rels/.rels");
    for (const [name, xml] of archive.entries) {
      if (name.toLowerCase().endsWith(".rels") && name.toLowerCase() !== "_rels/.rels") validateRelationships(xml, name);
    }
    const text = parseBody(document, path, limits.maxDocxCharacters);
    if (!text) throw new PackageImportError("docx_empty", "DOCX body contains no extractable text.", { path });
    if (text.length > limits.maxDocxCharacters) {
      throw new PackageImportError("docx_character_limit", `DOCX body exceeds ${limits.maxDocxCharacters} characters after normalization.`, {
        path,
        actual: text.length,
        limit: limits.maxDocxCharacters
      });
    }
    return {
      text,
      metadata: {
        format: "docx",
        sourceBytes: identity.sizeBytes,
        sha256: identity.sha256,
        extractedCharacters: text.length,
        extractor: "ooxml-body-v2",
        zipEntries: archive.entryCount,
        uncompressedBytes: archive.uncompressedBytes
      }
    };
  } catch (error) {
    if (error instanceof PackageImportError) throw error;
    throw new PackageImportError("docx_corrupt", "Could not parse DOCX.", { path, cause: causeMessage(error) });
  }
}
