import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileContentRef } from "../files/fileContentStore.js";
import {
  resolveTargetContent,
  UpperContentMaterializer,
} from "./upperContentMaterializer.js";
import type { TargetTree } from "./targetTreeProjector.js";
import type { UpperScanEntry } from "./upperScanner.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("UpperContentMaterializer", () => {
  it("reads the exact scanned fd and returns content refs", async () => {
    const { upper, entry } = await fixture(Buffer.from("hello world"));
    const putStream = vi.fn(async (source: AsyncIterable<Uint8Array>) => {
      const parts: Buffer[] = [];
      for await (const bytes of source) parts.push(Buffer.from(bytes));
      expect(Buffer.concat(parts).toString()).toBe("hello world");
      return {
        kind: "chunk",
        fidHex: "aa".repeat(16),
        size: 11,
      } satisfies FileContentRef;
    });
    const result = await new UpperContentMaterializer({
      content: { putStream },
      readBufferBytes: 4096,
    }).materialize({ upperRoot: upper, scanEntries: [entry] });
    expect(result.get("note.txt")).toMatchObject({
      kind: "chunk",
      size: 11,
    });
    expect(putStream).toHaveBeenCalledWith(expect.anything(), 11);
  });

  it("rejects a file changed during immutable persistence", async () => {
    const { upper, path, entry } = await fixture(Buffer.from("before"));
    const materializer = new UpperContentMaterializer({
      content: {
        async putStream(source) {
          for await (const bytes of source) {
            // Consume the exact original fd before simulating a concurrent writer.
            void bytes;
          }
          await writeFile(path, "changed-content");
          return { kind: "chunk", fidHex: "bb".repeat(16), size: 6 };
        },
      },
    });
    await expect(
      materializer.materialize({ upperRoot: upper, scanEntries: [entry] }),
    ).rejects.toThrow("changed after scanning");
  });

  it("resolves every Upper placeholder and rejects missing or extra refs", () => {
    const tree: TargetTree = {
      revision: 1,
      rootEntryIdHex: "01".repeat(16),
      entries: [
        {
          path: "",
          entryIdHex: "01".repeat(16),
          parentEntryIdHex: null,
          name: "",
          kind: "directory",
          createdAtMs: 1,
          mtimeMs: 1,
        },
        {
          path: "note.txt",
          entryIdHex: "02".repeat(16),
          parentEntryIdHex: "01".repeat(16),
          name: "note.txt",
          kind: "file",
          createdAtMs: 1,
          mtimeMs: 1,
          content: { source: "upper", path: "note.txt", size: 3 },
        },
      ],
    };
    const content = {
      kind: "chunk",
      fidHex: "cc".repeat(16),
      size: 3,
    } satisfies FileContentRef;
    expect(
      resolveTargetContent(tree, new Map([["note.txt", content]])).entries[1]
        ?.content,
    ).toEqual({ source: "lower", ref: content });
    expect(() => resolveTargetContent(tree, new Map())).toThrow("missing");
    expect(() =>
      resolveTargetContent(tree, new Map([["other.txt", content]])),
    ).toThrow("missing");
    expect(() =>
      resolveTargetContent(
        tree,
        new Map([
          ["note.txt", content],
          ["other.txt", content],
        ]),
      ),
    ).toThrow("Unexpected");
  });
});

async function fixture(bytes: Uint8Array) {
  const root = await mkdtemp(join(tmpdir(), "biunivers-upper-content-"));
  roots.push(root);
  const upper = join(root, "upper");
  await mkdir(upper);
  const path = join(upper, "note.txt");
  await writeFile(path, bytes);
  const status = await stat(path, { bigint: true });
  const entry: UpperScanEntry = {
    path: "note.txt",
    kind: "file",
    size: bytes.byteLength,
    mtimeNs: status.mtimeNs.toString(),
    ctimeNs: status.ctimeNs.toString(),
    device: status.dev.toString(),
    inode: status.ino.toString(),
    opaque: false,
  };
  return { upper, path, entry };
}
