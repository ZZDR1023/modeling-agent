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

function pdfDocument(pages: string[], encrypted = false): Buffer {
  const objects: string[] = [];
  const pageObjectNumbers: number[] = [];
  const fontObject = 3;
  const pagesObject = 2;
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (const [index, text] of pages.entries()) {
    const pageObject = 4 + index * 2;
    const contentObject = pageObject + 1;
    pageObjectNumbers.push(pageObject);
    const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
    const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
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

type ZipEntry = { name: string; data: Buffer; compression?: "store" | "deflate" };

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
    directory.writeUInt16LE(20, 4);
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
    directory.writeUInt32LE(0, 36);
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

function crc32Of(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function docxDocument(
  text: string,
  extra: ZipEntry[] = [],
  mainContentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
): Buffer {
  return zip([
    { name: "[Content_Types].xml", data: Buffer.from(`<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"${mainContentType}\"/></Types>`) },
    { name: "_rels/.rels", data: Buffer.from("<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>") },
    { name: "word/document.xml", data: Buffer.from(`<?xml version=\"1.0\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`) },
    ...extra
  ]);
}

function xlsxAsset(): Buffer {
  return zip([
    { name: "[Content_Types].xml", data: Buffer.from("<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/></Types>") },
    { name: "xl/workbook.xml", data: Buffer.from("<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"Data\" sheetId=\"1\" r:id=\"rId1\"/><sheet name=\"Summary\" sheetId=\"2\" r:id=\"rId2\"/></sheets></workbook>") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from("<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet2.xml\"/></Relationships>") },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from("<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><dimension ref=\"A1:C12\"/></worksheet>") },
    { name: "xl/worksheets/sheet2.xml", data: Buffer.from("<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><dimension ref=\"B2:D4\"/></worksheet>") }
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

    const tooManyBytes = await tempPackage("pdf-bytes");
    await writeFile(join(tooManyBytes, "problem.pdf"), pdfDocument(["text"]));
    await expectImportCode(importPackage(tooManyBytes, { limits: { maxProblemBytes: 10 } }), "problem_file_limit");
  });

  it("extracts only DOCX body text", async () => {
    const root = await tempPackage("docx");
    await writeFile(join(root, "problem.docx"), docxDocument("DOCX body text"));
    const imported = await importPackage(root);
    expect(imported.problemText).toContain("DOCX body text");
    expect(imported.problemMetadata).toMatchObject({ format: "docx", extractedCharacters: 14, extractor: "ooxml-body-v1" });
  });

  it("rejects corrupt and macro-enabled DOCX packages", async () => {
    const corrupt = await tempPackage("docx-corrupt");
    await writeFile(join(corrupt, "problem.docx"), Buffer.from("not a zip"));
    await expectImportCode(importPackage(corrupt), "docx_corrupt");

    const crcMismatch = await tempPackage("docx-crc");
    const tampered = docxDocument("body");
    const marker = tampered.indexOf(Buffer.from("body"));
    tampered[marker] = "B".charCodeAt(0);
    await writeFile(join(crcMismatch, "problem.docx"), tampered);
    await expectImportCode(importPackage(crcMismatch), "docx_corrupt");

    const macro = await tempPackage("docx-macro");
    const document = docxDocument(
      "body",
      [{ name: "word/vbaProject.bin", data: Buffer.from("not executed") }],
      "application/vnd.ms-word.document.macroEnabled.main+xml"
    );
    await writeFile(join(macro, "problem.docx"), document);
    await expectImportCode(importPackage(macro), "docx_macro_enabled");
  });

  it("rejects DOCX external relationships and ZIP slip names", async () => {
    const external = await tempPackage("docx-external");
    await writeFile(join(external, "problem.docx"), docxDocument("body", [
      { name: "word/_rels/document.xml.rels", data: Buffer.from("<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId9\" TargetMode=\"External\" Target=\"https://example.invalid\"/></Relationships>") }
    ]));
    await expectImportCode(importPackage(external), "docx_external_relationship");

    const entity = await tempPackage("docx-entity");
    await writeFile(join(entity, "problem.docx"), docxDocument("body", [
      { name: "word/_rels/document.xml.rels", data: Buffer.from("<!DOCTYPE Relationships [<!ENTITY xxe SYSTEM \"file:///etc/passwd\">]><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">&xxe;</Relationships>") }
    ]));
    await expectImportCode(importPackage(entity), "docx_corrupt");

    const traversal = await tempPackage("docx-slip");
    await writeFile(join(traversal, "problem.docx"), docxDocument("body", [{ name: "../outside.xml", data: Buffer.from("x") }]));
    await expectImportCode(importPackage(traversal), "docx_zip_slip");
  });

  it("enforces DOCX entry, decompressed-byte, and character limits", async () => {
    const entries = await tempPackage("docx-entries");
    await writeFile(join(entries, "problem.docx"), docxDocument("body", [
      { name: "word/extra.xml", data: Buffer.from("x") },
      { name: "word/extra2.xml", data: Buffer.from("x") }
    ]));
    await expectImportCode(importPackage(entries, { limits: { maxDocxZipEntries: 4 } }), "docx_zip_entry_limit");

    const bytes = await tempPackage("docx-bytes");
    await writeFile(join(bytes, "problem.docx"), docxDocument("body", [{ name: "word/large.xml", data: Buffer.alloc(500, 65) }]));
    await expectImportCode(importPackage(bytes, { limits: { maxDocxUncompressedBytes: 100 } }), "docx_uncompressed_limit");

    const characters = await tempPackage("docx-characters");
    await writeFile(join(characters, "problem.docx"), docxDocument("0123456789"));
    await expectImportCode(importPackage(characters, { limits: { maxDocxCharacters: 5 } }), "docx_character_limit");
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
    const imported = await importPackage(root, { limits: { maxImagePixels: 50 } });
    expect(imported.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "metadata_unreadable", path: "bad.png" }),
      expect.objectContaining({ code: "metadata_unreadable", path: "bad.xlsx" }),
      expect.objectContaining({ code: "metadata_limit", path: "large.png" })
    ]));
  });
});
