import { describe, expect, it } from "vitest";
import { createZipStore, ZipStoreError, type ZipStoreEntry } from "./zipStore.js";

const text = new TextEncoder();
const decoder = new TextDecoder();

describe("ZIP Store writer", () => {
  it("streams files, Unicode paths and empty directories as valid ZIP entries", async () => {
    const archive = createZipStore([
      directory("资料", 0),
      file("资料/read me.txt", ["hello ", "world"], 11),
      directory("资料/空目录", 0),
      file("资料/零.txt", [], 0),
    ]);
    const bytes = await collect(archive.stream);

    expect(bytes.byteLength).toBe(archive.size);
    expect(readZip(bytes)).toEqual([
      { path: "资料/", bytes: [] },
      { path: "资料/read me.txt", bytes: [...text.encode("hello world")] },
      { path: "资料/空目录/", bytes: [] },
      { path: "资料/零.txt", bytes: [] },
    ]);
  });

  it("rejects unsafe, duplicate and oversized plans before streaming", () => {
    expect(() => createZipStore([file("../escape", [], 0)]))
      .toThrowError(ZipStoreError);
    expect(() =>
      createZipStore([file("same", [], 0), file("same", [], 0)]),
    ).toThrow(/duplicate path/);
    expect(() => createZipStore([file("huge", [], 0xffffffff)]))
      .toThrow(/ZIP32 size limit/);
  });

  it("fails when the streamed size differs from snapshot metadata", async () => {
    const archive = createZipStore([file("short", ["a"], 2)]);
    await expect(collect(archive.stream)).rejects.toThrow(/snapshot metadata/);
  });
});

function file(
  path: string,
  parts: string[],
  size: number,
): ZipStoreEntry {
  return {
    path,
    kind: "file",
    size,
    mtimeMs: Date.UTC(2026, 6, 30, 12, 34, 56),
    open: async function* () {
      for (const part of parts) yield text.encode(part);
    },
  };
}

function directory(path: string, mtimeMs: number): ZipStoreEntry {
  return { path, kind: "directory", size: 0, mtimeMs };
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const part of source) {
    parts.push(part);
    size += part.byteLength;
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function readZip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = bytes.byteLength - 22;
  expect(view.getUint32(eocdOffset, true)).toBe(0x06054b50);
  const count = view.getUint16(eocdOffset + 10, true);
  let centralOffset = view.getUint32(eocdOffset + 16, true);
  const results: Array<{ path: string; bytes: number[] }> = [];
  for (let index = 0; index < count; index += 1) {
    expect(view.getUint32(centralOffset, true)).toBe(0x02014b50);
    const expectedCrc = view.getUint32(centralOffset + 16, true);
    const size = view.getUint32(centralOffset + 24, true);
    const nameLength = view.getUint16(centralOffset + 28, true);
    const extraLength = view.getUint16(centralOffset + 30, true);
    const commentLength = view.getUint16(centralOffset + 32, true);
    const localOffset = view.getUint32(centralOffset + 42, true);
    const path = decoder.decode(
      bytes.subarray(centralOffset + 46, centralOffset + 46 + nameLength),
    );
    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset =
      localOffset + 30 + localNameLength + localExtraLength;
    const content = bytes.slice(dataOffset, dataOffset + size);
    expect(crc32(content)).toBe(expectedCrc);
    expect(view.getUint32(dataOffset + size, true)).toBe(0x08074b50);
    results.push({ path, bytes: [...content] });
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
  return results;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1
        ? 0xedb88320 ^ (crc >>> 1)
        : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
