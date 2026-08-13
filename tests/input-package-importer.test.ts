import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  importPackage,
  type ImportLimits
} from "../src/input/package-importer.js";

const tempPackage = async (name: string): Promise<string> => mkdtemp(join(tmpdir(), `modeling-input-${name}-`));

function pdfDocument(pages: Array<string | readonly string[]>, encrypted = false): Buffer {
  const objects: string[] = [];
  const pageObjectNumbers: number[] = [];
  const fontObject = 3;
  const pagesObject = 2;
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (const [index, page] of pages.entries()) {
    const pageObject = 4 + index * 2;
    const contentObject = pageObject + 1;
    pageObjectNumbers.push(pageObject);
    const items = typeof page === "string" ? [page] : page;
    const operations = items.map((text, itemIndex) => {
      const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
      return `1 0 0 1 ${72 + itemIndex * 72} 720 Tm (${escaped}) Tj`;
    }).join(" ");
    const stream = `BT /F1 18 Tf ${operations} ET`;
    objects.push(`<< /Type /Page /Parent ${pagesObject} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObject} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`);
  }
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "ascii")];
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.concat(chunks).length);
    chunks.push(Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`, "ascii"));
  }
  if (encrypted) {
    objects.push("<< /Filter /Standard /V 1 /R 2 /Length 40 /O <0000000000000000000000000000000000000000000000000000000000000000> /U <0000000000000000000000000000000000000000000000000000000000000000> /P -4 >>");
    const encryptedObject = objects.length;
    offsets.push(Buffer.concat(chunks).length);
    chunks.push(Buffer.from(`${encryptedObject} 0 obj\n${objects[encryptedObject - 1]}\nendobj\n`, "ascii"));
  }
  const xrefOffset = Buffer.concat(chunks).length;
  const xref = [`xref`, `0 ${objects.length + 1}`, "0000000000 65535 f "];
  for (const offset of offsets.slice(1)) xref.push(`${String(offset).padStart(10, "0")} 00000 n `);
  const encryptionTrailer = encrypted
    ? ` /Encrypt ${objects.length} 0 R /ID [<00112233445566778899aabbccddeeff><00112233445566778899aabbccddeeff>]`
    : "";
  xref.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryptionTrailer} >>`, `startxref`, String(xrefOffset), "%%EOF\n");
  chunks.push(Buffer.from(`${xref.join("\n")}\n`, "ascii"));
  void pageObjectNumbers;
  return Buffer.concat(chunks);
}

type ZipEntry = { name: string; data: Buffer; compression?: "store" | "deflate"; unixMode?: number };

