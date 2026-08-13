import { readFile } from "node:fs/promises";
import type { TextItem } from "pdfjs-dist/types/src/display/api.js";
import { PackageImportError, type ImportLimits, type ProblemExtractionMetadata } from "./types.js";

interface PdfExtraction {
  text: string;
  metadata: ProblemExtractionMetadata;
}

const MAX_CAUSE_LENGTH = 240;

function causeMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\r\n\t]+/g, " ").slice(0, MAX_CAUSE_LENGTH);
}

function isTextItem(item: unknown): item is TextItem {
  return typeof item === "object" && item !== null && "str" in item && typeof (item as { str?: unknown }).str === "string";
}

export async function extractPdf(
  path: string,
  identity: { sha256: string; sizeBytes: number },
  limits: ImportLimits
): Promise<PdfExtraction> {
  if (identity.sizeBytes > limits.maxProblemBytes) {
    throw new PackageImportError("problem_file_limit", `PDF is ${identity.sizeBytes} bytes; limit is ${limits.maxProblemBytes}.`, {
      path,
      actual: identity.sizeBytes,
      limit: limits.maxProblemBytes
    });
  }
  const bytes = await readFile(path);
  let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  try {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch (error) {
    throw new PackageImportError("pdf_tool_unavailable", "The local pdfjs extractor is unavailable.", {
      path,
      cause: causeMessage(error)
    });
  }

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableAutoFetch: true,
    disableFontFace: true,
    disableRange: true,
    disableStream: true,
    isEvalSupported: false,
    maxImageSize: limits.maxImagePixels,
    stopAtErrors: true,
    useSystemFonts: false,
    useWasm: false,
    useWorkerFetch: false,
    verbosity: 0
  });
  try {
    const document = await loadingTask.promise;
    try {
      if (document.numPages > limits.maxPdfPages) {
        throw new PackageImportError("pdf_page_limit", `PDF has ${document.numPages} pages; limit is ${limits.maxPdfPages}.`, {
          path,
          actual: document.numPages,
          limit: limits.maxPdfPages
        });
      }
      const pages: string[] = [];
      let characters = 0;
      const ensureFits = (base: number, additional: number): void => {
        const actual = base + additional;
        if (!Number.isSafeInteger(actual) || actual > limits.maxPdfCharacters) {
          throw new PackageImportError("pdf_character_limit", `PDF extraction exceeds ${limits.maxPdfCharacters} characters.`, {
            path,
            actual,
            limit: limits.maxPdfCharacters
          });
        }
      };
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent({ disableNormalization: false, includeMarkedContent: false });
        const textItems = content.items.filter(isTextItem);
        const leadingPageSeparator = pages.length === 0 ? "" : "\n\n";
        const pagePieces: string[] = [];
        let pageCharacters = 0;
        for (const item of textItems) {
          const itemText = item.str.trim();
          if (itemText.length === 0) continue;
          const separator = pagePieces.length === 0 ? "" : " ";
          const additional = separator.length + itemText.length;
          if (!Number.isSafeInteger(pageCharacters + additional)) ensureFits(characters, Number.MAX_SAFE_INTEGER);
          ensureFits(characters, leadingPageSeparator.length + pageCharacters + additional);
          if (separator) pagePieces.push(separator);
          pagePieces.push(itemText);
          pageCharacters += additional;
        }
        if (pageCharacters === 0) continue;
        pages.push(pagePieces.join(""));
        characters += leadingPageSeparator.length + pageCharacters;
      }
      const text = pages.join("\n\n").trim();
      if (!text) throw new PackageImportError("pdf_empty", "PDF contains no extractable text.", { path });
      if (text.length > limits.maxPdfCharacters || text.length !== characters) {
        throw new PackageImportError("pdf_character_limit", `PDF extraction exceeds ${limits.maxPdfCharacters} characters after normalization.`, {
          path,
          actual: text.length,
          limit: limits.maxPdfCharacters
        });
      }
      return {
        text,
        metadata: {
          format: "pdf",
          sourceBytes: identity.sizeBytes,
          sha256: identity.sha256,
          extractedCharacters: text.length,
          extractor: `pdfjs-dist/${pdfjs.version}`,
          pages: document.numPages
        }
      };
    } finally {
      await document.destroy();
    }
  } catch (error) {
    if (error instanceof PackageImportError) throw error;
    const message = causeMessage(error);
    const name = error instanceof Error ? error.name : "";
    if (name === "PasswordException" || /password|encrypted/i.test(message)) {
      throw new PackageImportError("pdf_encrypted", "Encrypted PDF files are not allowed.", { path, cause: message });
    }
    throw new PackageImportError("pdf_corrupt", "Could not extract PDF text.", { path, cause: message });
  } finally {
    await loadingTask.destroy();
  }
}
