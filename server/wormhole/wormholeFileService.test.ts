import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeGenesisFileSystem } from "../files/genesisFileSystem.js";
import { ImmutableObjectRepository } from "../files/immutableObjectRepository.js";
import { LocalWormObjectStore } from "../files/localWormObjectStore.js";
import { WormholeFileService } from "./wormholeFileService.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("WormholeFileService", () => {
  it("creates, overwrites, ranges, copies, moves and removes resources", async () => {
    const root = await mkdtemp(join(tmpdir(), "biunivers-wormhole-"));
    roots.push(root);
    const repository = new ImmutableObjectRepository(
      new LocalWormObjectStore(join(root, "objects")),
      "users/alice",
    );
    const genesis = await initializeGenesisFileSystem({
      databasePath: join(root, "file-service.sqlite"),
      repository,
      writerId: "test",
    });
    const service = new WormholeFileService({
      repository,
      refStore: genesis.store,
      writerId: "test",
    });

    await service.createDirectory(["docs"]);
    expect(
      await service.put(["docs", "note.txt"], chunks("hello world")),
    ).toMatchObject({ created: true });
    expect(await collect((await service.readRange(["docs", "note.txt"], 6, 10)).chunks))
      .toBe("world");

    await service.copy(["docs", "note.txt"], ["copy.txt"], false);
    await service.move(["copy.txt"], ["renamed.txt"], false);
    expect(await collect((await service.read(["renamed.txt"])).chunks)).toBe(
      "hello world",
    );

    expect(
      await service.put(["renamed.txt"], chunks("changed")),
    ).toMatchObject({ created: false });
    await service.remove(["docs"]);
    await expect(service.list(["docs"], false)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await collect((await service.read(["renamed.txt"])).chunks)).toBe(
      "changed",
    );
    genesis.store.close();
  });
});

async function* chunks(value: string) {
  yield Buffer.from(value);
}

async function collect(source: AsyncIterable<Uint8Array>) {
  const values: Buffer[] = [];
  for await (const value of source) values.push(Buffer.from(value));
  return Buffer.concat(values).toString();
}
