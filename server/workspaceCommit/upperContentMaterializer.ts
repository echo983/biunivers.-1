import { constants, type BigIntStats } from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  FileContentRef,
  FileContentStore,
} from "../files/fileContentStore.js";
import type { TargetTree } from "./targetTreeProjector.js";
import type { UpperScanEntry } from "./upperScanner.js";

type ContentWriter = Pick<FileContentStore, "putStream">;

export class UpperContentMaterializer {
  readonly #content: ContentWriter;
  readonly #readBufferBytes: number;

  constructor(options: {
    content: ContentWriter;
    readBufferBytes?: number;
  }) {
    this.#content = options.content;
    this.#readBufferBytes = options.readBufferBytes ?? 1024 * 1024;
    if (
      !Number.isSafeInteger(this.#readBufferBytes) ||
      this.#readBufferBytes < 4096 ||
      this.#readBufferBytes > 8 * 1024 * 1024
    ) {
      throw new Error("Upper read buffer size is invalid.");
    }
  }

  async materialize(input: {
    upperRoot: string;
    scanEntries: readonly UpperScanEntry[];
  }): Promise<Map<string, FileContentRef>> {
    if (
      !input.upperRoot.startsWith("/") ||
      resolve(input.upperRoot) !== input.upperRoot ||
      !input.upperRoot.endsWith("/upper")
    ) {
      throw new Error("Upper content root is invalid.");
    }
    const output = new Map<string, FileContentRef>();
    for (const entry of input.scanEntries) {
      if (entry.kind !== "file") continue;
      const path = join(input.upperRoot, ...entry.path.split("/"));
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const before = await handle.stat({ bigint: true });
        verifyStat(entry, before);
        const source = readExactly(
          handle,
          entry.size,
          this.#readBufferBytes,
        );
        const content = await this.#content.putStream(source, entry.size);
        if (content.size !== entry.size) {
          throw new Error(`Materialized size is invalid: ${entry.path}`);
        }
        const after = await handle.stat({ bigint: true });
        verifyStat(entry, after);
        output.set(entry.path, content);
      } finally {
        await handle.close();
      }
    }
    return output;
  }
}

export function resolveTargetContent(
  tree: TargetTree,
  materialized: ReadonlyMap<string, FileContentRef>,
): TargetTree {
  const required = new Set<string>();
  const entries = tree.entries.map((entry) => {
    if (entry.content?.source !== "upper") return entry;
    required.add(entry.content.path);
    const content = materialized.get(entry.content.path);
    if (!content || content.size !== entry.content.size) {
      throw new Error(`Upper content is missing: ${entry.content.path}`);
    }
    return {
      ...entry,
      content: { source: "lower" as const, ref: { ...content } },
    };
  });
  for (const path of materialized.keys()) {
    if (!required.has(path)) {
      throw new Error(`Unexpected materialized Upper content: ${path}`);
    }
  }
  return { ...tree, entries };
}

async function* readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  expectedSize: number,
  bufferBytes: number,
): AsyncGenerator<Uint8Array> {
  let offset = 0;
  while (offset < expectedSize) {
    const buffer = Buffer.allocUnsafe(
      Math.min(bufferBytes, expectedSize - offset),
    );
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.byteLength,
      offset,
    );
    if (bytesRead === 0) {
      throw new Error("Upper file ended before its scanned size.");
    }
    offset += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

function verifyStat(
  entry: UpperScanEntry,
  status: BigIntStats,
): void {
  if (
    !status.isFile() ||
    status.nlink !== 1n ||
    status.size !== BigInt(entry.size) ||
    status.dev.toString() !== entry.device ||
    status.ino.toString() !== entry.inode ||
    status.mtimeNs.toString() !== entry.mtimeNs ||
    status.ctimeNs.toString() !== entry.ctimeNs
  ) {
    throw new Error(`Upper file changed after scanning: ${entry.path}`);
  }
}
