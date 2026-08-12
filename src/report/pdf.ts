import { deflateSync } from "node:zlib";

function escapePdfText(value: string): string {
  return value.replace(/[\\()]/g, (character) => `\\${character}`);
}

function asciiLines(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/[^\x20-\x7e\n]/g, "?")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const chunks: string[] = [];
      for (let index = 0; index < line.length; index += 92) chunks.push(line.slice(index, index + 92));
      return chunks;
    })
    .slice(0, 48);
}

function objectRecord(id: number, body: Buffer | string): Buffer {
  return Buffer.concat([
    Buffer.from(`${id} 0 obj\n`, "ascii"),
    typeof body === "string" ? Buffer.from(body, "ascii") : body,
    Buffer.from("\nendobj\n", "ascii")
  ]);
}

/** Build a standards-compliant, single-page fallback PDF without external tools. */
export function createFallbackPdf(title: string, reportMarkdown: string): Buffer {
  const lines = [title, ...asciiLines(reportMarkdown)].slice(0, 50);
  const operations = ["BT", "/F1 10 Tf", "50 790 Td", "12 TL"];
  for (const [index, line] of lines.entries()) {
    if (index > 0) operations.push("T*");
    operations.push(`(${escapePdfText(line)}) Tj`);
  }
  operations.push("ET");
  const compressed = deflateSync(Buffer.from(`${operations.join("\n")}\n`, "ascii"));
  const objects = [
    objectRecord(1, "<< /Type /Catalog /Pages 2 0 R >>"),
    objectRecord(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    objectRecord(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"),
    objectRecord(4, Buffer.concat([Buffer.from(`<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`, "ascii"), compressed, Buffer.from("\nendstream", "ascii")])),
    objectRecord(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
  ];

  const header = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary");
  const offsets = [0];
  let cursor = header.length;
  for (const object of objects) {
    offsets.push(cursor);
    cursor += object.length;
  }
  const xrefOffset = cursor;
  const xref = ["xref", `0 ${objects.length + 1}`, "0000000000 65535 f "];
  for (const offset of offsets.slice(1)) xref.push(`${String(offset).padStart(10, "0")} 00000 n `);
  const trailer = `${xref.join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.concat([header, ...objects, Buffer.from(trailer, "ascii")]);
}
