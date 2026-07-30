import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileContentStore } from "../files/fileContentStore.js";
import { ImmutableObjectRepository } from "../files/immutableObjectRepository.js";
import { LocalWormObjectStore } from "../files/localWormObjectStore.js";
import { WorkspaceContentReader } from "./workspaceContentReader.js";
import { VerifiedChunkCache } from "./verifiedChunkCache.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "biunivers-content-reader-"));
  roots.push(root);
  const repository = new ImmutableObjectRepository(
    new LocalWormObjectStore(join(root, "objects")),
    "users/alice",
  );
  const cache = new VerifiedChunkCache({
    directory: join(root, "cache"),
    repository,
  });
  return {
    repository,
    cache,
    reader: new WorkspaceContentReader({ repository, cache }),
  };
}

describe("WorkspaceContentReader", () => {
  it("serves bounded ranges from a fully verified small Chunk", async () => {
    const setupResult = await setup();
    const content = await new FileContentStore(setupResult.repository).putBytes(
      Buffer.from("0123456789"),
    );
    expect(
      Buffer.from(await setupResult.reader.read(content, 3, 4)).toString(),
    ).toBe("3456");
    expect(await setupResult.reader.read(content, 20, 4)).toHaveLength(0);
    expect(setupResult.cache.metrics()).toMatchObject({
      misses: 1,
      downloadedBytes: 10,
    });
  });

  it("reads across a 64 MiB Manifest boundary through verified Chunks", async () => {
    const setupResult = await setup();
    const boundary = 64 * 1024 * 1024;
    const bytes = Buffer.alloc(boundary + 2, 0x31);
    bytes[boundary - 1] = 0x41;
    bytes[boundary] = 0x42;
    bytes[boundary + 1] = 0x43;
    const content = await new FileContentStore(setupResult.repository).putBytes(
      bytes,
    );

    expect(content.kind).toBe("manifest");
    expect(
      Buffer.from(
        await setupResult.reader.read(content, boundary - 1, 3),
      ).toString(),
    ).toBe("ABC");
    expect(setupResult.cache.metrics()).toMatchObject({
      misses: 2,
      downloadedBytes: boundary + 2,
    });
  });

  it("rejects FUSE-sized reads above the configured bound", async () => {
    const setupResult = await setup();
    const content = await new FileContentStore(setupResult.repository).putBytes(
      Buffer.from("bounded"),
    );
    await expect(
      setupResult.reader.read(content, 0, 1024 * 1024 + 1),
    ).rejects.toMatchObject({ code: "OBJECT_INVALID" });
  });
});