function zip(entries: ZipEntry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = entry.compression === "deflate" ? deflateRawSync(entry.data) : entry.data;
    const method = entry.compression === "deflate" ? 8 : 0;
    const crc32 = crc32Of(entry.data);
    const header = Buffer.alloc(30 + name.length);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(crc32, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    name.copy(header, 30);
    local.push(header, compressed);
    const directory = Buffer.alloc(46 + name.length);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(entry.unixMode === undefined ? 20 : (3 << 8) | 20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt16LE(0, 12);
    directory.writeUInt16LE(0, 14);
    directory.writeUInt32LE(crc32, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(entry.data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt16LE(0, 30);
    directory.writeUInt16LE(0, 32);
    directory.writeUInt16LE(0, 34);
    directory.writeUInt32LE(entry.unixMode === undefined ? 0 : (entry.unixMode << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    name.copy(directory, 46);
    central.push(directory);
    offset += header.length + compressed.length;
  }
  const localBytes = Buffer.concat(local);
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localBytes.length, 16);
  return Buffer.concat([localBytes, centralBytes, end]);
}

function encryptedZipEntryFixture(name: string, data: Buffer): Buffer {
  const archive = zip([{ name, data, compression: "deflate" }]);
  archive.writeUInt16LE(archive.readUInt16LE(6) | 0x0001, 6);
  const centralOffset = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  if (centralOffset < 0) throw new Error("Fixture ZIP has no central directory.");
  archive.writeUInt16LE(archive.readUInt16LE(centralOffset + 8) | 0x0001, centralOffset + 8);
  return archive;
}

function crc32Of(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const STANDARD_DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const OFFICE_DOCUMENT_RELATIONSHIP = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types";

function relationshipsXml(relationships: string): string {
  return `<?xml version="1.0"?><Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">${relationships}</Relationships>`;
}

function contentTypesXml(declarations: string): string {
  return `<?xml version="1.0"?><Types xmlns="${CONTENT_TYPES_NAMESPACE}">${declarations}</Types>`;
}

interface DocxOptions {
  extra?: ZipEntry[];
  mainContentType?: string;
  contentTypes?: string;
  packageRelationships?: string;
  documentXml?: string;
}

function docxDocument(text: string, options: DocxOptions = {}): Buffer {
  const mainContentType = options.mainContentType ?? STANDARD_DOCX_CONTENT_TYPE;
  const contentTypes = options.contentTypes ?? contentTypesXml(
    `<Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${mainContentType}"/>`
  );
  const packageRelationships = options.packageRelationships ?? relationshipsXml(
    `<Relationship Id="rId1" Type="${OFFICE_DOCUMENT_RELATIONSHIP}" Target="word/document.xml"/>`
  );
  const documentXml = options.documentXml
    ?? `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
  return zip([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes) },
    { name: "_rels/.rels", data: Buffer.from(packageRelationships) },
    { name: "word/document.xml", data: Buffer.from(documentXml) },
    ...(options.extra ?? [])
  ]);
}

function xlsxAsset(workbookRelationships?: string, extra: ZipEntry[] = []): Buffer {
  const relationships = workbookRelationships
    ?? "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet2.xml\"/></Relationships>";
  return zip([
    { name: "[Content_Types].xml", data: Buffer.from("<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/></Types>") },
    { name: "xl/workbook.xml", data: Buffer.from("<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"Data\" sheetId=\"1\" r:id=\"rId1\"/><sheet name=\"Summary\" sheetId=\"2\" r:id=\"rId2\"/></sheets></workbook>") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(relationships) },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from("<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><dimension ref=\"A1:C12\"/></worksheet>") },
    { name: "xl/worksheets/sheet2.xml", data: Buffer.from("<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><dimension ref=\"B2:D4\"/></worksheet>") },
    ...extra
  ]);
}

function png(width: number, height: number): Buffer {
  const value = Buffer.alloc(24);
  Buffer.from("\x89PNG\r\n\x1a\n", "binary").copy(value, 0);
  value.writeUInt32BE(13, 8);
  value.write("IHDR", 12, "ascii");
  value.writeUInt32BE(width, 16);
  value.writeUInt32BE(height, 20);
  return value;
}

async function expectImportCode(operation: Promise<unknown>, code: string): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code });
}

describe("safe package importer", () => {
  it("extracts a real PDF and records bounded provenance", async () => {
    const root = await tempPackage("pdf");
    const source = pdfDocument(["PDF problem statement"]);
    await writeFile(join(root, "problem.pdf"), source);
    const imported = await importPackage(root);
    expect(imported.problemText).toContain("PDF problem statement");
    expect(imported.problemMetadata).toMatchObject({ format: "pdf", pages: 1, extractedCharacters: expect.any(Number), extractor: expect.stringContaining("pdfjs") });
    expect(imported.problemMetadata?.sha256).toBe(createHash("sha256").update(source).digest("hex"));
    expect(imported.problemPath).toBe(join(root, "problem.pdf"));
  });

  it("rejects empty, corrupt, and over-page PDFs with structured failures", async () => {
    const empty = await tempPackage("pdf-empty");
    await writeFile(join(empty, "problem.pdf"), pdfDocument([""]));
    await expectImportCode(importPackage(empty), "pdf_empty");

    const corrupt = await tempPackage("pdf-corrupt");
    await writeFile(join(corrupt, "problem.pdf"), Buffer.from("not a pdf"));
    await expectImportCode(importPackage(corrupt), "pdf_corrupt");

    const encrypted = await tempPackage("pdf-encrypted");
    await writeFile(join(encrypted, "problem.pdf"), pdfDocument(["secret"], true));
    await expectImportCode(importPackage(encrypted), "pdf_encrypted");

    const tooManyPages = await tempPackage("pdf-pages");
    await writeFile(join(tooManyPages, "problem.pdf"), pdfDocument(["one", "two"]));
    const limits: Partial<ImportLimits> = { maxPdfPages: 1 };
    await expectImportCode(importPackage(tooManyPages, { limits }), "pdf_page_limit");

    const tooManyCharacters = await tempPackage("pdf-characters");
    await writeFile(join(tooManyCharacters, "problem.pdf"), pdfDocument(["0123456789"]));
    await expectImportCode(importPackage(tooManyCharacters, { limits: { maxPdfCharacters: 5 } }), "pdf_character_limit");

    const pageSeparators = await tempPackage("pdf-page-separators");
    await writeFile(join(pageSeparators, "problem.pdf"), pdfDocument(["A", "B"]));
    await expectImportCode(importPackage(pageSeparators, { limits: { maxPdfCharacters: 3 } }), "pdf_character_limit");
    const exactPageLimit = await importPackage(pageSeparators, { limits: { maxPdfCharacters: 4 } });
    expect(exactPageLimit.problemText).toBe("A\n\nB");
    expect(exactPageLimit.problemText.length).toBe(4);

    const itemSeparators = await tempPackage("pdf-item-separators");
    await writeFile(join(itemSeparators, "problem.pdf"), pdfDocument([["A", "B"]]));
    await expectImportCode(importPackage(itemSeparators, { limits: { maxPdfCharacters: 2 } }), "pdf_character_limit");
    const exactItemLimit = await importPackage(itemSeparators, { limits: { maxPdfCharacters: 3 } });
    expect(exactItemLimit.problemText).toBe("A B");
    expect(exactItemLimit.problemText.length).toBe(3);

    const normalizedItems = await tempPackage("pdf-normalized-items");
    await writeFile(join(normalizedItems, "problem.pdf"), pdfDocument([[" A ", " B "]]));
    const normalized = await importPackage(normalizedItems, { limits: { maxPdfCharacters: 3 } });
    expect(normalized.problemText).toBe("A B");
    expect(normalized.problemText.length).toBe(3);

    const tooManyBytes = await tempPackage("pdf-bytes");
    await writeFile(join(tooManyBytes, "problem.pdf"), pdfDocument(["text"]));
    await expectImportCode(importPackage(tooManyBytes, { limits: { maxProblemBytes: 10 } }), "problem_file_limit");
  });

  it("extracts only DOCX body text", async () => {
    const root = await tempPackage("docx");
    await writeFile(join(root, "problem.docx"), docxDocument("DOCX body text"));
    const imported = await importPackage(root);
    expect(imported.problemText).toContain("DOCX body text");
    expect(imported.problemMetadata).toMatchObject({ format: "docx", extractedCharacters: 14, extractor: "ooxml-body-v2" });
  });

  it("rejects corrupt and macro-enabled DOCX packages", async () => {
    const corrupt = await tempPackage("docx-corrupt");
    await writeFile(join(corrupt, "problem.docx"), Buffer.from("not a zip"));
    await expectImportCode(importPackage(corrupt), "docx_corrupt");

    const cfbEncrypted = await tempPackage("docx-cfb-encrypted");
    const privateBody = "PRIVATE-DOCUMENT-BODY-MUST-NOT-LEAK";
    const cfb = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.from(`EncryptedPackage\0${privateBody}`)
    ]);
    await writeFile(join(cfbEncrypted, "problem.docx"), cfb);
    const encryptedError = await importPackage(cfbEncrypted).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(encryptedError).toMatchObject({ code: "docx_encrypted" });
    expect(JSON.stringify(encryptedError)).not.toContain(privateBody);
    expect(encryptedError instanceof Error ? encryptedError.message : String(encryptedError)).not.toContain(privateBody);
    expect(encryptedError && typeof encryptedError === "object" && "details" in encryptedError
      ? (encryptedError as { details?: { cause?: string } }).details?.cause
      : undefined).toBeUndefined();

    const encryptedEntry = await tempPackage("docx-encrypted-entry");
    await writeFile(join(encryptedEntry, "problem.docx"), encryptedZipEntryFixture(
      "[Content_Types].xml",
      Buffer.from("encrypted")
    ));
    await expectImportCode(importPackage(encryptedEntry), "docx_encrypted");

    const crcMismatch = await tempPackage("docx-crc");
    const tampered = docxDocument("body");
    const marker = tampered.indexOf(Buffer.from("body"));
    tampered[marker] = "B".charCodeAt(0);
    await writeFile(join(crcMismatch, "problem.docx"), tampered);
    await expectImportCode(importPackage(crcMismatch), "docx_corrupt");

    const duplicate = await tempPackage("docx-duplicate");
    await writeFile(join(duplicate, "problem.docx"), docxDocument("body", {
      extra: [{ name: "word/document.xml", data: Buffer.from("<not-the-real-document/>") }]
    }));
    await expectImportCode(importPackage(duplicate), "docx_corrupt");

    const macro = await tempPackage("docx-macro");
    const document = docxDocument("body", {
      extra: [{ name: "word/vbaProject.bin", data: Buffer.from("not executed") }],
      mainContentType: "application/vnd.ms-word.document.macroEnabled.main+xml"
    });
    await writeFile(join(macro, "problem.docx"), document);
    await expectImportCode(importPackage(macro), "docx_macro_enabled");
  });

  it("rejects symlink entries inside DOCX archives", async () => {
    const archiveSymlink = await tempPackage("docx-archive-symlink");
    await writeFile(join(archiveSymlink, "problem.docx"), docxDocument("body", {
      extra: [{ name: "word/linked.bin", data: Buffer.alloc(0), unixMode: 0o120777 }]
    }));
    await expectImportCode(importPackage(archiveSymlink), "docx_zip_slip");
  });

  it("rejects DOCX external relationships and ZIP slip names", async () => {
    const external = await tempPackage("docx-external");
    await writeFile(join(external, "problem.docx"), docxDocument("body", {
      extra: [{ name: "word/_rels/document.xml.rels", data: Buffer.from(relationshipsXml(
        "<Relationship Id=\"rId9\" TargetMode=\"External\" Target=\"https://example.invalid\"/>"
      )) }]
    }));
    await expectImportCode(importPackage(external), "docx_external_relationship");

    const paddedExternal = await tempPackage("docx-padded-external");
    const querySecret = "relationship-query-secret";
    await writeFile(join(paddedExternal, "problem.docx"), docxDocument("body", {
      extra: [{ name: "word/_rels/document.xml.rels", data: Buffer.from(relationshipsXml(
        `<Relationship Id="rId9" TargetMode=" External " Target="https://example.invalid/path?token=${querySecret}"/>`
      )) }]
    }));
    const externalError = await importPackage(paddedExternal).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(externalError).toMatchObject({ code: "docx_external_relationship" });
    expect(JSON.stringify(externalError)).not.toContain(querySecret);
    expect(externalError instanceof Error ? externalError.message : String(externalError)).not.toContain(querySecret);

    const unknownMode = await tempPackage("docx-unknown-mode");
    await writeFile(join(unknownMode, "problem.docx"), docxDocument("body", {
      extra: [{ name: "word/_rels/document.xml.rels", data: Buffer.from(relationshipsXml(
        "<Relationship Id=\"rId9\" TargetMode=\"remote\" Target=\"elsewhere.xml\"/>"
      )) }]
    }));
    await expectImportCode(importPackage(unknownMode), "docx_external_relationship");

    const encodedExternal = await tempPackage("docx-encoded-external");
    await writeFile(join(encodedExternal, "problem.docx"), docxDocument("body", {
      extra: [{ name: "word/_rels/document.xml.rels", data: Buffer.from(relationshipsXml(
        "<Relationship Id=\"rId9\" Type=\"urn:example:link\" TargetMode=\"%45xternal\" Target=\"https%3A%2F%2Fexample.invalid%2Fsecret\"/>"
      )) }]
    }));
    await expectImportCode(importPackage(encodedExternal), "docx_external_relationship");

    const encodedEscape = await tempPackage("docx-encoded-escape");
    await writeFile(join(encodedEscape, "problem.docx"), docxDocument("body", {
      extra: [{ name: "word/_rels/document.xml.rels", data: Buffer.from(relationshipsXml(
        "<Relationship Id=\"rId9\" Type=\"urn:example:link\" TargetMode=\"internal\" Target=\"%2E%2E%2F%2E%2E%2Foutside.xml\"/>"
      )) }]
    }));
    await expectImportCode(importPackage(encodedEscape), "docx_external_relationship");

    const explicitInternal = await tempPackage("docx-internal-mode");
    await writeFile(join(explicitInternal, "problem.docx"), docxDocument("body", {
      extra: [{ name: "word/_rels/document.xml.rels", data: Buffer.from(relationshipsXml(
        "<Relationship Id=\"rId9\" Type=\"urn:example:styles\" TargetMode=\" Internal \" Target=\"styles.xml\"/>"
      )) }]
    }));
    expect((await importPackage(explicitInternal)).problemText).toBe("body");

    const entity = await tempPackage("docx-entity");
    await writeFile(join(entity, "problem.docx"), docxDocument("body", {
      extra: [{ name: "word/_rels/document.xml.rels", data: Buffer.from("<!DOCTYPE Relationships [<!ENTITY xxe SYSTEM \"file:///etc/passwd\">]><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">&xxe;</Relationships>") }]
    }));
    await expectImportCode(importPackage(entity), "docx_corrupt");

    const traversal = await tempPackage("docx-slip");
    await writeFile(join(traversal, "problem.docx"), docxDocument("body", {
      extra: [{ name: "../outside.xml", data: Buffer.from("x") }]
    }));
    await expectImportCode(importPackage(traversal), "docx_zip_slip");
  });

  it("rejects ambiguous DOCX relationships and content types", async () => {
    const twoMainRelationships = await tempPackage("docx-two-main-relationships");
    await writeFile(join(twoMainRelationships, "problem.docx"), docxDocument("body", {
      packageRelationships: relationshipsXml(
        `<Relationship Id="rId1" Type="${OFFICE_DOCUMENT_RELATIONSHIP}" Target="word/document.xml"/>`
        + `<Relationship Id="rId2" Type="${OFFICE_DOCUMENT_RELATIONSHIP}" Target="word/document.xml"/>`
      )
    }));
    await expectImportCode(importPackage(twoMainRelationships), "docx_corrupt");

    const normalizedMainRelationship = await tempPackage("docx-normalized-main-relationship");
    await writeFile(join(normalizedMainRelationship, "problem.docx"), docxDocument("body", {
      packageRelationships: relationshipsXml(
        `<Relationship Id="rId1" Type="${OFFICE_DOCUMENT_RELATIONSHIP}" Target="word/document.xml"/>`
        + `<Relationship Id="rId2" Type="${OFFICE_DOCUMENT_RELATIONSHIP.toUpperCase()}" Target="word/document.xml"/>`
      )
    }));
    await expectImportCode(importPackage(normalizedMainRelationship), "docx_corrupt");

    const duplicatePackageId = await tempPackage("docx-duplicate-package-id");
    await writeFile(join(duplicatePackageId, "problem.docx"), docxDocument("body", {
      packageRelationships: relationshipsXml(
        `<Relationship Id="rId1" Type="${OFFICE_DOCUMENT_RELATIONSHIP}" Target="word/document.xml"/>`
        + "<Relationship Id=\"rId1\" Type=\"urn:example:styles\" Target=\"word/styles.xml\"/>"
      )
    }));
    await expectImportCode(importPackage(duplicatePackageId), "docx_corrupt");

    const paddedDuplicatePackageId = await tempPackage("docx-padded-duplicate-package-id");
    await writeFile(join(paddedDuplicatePackageId, "problem.docx"), docxDocument("body", {
      packageRelationships: relationshipsXml(
        `<Relationship Id="rId1" Type="${OFFICE_DOCUMENT_RELATIONSHIP}" Target="word/document.xml"/>`
        + "<Relationship Id=\" rId1 \" Type=\"urn:example:styles\" Target=\"word/styles.xml\"/>"
      )
    }));
    await expectImportCode(importPackage(paddedDuplicatePackageId), "docx_corrupt");

    const nonCanonicalMainTarget = await tempPackage("docx-noncanonical-main-target");
    await writeFile(join(nonCanonicalMainTarget, "problem.docx"), docxDocument("body", {
      packageRelationships: relationshipsXml(
        `<Relationship Id="rId1" Type="${OFFICE_DOCUMENT_RELATIONSHIP}" Target="word/./document.xml"/>`
      )
    }));
    await expectImportCode(importPackage(nonCanonicalMainTarget), "docx_corrupt");

    const duplicatePartId = await tempPackage("docx-duplicate-part-id");
    await writeFile(join(duplicatePartId, "problem.docx"), docxDocument("body", {
      extra: [{ name: "word/_rels/document.xml.rels", data: Buffer.from(relationshipsXml(
        "<Relationship Id=\"rId9\" Type=\"urn:example:one\" Target=\"one.xml\"/>"
        + "<Relationship Id=\"rId9\" Type=\"urn:example:two\" Target=\"two.xml\"/>"
      )) }]
    }));
    await expectImportCode(importPackage(duplicatePartId), "docx_corrupt");

    const duplicateOverride = await tempPackage("docx-duplicate-override");
    await writeFile(join(duplicateOverride, "problem.docx"), docxDocument("body", {
      contentTypes: contentTypesXml(
        `<Default Extension="xml" ContentType="application/xml"/>`
        + `<Override PartName="/word/document.xml" ContentType="${STANDARD_DOCX_CONTENT_TYPE}"/>`
        + `<Override PartName="/word/document.xml" ContentType="${STANDARD_DOCX_CONTENT_TYPE}"/>`
      )
    }));
    await expectImportCode(importPackage(duplicateOverride), "docx_corrupt");

    const conflictingOverride = await tempPackage("docx-conflicting-override");
    await writeFile(join(conflictingOverride, "problem.docx"), docxDocument("body", {
      contentTypes: contentTypesXml(
        `<Default Extension="xml" ContentType="application/xml"/>`
        + `<Override PartName="/word/document.xml" ContentType="${STANDARD_DOCX_CONTENT_TYPE}"/>`
        + "<Override PartName=\"/WORD/document.xml\" ContentType=\"application/xml\"/>"
      )
    }));
    await expectImportCode(importPackage(conflictingOverride), "docx_corrupt");

    const ambiguousDefault = await tempPackage("docx-ambiguous-default");
    await writeFile(join(ambiguousDefault, "problem.docx"), docxDocument("body", {
      contentTypes: contentTypesXml(
        `<Default Extension="xml" ContentType="application/xml"/>`
        + `<Default Extension="XML" ContentType="text/xml"/>`
        + `<Override PartName="/word/document.xml" ContentType="${STANDARD_DOCX_CONTENT_TYPE}"/>`
      )
    }));
    await expectImportCode(importPackage(ambiguousDefault), "docx_corrupt");

    const dotSegmentOverride = await tempPackage("docx-dot-segment-override");
    await writeFile(join(dotSegmentOverride, "problem.docx"), docxDocument("body", {
      contentTypes: contentTypesXml(
        `<Default Extension="xml" ContentType="application/xml"/>`
        + `<Override PartName="/word/document.xml" ContentType="${STANDARD_DOCX_CONTENT_TYPE}"/>`
        + "<Override PartName=\"/word/./document.xml\" ContentType=\"application/xml\"/>"
      )
    }));
    await expectImportCode(importPackage(dotSegmentOverride), "docx_corrupt");

    const nonCanonicalOnly = await tempPackage("docx-noncanonical-main-override");
    await writeFile(join(nonCanonicalOnly, "problem.docx"), docxDocument("body", {
      contentTypes: contentTypesXml(
        `<Default Extension="xml" ContentType="application/xml"/>`
        + `<Override PartName="/word/./document.xml" ContentType="${STANDARD_DOCX_CONTENT_TYPE}"/>`
      )
    }));
    await expectImportCode(importPackage(nonCanonicalOnly), "docx_corrupt");

    const caseAmbiguousEntries = await tempPackage("docx-case-ambiguous-entries");
    await writeFile(join(caseAmbiguousEntries, "problem.docx"), docxDocument("body", {
      extra: [{ name: "WORD/DOCUMENT.XML", data: Buffer.from("<not-used/>") }]
    }));
    await expectImportCode(importPackage(caseAmbiguousEntries), "docx_corrupt");

    const encodedEntry = await tempPackage("docx-encoded-entry");
    await writeFile(join(encodedEntry, "problem.docx"), docxDocument("body", {
      extra: [{ name: "word/%2e%2e/hidden.xml", data: Buffer.from("<not-used/>") }]
    }));
    await expectImportCode(importPackage(encodedEntry), "docx_corrupt");
  });

  it("rejects macro and VBA indicators anywhere in a DOCX package", async () => {
    const macroRelationship = await tempPackage("docx-renamed-macro-relationship");
    await writeFile(join(macroRelationship, "problem.docx"), docxDocument("body", {
      extra: [
        { name: "word/hidden-payload.bin", data: Buffer.from("PRIVATE VBA PAYLOAD") },
        { name: "word/_rels/document.xml.rels", data: Buffer.from(relationshipsXml(
          "<Relationship Id=\"rId9\" Type=\"http://schemas.microsoft.com/office/2006/relationships/vbaProject\" Target=\"hidden-payload.bin\"/>"
        )) }
      ]
    }));
    await expectImportCode(importPackage(macroRelationship), "docx_macro_enabled");

    const combinedIndicators = await tempPackage("docx-renamed-macro-combined");
    await writeFile(join(combinedIndicators, "problem.docx"), docxDocument("body", {
      extra: [
        { name: "word/hidden-payload.bin", data: Buffer.from("PRIVATE VBA PAYLOAD") },
        { name: "word/_rels/document.xml.rels", data: Buffer.from(relationshipsXml(
          "<Relationship Id=\"rId9\" Type=\"http://schemas.microsoft.com/office/2006/relationships/vbaProject\" Target=\"hidden-payload.bin\"/>"
        )) }
      ],
      contentTypes: contentTypesXml(
        `<Default Extension="xml" ContentType="application/xml"/>`
        + "<Default Extension=\"bin\" ContentType=\"application/vnd.ms-office.vbaProject\"/>"
        + `<Override PartName="/word/document.xml" ContentType="${STANDARD_DOCX_CONTENT_TYPE}"/>`
      )
    }));
    await expectImportCode(importPackage(combinedIndicators), "docx_macro_enabled");

    const macroDefault = await tempPackage("docx-macro-default");
    await writeFile(join(macroDefault, "problem.docx"), docxDocument("body", {
      contentTypes: contentTypesXml(
        `<Default Extension="xml" ContentType="application/xml"/>`
        + "<Default Extension=\"vba\" ContentType=\"application/vnd.ms-office.vbaProject\"/>"
        + `<Override PartName="/word/document.xml" ContentType="${STANDARD_DOCX_CONTENT_TYPE}"/>`
      )
    }));
    await expectImportCode(importPackage(macroDefault), "docx_macro_enabled");

    const macroOverride = await tempPackage("docx-macro-override");
    await writeFile(join(macroOverride, "problem.docx"), docxDocument("body", {
      contentTypes: contentTypesXml(
        `<Default Extension="xml" ContentType="application/xml"/>`
        + `<Override PartName="/word/document.xml" ContentType="${STANDARD_DOCX_CONTENT_TYPE}"/>`
        + "<Override PartName=\"/custom/payload.bin\" ContentType=\"application/vnd.ms-word.document.macroEnabled.12\"/>"
      )
    }));
    await expectImportCode(importPackage(macroOverride), "docx_macro_enabled");

    const renamedEntry = await tempPackage("docx-vba-entry-case");
    await writeFile(join(renamedEntry, "problem.docx"), docxDocument("body", {
      extra: [{ name: "custom/VBAPROJECT.BIN", data: Buffer.from("not opened") }]
    }));
    await expectImportCode(importPackage(renamedEntry), "docx_macro_enabled");

    const encodedMacroRelationship = await tempPackage("docx-encoded-macro-relationship");
    await writeFile(join(encodedMacroRelationship, "problem.docx"), docxDocument("body", {
      extra: [{ name: "word/_rels/document.xml.rels", data: Buffer.from(relationshipsXml(
        "<Relationship Id=\"rId9\" Type=\"urn:example:%76baProject\" Target=\"styles.xml\"/>"
      )) }]
    }));
    await expectImportCode(importPackage(encodedMacroRelationship), "docx_macro_enabled");

    const encodedMacroEntry = await tempPackage("docx-encoded-macro-entry");
    await writeFile(join(encodedMacroEntry, "problem.docx"), docxDocument("body", {
      extra: [{ name: "custom/%76baProject.bin", data: Buffer.from("not opened") }]
    }));
    await expectImportCode(importPackage(encodedMacroEntry), "docx_macro_enabled");
  });

  it("enforces DOCX entry, decompressed-byte, and character limits", async () => {
    const entries = await tempPackage("docx-entries");
    await writeFile(join(entries, "problem.docx"), docxDocument("body", {
      extra: [
        { name: "word/extra.xml", data: Buffer.from("x") },
        { name: "word/extra2.xml", data: Buffer.from("x") }
      ]
    }));
    await expectImportCode(importPackage(entries, { limits: { maxDocxZipEntries: 4 } }), "docx_zip_entry_limit");

    const bytes = await tempPackage("docx-bytes");
    await writeFile(join(bytes, "problem.docx"), docxDocument("body", {
      extra: [{ name: "word/large.xml", data: Buffer.alloc(500, 65) }]
    }));
    await expectImportCode(importPackage(bytes, { limits: { maxDocxUncompressedBytes: 100 } }), "docx_uncompressed_limit");

    const characters = await tempPackage("docx-characters");
    await writeFile(join(characters, "problem.docx"), docxDocument("0123456789"));
    await expectImportCode(importPackage(characters, { limits: { maxDocxCharacters: 5 } }), "docx_character_limit");
  });

  it("rejects invalid traversal limits before touching the package path", async () => {
    await expect(importPackage(join(tmpdir(), "missing-input-package"), {
      limits: { maxPackageDepth: 0 }
    })).rejects.toThrow(TypeError);
  });

  it("bounds total package traversal entries and depth before filtering", async () => {
    const unsupported = await tempPackage("package-entry-limit");
    await writeFile(join(unsupported, "problem.md"), "problem");
    for (let index = 0; index < 20; index += 1) {
      await writeFile(join(unsupported, `ignored-${index}.bin`), "ignored");
    }
    await expectImportCode(importPackage(unsupported, { limits: { maxPackageEntries: 2 } }), "package_entry_limit");

    const hidden = await tempPackage("hidden-entry-limit");
    await writeFile(join(hidden, "problem.md"), "problem");
    await mkdir(join(hidden, ".ignored"));
    await writeFile(join(hidden, ".ignored", "private.bin"), "private");
    await expectImportCode(importPackage(hidden, { limits: { maxPackageEntries: 1 } }), "package_entry_limit");

    const hiddenNoRecursion = await tempPackage("hidden-no-recursion");
    await writeFile(join(hiddenNoRecursion, "problem.md"), "problem");
    await mkdir(join(hiddenNoRecursion, ".ignored"));
    for (let index = 0; index < 20; index += 1) {
      await writeFile(join(hiddenNoRecursion, ".ignored", `private-${index}.bin`), "private");
    }
    expect((await importPackage(hiddenNoRecursion, { limits: { maxPackageEntries: 2 } })).problemText).toBe("problem");

    const deep = await tempPackage("package-depth-limit");
    await mkdir(join(deep, "one", "two", "three"), { recursive: true });
    await writeFile(join(deep, "one", "two", "three", "problem.md"), "problem");
    await expectImportCode(importPackage(deep, { limits: { maxPackageDepth: 2 } }), "package_depth_limit");

    const exactDepth = await tempPackage("package-depth-exact");
    await mkdir(join(exactDepth, "one", "two"), { recursive: true });
    await writeFile(join(exactDepth, "one", "two", "problem.md"), "problem");
    expect((await importPackage(exactDepth, { limits: { maxPackageDepth: 2 } })).problemText).toBe("problem");
  });

  it("fails when same-priority problem candidates are ambiguous", async () => {
    const root = await tempPackage("ambiguous");
    await writeFile(join(root, "problem.md"), "markdown");
    await writeFile(join(root, "problem.markdown"), "other markdown");
    await expectImportCode(importPackage(root), "ambiguous_problem");
  });

  it("uses documented precedence and treats lower-priority statements as assets", async () => {
    const root = await tempPackage("precedence");
    await writeFile(join(root, "problem.txt"), "text wins");
    await writeFile(join(root, "problem.pdf"), pdfDocument(["pdf loses"]));
    await writeFile(join(root, "problem.docx"), docxDocument("docx loses"));
    const imported = await importPackage(root);
    expect(imported.problemText).toBe("text wins");
    expect(imported.dataAssets.map((asset) => asset.relative_path)).toEqual(["problem.docx", "problem.pdf"]);
  });

  it("rejects root and nested symlinks", async () => {
    const target = await tempPackage("symlink-target");
    await writeFile(join(target, "problem.md"), "problem");
    const parent = await tempPackage("symlink-parent");
    const link = join(parent, "linked-package");
    await symlink(target, link, "dir");
    await expectImportCode(importPackage(link), "symlink_input");

    const root = await tempPackage("symlink-nested");
    await writeFile(join(root, "problem.md"), "problem");
    await symlink(join(root, "problem.md"), join(root, "problem-link.md"));
    await expectImportCode(importPackage(root), "symlink_input");

    const hiddenRoot = await tempPackage("symlink-hidden");
    await writeFile(join(hiddenRoot, "problem.md"), "problem");
    await symlink(join(hiddenRoot, "problem.md"), join(hiddenRoot, ".hidden-link.md"));
    await expectImportCode(importPackage(hiddenRoot), "symlink_input");
  });

  it("keeps raw asset bytes and SHA while exposing bounded XLSX and image metadata", async () => {
    const root = await tempPackage("inventory");
    const spreadsheet = xlsxAsset();
    const picture = png(3, 2);
    await writeFile(join(root, "problem.md"), "problem");
    await writeFile(join(root, "data.xlsx"), spreadsheet);
    await writeFile(join(root, "plot.png"), picture);
    const beforeSpreadsheet = await readFile(join(root, "data.xlsx"));
    const beforePicture = await readFile(join(root, "plot.png"));

    const imported = await importPackage(root);
    const spreadsheetAsset = imported.dataAssets.find((asset) => asset.relative_path === "data.xlsx");
    const pictureAsset = imported.dataAssets.find((asset) => asset.relative_path === "plot.png");
    expect(spreadsheetAsset?.sha256).toBe(createHash("sha256").update(spreadsheet).digest("hex"));
    expect(spreadsheetAsset?.size_bytes).toBe(spreadsheet.length);
    expect(pictureAsset?.sha256).toBe(createHash("sha256").update(picture).digest("hex"));
    expect(pictureAsset?.size_bytes).toBe(picture.length);
    expect(imported.assetMetadata?.[spreadsheetAsset?.artifact_id ?? ""]).toMatchObject({ format: "xlsx", sheets: [{ name: "Data", dimension: "A1:C12" }, { name: "Summary", dimension: "B2:D4" }] });
    expect(imported.assetMetadata?.[pictureAsset?.artifact_id ?? ""]).toMatchObject({ format: "png", width: 3, height: 2 });
    expect(await readFile(join(root, "data.xlsx"))).toEqual(beforeSpreadsheet);
    expect(await readFile(join(root, "plot.png"))).toEqual(beforePicture);
  });

  it("surfaces unreadable and over-limit metadata as explicit warnings", async () => {
    const root = await tempPackage("metadata-warning");
    await writeFile(join(root, "problem.md"), "problem");
    await writeFile(join(root, "bad.png"), Buffer.from("not an image"));
    await writeFile(join(root, "bad.xlsx"), Buffer.from("not a workbook"));
    await writeFile(join(root, "large.png"), png(10, 10));
    await writeFile(join(root, "external-mode.xlsx"), xlsxAsset(
      "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" TargetMode=\" %45xternal \" Target=\"worksheets/sheet1.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet2.xml\"/></Relationships>"
    ));
    await writeFile(join(root, "ambiguous-entry.xlsx"), xlsxAsset(undefined, [
      { name: "XL/WORKBOOK.XML", data: Buffer.from("<not-used/>") }
    ]));
    await writeFile(join(root, "duplicate-id.xlsx"), xlsxAsset(
      "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet2.xml\"/></Relationships>"
    ));
    const imported = await importPackage(root, { limits: { maxImagePixels: 50 } });
    expect(imported.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "metadata_unreadable", path: "bad.png" }),
      expect.objectContaining({ code: "metadata_unreadable", path: "bad.xlsx" }),
      expect.objectContaining({ code: "metadata_limit", path: "large.png" }),
      expect.objectContaining({ code: "metadata_unreadable", path: "external-mode.xlsx" }),
      expect.objectContaining({ code: "metadata_unreadable", path: "ambiguous-entry.xlsx" }),
      expect.objectContaining({ code: "metadata_unreadable", path: "duplicate-id.xlsx" })
    ]));
  });
});
