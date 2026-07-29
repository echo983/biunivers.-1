const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_VERSION = 20;
const UTF8_WITH_DATA_DESCRIPTOR = 0x0808;
const ZIP32_LIMIT = 0xffffffff;
const MAX_ZIP_ENTRIES = 10_000;

const encoder = new TextEncoder();
const crcTable = createCrcTable();

export class ZipStoreError extends Error {
  constructor(
    public readonly code:
      | "ZIP_ENTRY_INVALID"
      | "ZIP_ENTRY_LIMIT"
      | "ZIP_SIZE_LIMIT"
      | "ZIP_CONTENT_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "ZipStoreError";
  }
}

export interface ZipStoreEntry {
  path: string;
  kind: "file" | "directory";
  size: number;
  mtimeMs: number;
  open?: () => AsyncIterable<Uint8Array>;
}

interface PreparedEntry extends ZipStoreEntry {
  pathBytes: Uint8Array;
  localOffset: number;
  dosTime: number;
  dosDate: number;
}

interface CentralEntry extends PreparedEntry {
  crc32: number;
}

export interface ZipStoreArchive {
  size: number;
  stream: AsyncIterable<Uint8Array>;
}

export function createZipStore(entries: readonly ZipStoreEntry[]): ZipStoreArchive {
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new ZipStoreError(
      "ZIP_ENTRY_LIMIT",
      `ZIP export exceeds the ${MAX_ZIP_ENTRIES}-entry limit.`,
    );
  }
  const prepared: PreparedEntry[] = [];
  const paths = new Set<string>();
  let offset = 0;
  for (const entry of entries) {
    const path = normalizeZipPath(entry);
    if (paths.has(path)) {
      throw new ZipStoreError(
        "ZIP_ENTRY_INVALID",
        `ZIP export contains a duplicate path: ${path}`,
      );
    }
    paths.add(path);
    const pathBytes = encoder.encode(path);
    if (pathBytes.byteLength > 0xffff) {
      throw new ZipStoreError(
        "ZIP_ENTRY_INVALID",
        `ZIP path exceeds 65535 UTF-8 bytes: ${path}`,
      );
    }
    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size >= ZIP32_LIMIT
    ) {
      throw new ZipStoreError(
        "ZIP_SIZE_LIMIT",
        `ZIP entry exceeds the ZIP32 size limit: ${path}`,
      );
    }
    if (
      !Number.isFinite(entry.mtimeMs) ||
      (entry.kind === "file" && !entry.open) ||
      (entry.kind === "directory" && (entry.size !== 0 || entry.open))
    ) {
      throw new ZipStoreError(
        "ZIP_ENTRY_INVALID",
        `ZIP entry metadata is invalid: ${path}`,
      );
    }
    const localOffset = offset;
    offset = checkedZip32Add(
      offset,
      30 + pathBytes.byteLength + entry.size + 16,
    );
    const timestamp = toDosTimestamp(entry.mtimeMs);
    prepared.push({
      ...entry,
      path,
      pathBytes,
      localOffset,
      dosTime: timestamp.time,
      dosDate: timestamp.date,
    });
  }
  const centralOffset = offset;
  for (const entry of prepared) {
    offset = checkedZip32Add(offset, 46 + entry.pathBytes.byteLength);
  }
  const centralSize = offset - centralOffset;
  offset = checkedZip32Add(offset, 22);

  return {
    size: offset,
    stream: streamZip(prepared, centralOffset, centralSize),
  };
}

async function* streamZip(
  entries: readonly PreparedEntry[],
  centralOffset: number,
  centralSize: number,
): AsyncGenerator<Uint8Array> {
  const central: CentralEntry[] = [];
  for (const entry of entries) {
    yield localHeader(entry);
    let crc = 0xffffffff;
    let actualSize = 0;
    if (entry.kind === "file") {
      for await (const chunk of entry.open!()) {
        if (
          !ArrayBuffer.isView(chunk) ||
          chunk.BYTES_PER_ELEMENT !== 1
        ) {
          throw new ZipStoreError(
            "ZIP_CONTENT_INVALID",
            `ZIP source returned non-byte content: ${entry.path}`,
          );
        }
        actualSize += chunk.byteLength;
        if (actualSize > entry.size) {
          throw contentLengthError(entry.path);
        }
        crc = updateCrc32(crc, chunk);
        yield chunk;
      }
    }
    if (actualSize !== entry.size) {
      throw contentLengthError(entry.path);
    }
    const crc32 = (crc ^ 0xffffffff) >>> 0;
    yield dataDescriptor(crc32, actualSize);
    central.push({ ...entry, crc32 });
  }
  for (const entry of central) {
    yield centralDirectoryEntry(entry);
  }
  yield endOfCentralDirectory(entries.length, centralSize, centralOffset);
}

