import crc32 from "buffer-crc32";
import { open, type Entry, type ZipFile } from "yauzl";
import { PackageImportError, type PackageImportErrorCode } from "./types.js";

export interface ZipLimits {
  maxEntries: number;
  maxUncompressedBytes: number;
}

export interface ZipContents {
  entries: Map<string, Buffer>;
  entryCount: number;
  uncompressedBytes: number;
}

export interface ZipErrorCodes {
  corrupt: PackageImportErrorCode;
  encrypted: PackageImportErrorCode;
  zipSlip: PackageImportErrorCode;
  entryLimit: PackageImportErrorCode;
  uncompressedLimit: PackageImportErrorCode;
}

function causeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function openArchive(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    open(path, {
      autoClose: false,
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true
    }, (error, archive) => {
      if (error) reject(error);
      else resolve(archive);
    });
  });
}

function readEntry(archive: ZipFile, entry: Entry, maximumBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    archive.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > maximumBytes) stream.destroy(new Error(`Uncompressed entry exceeds ${maximumBytes} bytes.`));
        else chunks.push(buffer);
      });
      stream.once("error", reject);
      stream.once("end", () => {
        const result = Buffer.concat(chunks);
        if (result.length !== entry.uncompressedSize) {
          reject(new Error(`ZIP entry size mismatch for ${entry.fileName}: expected ${entry.uncompressedSize}, got ${result.length}.`));
          return;
        }
        if (crc32.unsigned(result) !== entry.crc32) {
          reject(new Error(`ZIP entry CRC mismatch for ${entry.fileName}.`));
          return;
        }
        resolve(result);
      });
    });
  });
}

function unsafeEntryName(name: string): boolean {
  return name.includes("\\")
    || name.startsWith("/")
    || /^[A-Za-z]:/.test(name)
    || name.split("/").includes("..");
}

export async function readBoundedZip(
  path: string,
  limits: ZipLimits,
  codes: ZipErrorCodes,
  select: (entryName: string) => boolean
): Promise<ZipContents> {
  let archive: ZipFile;
  try {
    archive = await openArchive(path);
  } catch (error) {
    const message = causeMessage(error);
    const code = /invalid relative path|absolute path|invalid characters in fileName/i.test(message) ? codes.zipSlip : codes.corrupt;
    throw new PackageImportError(code, `Could not open ZIP package: ${message}`, { path, cause: message });
  }

  if (archive.entryCount > limits.maxEntries) {
    archive.close();
    throw new PackageImportError(codes.entryLimit, `ZIP package has ${archive.entryCount} entries; limit is ${limits.maxEntries}.`, {
      path,
      actual: archive.entryCount,
      limit: limits.maxEntries
    });
  }

  return new Promise((resolve, reject) => {
    const entries = new Map<string, Buffer>();
    let count = 0;
    let total = 0;
    let settled = false;

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      archive.close();
      if (error instanceof PackageImportError) reject(error);
      else {
        const message = causeMessage(error);
        const code = /invalid relative path|absolute path|invalid characters in fileName/i.test(message) ? codes.zipSlip : codes.corrupt;
        reject(new PackageImportError(code, `Could not read ZIP package: ${message}`, { path, cause: message }));
      }
    };

    archive.on("error", fail);
    archive.on("entry", (entry: Entry) => {
      void (async () => {
        count += 1;
        if (count > limits.maxEntries) {
          throw new PackageImportError(codes.entryLimit, `ZIP package exceeds ${limits.maxEntries} entries.`, {
            path,
            actual: count,
            limit: limits.maxEntries
          });
        }
        if (unsafeEntryName(entry.fileName)) {
          throw new PackageImportError(codes.zipSlip, `Unsafe ZIP entry path: ${entry.fileName}`, { path: entry.fileName });
        }
        if (entry.isEncrypted()) {
          throw new PackageImportError(codes.encrypted, `Encrypted ZIP entry is not allowed: ${entry.fileName}`, { path: entry.fileName });
        }
        total += entry.uncompressedSize;
        if (!Number.isSafeInteger(total) || total > limits.maxUncompressedBytes) {
          throw new PackageImportError(codes.uncompressedLimit, `ZIP package expands to more than ${limits.maxUncompressedBytes} bytes.`, {
            path,
            actual: total,
            limit: limits.maxUncompressedBytes
          });
        }
        if (!entry.fileName.endsWith("/") && select(entry.fileName)) {
          const remaining = limits.maxUncompressedBytes - (total - entry.uncompressedSize);
          entries.set(entry.fileName, await readEntry(archive, entry, remaining));
        }
        archive.readEntry();
      })().catch(fail);
    });
    archive.on("end", () => {
      if (settled) return;
      settled = true;
      archive.close();
      resolve({ entries, entryCount: count, uncompressedBytes: total });
    });
    archive.readEntry();
  });
}
