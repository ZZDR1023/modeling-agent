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

All limits have conservative defaults in `DEFAULT_IMPORT_LIMITS` and may be reduced or raised through `importPackage(path, { limits })`. Invalid limits are rejected. Package roots and nested entries may not be symlinks, paths must remain beneath the package root, hidden directories and files are ignored, and supported file counts and raw sizes are bounded.

PDF text is extracted locally with the pinned `pdfjs-dist` Node build. Input bytes are passed directly to the parser with fetch, streaming, JavaScript evaluation, system fonts, and WebAssembly disabled. The importer records source SHA-256/size, PDF page count, extracted character count, and extractor version, while explicitly rejecting unavailable tooling, encryption, corruption, empty text, and byte/page/character limits.

DOCX extraction reads only required OOXML package parts and `word/document.xml` body text. It never executes content, follows external relationships, or opens embedded objects. Macro-enabled content types, encrypted entries, unsafe ZIP names, external relationships, corrupt packages, and ZIP entry/uncompressed/text limits fail with structured codes.

Data assets retain SHA-256 and size computed from their original bytes. XLSX inspection is limited to workbook, relationship, and bounded worksheet-dimension XML; images are read only far enough to obtain bounded PNG/JPEG format and dimensions. CSV, JSON, legacy XLS, and Parquet are inventoried without parsing or sampling their records. Unreadable or over-limit optional asset metadata is surfaced in `warnings`, never silently treated as successful metadata.