function normalizeZipPath(entry: ZipStoreEntry): string {
  const expectedPath =
    entry.kind === "directory" && !entry.path.endsWith("/")
      ? `${entry.path}/`
      : entry.path;
  const raw = entry.kind === "directory"
    ? expectedPath.slice(0, -1)
    : expectedPath;
  const segments = raw.split("/");
  if (
    raw.length === 0 ||
    raw.startsWith("/") ||
    raw.includes("\\") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new ZipStoreError(
      "ZIP_ENTRY_INVALID",
      `ZIP path is unsafe: ${entry.path}`,
    );
  }
  if (entry.kind === "file" && entry.path.endsWith("/")) {
    throw new ZipStoreError(
      "ZIP_ENTRY_INVALID",
      `ZIP file path ends with a slash: ${entry.path}`,
    );
  }
  return expectedPath;
}

function checkedZip32Add(current: number, increment: number): number {
  const next = current + increment;
  if (!Number.isSafeInteger(next) || next >= ZIP32_LIMIT) {
    throw new ZipStoreError(
      "ZIP_SIZE_LIMIT",
      "ZIP export exceeds the ZIP32 archive size limit.",
    );
  }
  return next;
}

function localHeader(entry: PreparedEntry): Uint8Array {
  const output = new Uint8Array(30 + entry.pathBytes.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, LOCAL_FILE_HEADER_SIGNATURE, true);
  view.setUint16(4, ZIP_VERSION, true);
  view.setUint16(6, UTF8_WITH_DATA_DESCRIPTOR, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, entry.dosTime, true);
  view.setUint16(12, entry.dosDate, true);
  view.setUint16(26, entry.pathBytes.byteLength, true);
  output.set(entry.pathBytes, 30);
  return output;
}

function dataDescriptor(crc32: number, size: number): Uint8Array {
  const output = new Uint8Array(16);
  const view = new DataView(output.buffer);
  view.setUint32(0, DATA_DESCRIPTOR_SIGNATURE, true);
  view.setUint32(4, crc32, true);
  view.setUint32(8, size, true);
  view.setUint32(12, size, true);
  return output;
}

function centralDirectoryEntry(entry: CentralEntry): Uint8Array {
  const output = new Uint8Array(46 + entry.pathBytes.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, CENTRAL_DIRECTORY_SIGNATURE, true);
  view.setUint16(4, ZIP_VERSION, true);
  view.setUint16(6, ZIP_VERSION, true);
  view.setUint16(8, UTF8_WITH_DATA_DESCRIPTOR, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, entry.dosTime, true);
  view.setUint16(14, entry.dosDate, true);
  view.setUint32(16, entry.crc32, true);
  view.setUint32(20, entry.size, true);
  view.setUint32(24, entry.size, true);
  view.setUint16(28, entry.pathBytes.byteLength, true);
  view.setUint32(38, entry.kind === "directory" ? 0x10 : 0, true);
  view.setUint32(42, entry.localOffset, true);
  output.set(entry.pathBytes, 46);
  return output;
}

function endOfCentralDirectory(
  entryCount: number,
  centralSize: number,
  centralOffset: number,
): Uint8Array {
  const output = new Uint8Array(22);
  const view = new DataView(output.buffer);
  view.setUint32(0, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  view.setUint16(8, entryCount, true);
  view.setUint16(10, entryCount, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  return output;
}

function toDosTimestamp(mtimeMs: number): { time: number; date: number } {
  const input = new Date(mtimeMs);
  const year = Number.isNaN(input.getTime())
    ? 1980
    : Math.min(2107, Math.max(1980, input.getUTCFullYear()));
  const month = Number.isNaN(input.getTime()) ? 1 : input.getUTCMonth() + 1;
  const day = Number.isNaN(input.getTime()) ? 1 : input.getUTCDate();
  const hours = Number.isNaN(input.getTime()) ? 0 : input.getUTCHours();
  const minutes = Number.isNaN(input.getTime()) ? 0 : input.getUTCMinutes();
  const seconds = Number.isNaN(input.getTime()) ? 0 : input.getUTCSeconds();
  return {
    time: (hours << 11) | (minutes << 5) | Math.floor(seconds / 2),
    date: ((year - 1980) << 9) | (month << 5) | day,
  };
}

function createCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1
        ? 0xedb88320 ^ (value >>> 1)
        : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function updateCrc32(crc: number, bytes: Uint8Array): number {
  let value = crc;
  for (const byte of bytes) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return value >>> 0;
}

function contentLengthError(path: string): ZipStoreError {
  return new ZipStoreError(
    "ZIP_CONTENT_INVALID",
    `ZIP source length does not match its snapshot metadata: ${path}`,
  );
}
