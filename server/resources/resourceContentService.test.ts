import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileContentStore } from "../files/fileContentStore.js";
import { loadCurrentEntryIndex } from "../files/entryIndex.js";
import { FileSystemTransactions } from "../files/fileSystemTransactions.js";
import { initializeGenesisFileSystem } from "../files/genesisFileSystem.js";
import { ImmutableObjectRepository } from "../files/immutableObjectRepository.js";
import type {
  CreateObjectResult,
  ImmutableObjectStore,
  ObjectKey,
  ObjectListItem,
  ObjectMetadata,
} from "../files/objectStore.js";
import { ResourceContentService } from "./resourceContentService.js";
import { ResourceSessionRegistry } from "./resourceSessionRegistry.js";

const roots: string[] = [];
const appId = "io.example.player";

class MemoryStore implements ImmutableObjectStore {
  readonly objects = new Map<string, Uint8Array>();

  async create(
    key: ObjectKey,
    bytes: Uint8Array,
  ): Promise<CreateObjectResult> {
    const encoded = JSON.stringify(key);
    if (this.objects.has(encoded)) {
      return "already-exists-identical";
    }
    this.objects.set(encoded, Uint8Array.from(bytes));
    return "created";
  }

  async get(key: ObjectKey): Promise<Uint8Array> {
    const value = this.objects.get(JSON.stringify(key));
    if (!value) throw new Error("missing");
    return Uint8Array.from(value);
  }

  async head(key: ObjectKey): Promise<ObjectMetadata> {
    return { size: (await this.get(key)).byteLength };
  }

  async list(): Promise<ObjectListItem[]> {
    return [];
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "biunivers-resource-content-"));
  roots.push(root);
  const repository = new ImmutableObjectRepository(
    new MemoryStore(),
    "users/test",
  );
  const ids = [id(0x10), id(0x20)];
  const genesis = await initializeGenesisFileSystem({
    databasePath: join(root, "refs.sqlite"),
    repository,
    writerId: "test",
    randomId: () => ids.shift()!,
  });
  const content = await new FileContentStore(repository).putBytes(
    Buffer.from("0123456789"),
  );
  const created = await new FileSystemTransactions({
    refId: "main",
    repository,
    refStore: genesis.store,
    writerId: "test",
  }).createFile({
    parentEntryIdHex: genesis.rootEntryIdHex,
    name: "movie.bin",
    content,
  });
  const index = await loadCurrentEntryIndex(repository, genesis.store, "main");
  const entry = index.get(created.entryIdHex)!;
  const sessions = new ResourceSessionRegistry();
  const service = new ResourceContentService({
    repository,
    refStore: genesis.store,
    writerId: "test",
    sessions,
    maxWriteBytes: 1024,
  });
  return {
    repository,
    refStore: genesis.store,
    entry,
    sessions,
    service,
    revision: index.revision,
    rootEntryIdHex: genesis.rootEntryIdHex,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("ResourceContentService", () => {
  it("reuses one session for full and repeated range reads", async () => {
    const fixture = await setup();
    const session = fixture.sessions.issueFile(
      appId,
      fixture.entry,
      fixture.revision,
      "read",
    );

    const full = await fixture.service.read(appId, session.sessionId);
    expect(full).toMatchObject({
      status: 200,
      size: 10,
      contentLength: 10,
      range: null,
    });
    await expect(collect(full.chunks)).resolves.toBe("0123456789");

    const first = await fixture.service.read(
      appId,
      session.sessionId,
      "bytes=2-5",
    );
    expect(first).toMatchObject({
      status: 206,
      contentLength: 4,
      range: { start: 2, endInclusive: 5, length: 4 },
    });
    await expect(collect(first.chunks)).resolves.toBe("2345");

    const second = await fixture.service.read(
      appId,
      session.sessionId,
      "bytes=-2",
    );
    await expect(collect(second.chunks)).resolves.toBe("89");
    fixture.refStore.close();
  });

  it("saves repeatedly and advances the session snapshot", async () => {
    const fixture = await setup();
    const session = fixture.sessions.issueFile(
      appId,
      fixture.entry,
      fixture.revision,
      "edit",
    );

    const first = await fixture.service.write(
      appId,
      session.sessionId,
      chunks("updated"),
      7,
    );
    expect(first).toMatchObject({ revision: 2, size: 7 });
    const second = await fixture.service.write(
      appId,
      session.sessionId,
      chunks("again"),
      5,
    );
    expect(second).toMatchObject({ revision: 3, size: 5 });

    const read = await fixture.service.read(appId, session.sessionId);
    await expect(collect(read.chunks)).resolves.toBe("again");
    fixture.refStore.close();
  });

  it("creates a pending save target only after a successful PUT", async () => {
    const fixture = await setup();
    const session = fixture.sessions.issuePendingFile(
      appId,
      fixture.rootEntryIdHex,
      "new.txt",
      fixture.revision,
      "text/plain",
    );

    const before = await loadCurrentEntryIndex(
      fixture.repository,
      fixture.refStore,
      "main",
    );
    expect(before.listChildren(fixture.rootEntryIdHex)).toHaveLength(1);

    await fixture.service.write(
      appId,
      session.sessionId,
      chunks("new"),
      3,
    );
    const after = await loadCurrentEntryIndex(
      fixture.repository,
      fixture.refStore,
      "main",
    );
    expect(
      after.listChildren(fixture.rootEntryIdHex).map((entry) => entry.name),
    ).toEqual(["movie.bin", "new.txt"]);
    fixture.refStore.close();
  });

  it("preserves the old version after an external save conflict", async () => {
    const fixture = await setup();
    const session = fixture.sessions.issueFile(
      appId,
      fixture.entry,
      fixture.revision,
      "edit",
    );
    await new FileSystemTransactions({
      refId: "main",
      repository: fixture.repository,
      refStore: fixture.refStore,
      writerId: "other",
    }).setFileContent({
      entryIdHex: fixture.entry.entryIdHex,
      expectedContentFidHex: fixture.entry.content!.fidHex,
      content: await new FileContentStore(fixture.repository).putBytes(
        Buffer.from("external"),
      ),
    });

    await expect(
      fixture.service.write(appId, session.sessionId, chunks("mine"), 4),
    ).rejects.toMatchObject({ code: "FILE_VERSION_CONFLICT" });
    const current = await loadCurrentEntryIndex(
      fixture.repository,
      fixture.refStore,
      "main",
    );
    const entry = current.get(fixture.entry.entryIdHex)!;
    const parts = new FileContentStore(fixture.repository).readChunks(
      entry.content!,
    );
    await expect(collect(parts)).resolves.toBe("external");
    fixture.refStore.close();
  });
});

async function* chunks(value: string) {
  yield Buffer.from(value);
}

async function collect(source: AsyncIterable<Uint8Array>) {
  const parts = [];
  for await (const part of source) parts.push(Buffer.from(part));
  return Buffer.concat(parts).toString();
}

function id(fill: number): Uint8Array {
  return new Uint8Array(16).fill(fill);
}
