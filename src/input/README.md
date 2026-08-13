# Safe package input

`importPackage` inventories a local competition package without modifying source files or using the network. Existing callers keep the same required fields (`problemText`, the original `problemPath`, `dataAssets`, and `dataPaths`); extraction and inventory details are optional additions.

## Problem selection

Problem statements are selected deterministically by precedence group:

1. `problem.md` or `problem.markdown`
2. `problem.txt`
3. `problem.pdf`
4. `problem.docx`

Names are matched case-insensitively at any non-hidden package depth. The first non-empty precedence group wins. If that group contains more than one candidate (including duplicate names in separate directories, or both Markdown spellings), import fails with `PackageImportError.code === "ambiguous_problem"`; lower-priority candidates are data assets only when a higher-priority problem was selected.

## Safety and limits

All limits have conservative defaults in `DEFAULT_IMPORT_LIMITS` and may be reduced or raised through `importPackage(path, { limits })`. Invalid limits are rejected. Package roots and nested entries may not be symlinks, paths must remain beneath the package root, and total traversal is bounded by `maxPackageEntries` and `maxPackageDepth`. Every encountered child entry (file, directory, unsupported extension, or hidden name) consumes the entry budget; the package root itself does not. Hidden entries are then ignored and hidden directories are never recursed into.

PDF text is extracted locally with the pinned `pdfjs-dist` Node build. Input bytes are passed directly to the parser with fetch, streaming, JavaScript evaluation, system fonts, and WebAssembly disabled. The importer records source SHA-256/size, PDF page count, extracted character count, and extractor version, while explicitly rejecting unavailable tooling, encryption, corruption, empty text, and byte/page/character limits. `maxPdfCharacters` applies to the exact returned text, including spaces inserted between text items, blank lines inserted between non-empty pages, and final normalization; construction is checked incrementally and asserted again before return.

DOCX extraction performs a bounded magic-prefix check before opening ZIP data: normal ZIP signatures continue, OLE/CFB Office containers are classified as `docx_encrypted`, and other input is `docx_corrupt`. Extraction reads only required OOXML package parts and `word/document.xml` body text. It never decrypts content, executes payloads, follows non-internal relationships, or opens embedded objects. All relationship files reject duplicate IDs and external, escaping, or unknown normalized `TargetMode` values; package relationships require exactly one normalized main-document relationship; and content-type declarations reject duplicate/case-normalized part ambiguity. Any VBA/macro/ActiveX content type, relationship type, or package-part indicator is rejected before payload expansion; ZIP symlink entries are rejected at the archive boundary.

Data assets retain SHA-256 and size computed from their original bytes. XLSX inspection is limited to workbook, relationship, and bounded worksheet-dimension XML; images are read only far enough to obtain bounded PNG/JPEG format and dimensions. CSV, JSON, legacy XLS, and Parquet are inventoried without parsing or sampling their records. Unreadable or over-limit optional asset metadata is surfaced in `warnings`, never silently treated as successful metadata.
