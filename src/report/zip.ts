import { readFile, readdir, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { deflateRawSync } from "node:zlib";

function crc32(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Buffer { const output = Buffer.alloc(2); output.writeUInt16LE(value & 0xffff, 0); return output; }
function u32(value: number): Buffer { const output = Buffer.alloc(4); output.writeUInt32LE(value >>> 0, 0); return output; }

export async function zipDirectory(sourceRoot: string, destination: string): Promise<void> {
  const root = resolve(sourceRoot);
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  await visit(root);
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const path of files) {
    const name = relative(root, path).split(sep).join("/");
    const nameBytes = Buffer.from(name, "utf8");
    const data = await readFile(path);
    const compressed = deflateRawSync(data, { level: 6 });
    const checksum = crc32(data);
    const header = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), u16(20), u16(0), u16(8), u16(0), u16(0), u32(checksum), u32(compressed.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes]);
    local.push(header, compressed);
    const entry = Buffer.concat([Buffer.from([0x50, 0x4b, 0x01, 0x02]), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0), u32(checksum), u32(compressed.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes]);
    central.push(entry);
    offset += header.length + compressed.length;
  }
  const centralData = Buffer.concat(central);
  const end = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), u16(0), u16(0), u16(files.length), u16(files.length), u32(centralData.length), u32(offset), u16(0)]);
  const output = Buffer.concat([...local, centralData, end]);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(resolve(destination, ".."), { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(destination, output, { mode: 0o600 });
}
