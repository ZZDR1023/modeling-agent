import { PackageImportError, type ImportLimits, type ProblemExtractionMetadata } from "./types.js";
import { readBoundedZip } from "./zip-reader.js";
import { attributeValue, PACKAGE_RELATIONSHIPS_NAMESPACE, parseXml, WORDPROCESSINGML_NAMESPACE } from "./xml.js";

interface DocxExtraction {
  text: string;
  metadata: ProblemExtractionMetadata;
}

const WORD_DOCUMENT_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const OFFICE_DOCUMENT_RELATIONSHIP = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";

const DOCX_ZIP_CODES = {
  corrupt: "docx_corrupt",
  encrypted: "docx_encrypted",
  zipSlip: "docx_zip_slip",
  entryLimit: "docx_zip_entry_limit",
  uncompressedLimit: "docx_uncompressed_limit"
} as const;

function causeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateContentTypes(xml: Buffer, path: string): void {
  let documentContentType: string | undefined;
  parseXml(xml, {
    openTag(tag) {
      if (tag.local !== "Override" || attributeValue(tag, "PartName") !== "/word/document.xml") return;
      documentContentType = attributeValue(tag, "ContentType");
    }
  });
  if (documentContentType === undefined) {
    throw new PackageImportError("docx_corrupt", "DOCX content types do not declare word/document.xml.", { path });
  }
  if (/macroEnabled/i.test(documentContentType)) {
    throw new PackageImportError("docx_macro_enabled", "Macro-enabled Word packages are not allowed.", { path });
  }
  if (documentContentType !== WORD_DOCUMENT_CONTENT_TYPE) {
    throw new PackageImportError("docx_corrupt", `Unexpected DOCX main document content type: ${documentContentType}`, { path });
  }
}

function validatePackageRelationships(xml: Buffer, path: string): void {
  let officeDocumentTarget: string | undefined;
  parseXml(xml, {
    openTag(tag) {
      if (tag.uri !== PACKAGE_RELATIONSHIPS_NAMESPACE || tag.local !== "Relationship") return;
      if (attributeValue(tag, "TargetMode")?.toLowerCase() === "external") {
        throw new PackageImportError("docx_external_relationship", `External relationship is not allowed in ${path}.`, { path });
      }
      if (attributeValue(tag, "Type") === OFFICE_DOCUMENT_RELATIONSHIP) {
        officeDocumentTarget = attributeValue(tag, "Target");
      }
    }
  });
  if (officeDocumentTarget !== "word/document.xml" && officeDocumentTarget !== "/word/document.xml") {
    throw new PackageImportError("docx_corrupt", "DOCX package does not point to word/document.xml as its main document.", { path });
  }
}

function parseRelationships(xml: Buffer, path: string): void {
  parseXml(xml, {
    openTag(tag) {
      if (tag.uri !== PACKAGE_RELATIONSHIPS_NAMESPACE || tag.local !== "Relationship") return;
      if (attributeValue(tag, "TargetMode")?.toLowerCase() === "external") {
        throw new PackageImportError("docx_external_relationship", `External relationship is not allowed in ${path}.`, { path });
      }
    }
  });
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
    const archive = await readBoundedZip(
      path,
      { maxEntries: limits.maxDocxZipEntries, maxUncompressedBytes: limits.maxDocxUncompressedBytes },
      DOCX_ZIP_CODES,
      (name) => name === "[Content_Types].xml" || name === "word/document.xml" || name === "word/vbaProject.bin" || name.endsWith(".rels")
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
    validateContentTypes(contentTypes, path);
    validatePackageRelationships(packageRelationships, path);
    if (archive.entries.has("word/vbaProject.bin")) {
      throw new PackageImportError("docx_macro_enabled", "Macro-enabled Word packages are not allowed.", { path });
    }
    for (const [name, xml] of archive.entries) {
      if (name.endsWith(".rels")) parseRelationships(xml, name);
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
        extractor: "ooxml-body-v1",
        zipEntries: archive.entryCount,
        uncompressedBytes: archive.uncompressedBytes
      }
    };
  } catch (error) {
    if (error instanceof PackageImportError) throw error;
    const message = causeMessage(error);
    throw new PackageImportError("docx_corrupt", `Could not parse DOCX: ${message}`, { path, cause: message });
  }
}
