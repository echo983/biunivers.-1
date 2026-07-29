import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileCapabilityRegistry } from "./fileCapabilityRegistry.js";
import { FileContentStore } from "./fileContentStore.js";
import { loadCurrentEntryIndex } from "./entryIndex.js";
import { FileSystemTransactions } from "./fileSystemTransactions.js";
import { FileTransferService } from "./fileTransferService.js";
import { FileHostService } from "./fileHostService.js";
import { initializeGenesisFileSystem } from "./genesisFileSystem.js";
import { ImmutableObjectRepository } from "./immutableObjectRepository.js";
import type {
  CreateObjectResult,
  ImmutableObjectStore,
  ObjectKey,
  ObjectListItem,
  ObjectMetadata,
} from "./objectStore.js";

const roots: string[] = [];

class MemoryStore implements ImmutableObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  failCreates = false;

  async create(
    key: ObjectKey,
    bytes: Uint8Array,
  ): Promise<CreateObjectResult> {
    if (this.failCreates) {
      throw new Error("simulated object store outage");
    }
    const encoded = JSON.stringify(key);
    const existing = this.objects.get(encoded);
    if (existing) {
      return "already-exists-identical";
    }
    this.objects.set(encoded, Uint8Array.from(bytes));
    return "created";
  }

  async get(key: ObjectKey): Promise<Uint8Array> {
    const value = this.objects.get(JSON.stringify(key));
    if (!value) {
      throw new Error("missing");
    }
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
  const root = await mkdtemp(join(tmpdir(), "biunivers-transfer-service-"));
  roots.push(root);
  const objectStore = new MemoryStore();
  const repository = new ImmutableObjectRepository(objectStore, "users/test");
  const ids = [id(0x10), id(0x20)];
  const genesis = await initializeGenesisFileSystem({
    databasePath: join(root, "refs.sqlite"),
    repository,
    writerId: "test",
    randomId: () => ids.shift()!,
  });
  const contentStore = new FileContentStore(repository);
  const content = await contentStore.putBytes(Buffer.from("original"));
  const transactionIds = [id(0x30), id(0x40)];
  const transactions = new FileSystemTransactions({
    repository,
    refStore: genesis.store,
    writerId: "test",
    randomId: () => transactionIds.shift()!,
  });
  const created = await transactions.createFile({
    parentEntryIdHex: genesis.rootEntryIdHex,
    name: "notes.md",
    content,
  });
  const index = await loadCurrentEntryIndex(repository, genesis.store);
  const entry = index.get(created.entryIdHex)!;
  const capabilities = new FileCapabilityRegistry();
  const instance = capabilities.createInstance(
    "io.example.notes",
    "window-1",
  );
  return {
    repository,
    objectStore,
    refStore: genesis.store,
    contentStore,
    capabilities,
    instanceToken: instance.instanceToken,
    entry,
    service: new FileTransferService({
      repository,
      refStore: genesis.store,
      writerId: "test",
      capabilities,
    }),
    host: new FileHostService({
      repository,
      refStore: genesis.store,
      capabilities,
      maxWriteBytes: 1_024,
    }),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("FileTransferService", () => {
  it("lists safe metadata and issues handles and transfers for an instance", async () => {
    const fixture = await setup();
    const listing = await fixture.host.listDirectory(fixture.instanceToken);
    expect(listing.entries).toEqual([
      {
        entryId: fixture.entry.entryIdHex,
        name: "notes.md",
        kind: "file",
        size: 8,
        mtimeMs: fixture.entry.mtimeMs,
      },
    ]);
    expect(JSON.stringify(listing)).not.toContain(
      fixture.entry.content?.fidHex,
    );
    const handle = await fixture.host.issueHandle(
      fixture.instanceToken,
      fixture.entry.entryIdHex,
      true,
    );
    await expect(
      fixture.host.getMetadata(fixture.instanceToken, handle.handleId),
    ).resolves.toMatchObject({
      entryId: fixture.entry.entryIdHex,
      writable: true,
      changed: false,
    });
    expect(
      fixture.host.issueTransfer(
        fixture.instanceToken,
        handle.handleId,
        "PUT",
      ),
    ).toMatchObject({ method: "PUT", maxBytes: 1_024 });
    fixture.host.releaseHandle(fixture.instanceToken, handle.handleId);
    fixture.refStore.close();
  });

  it("streams the exact content bound to a read handle once", async () => {
    const fixture = await setup();
    const handle = fixture.capabilities.issueHandle(
      fixture.instanceToken,
      fixture.entry,
      1,
      false,
    );
    const transfer = fixture.capabilities.issueTransfer(
      fixture.instanceToken,
      handle.handleId,
      "GET",
      999,
    );
    const read = await fixture.service.read(
      fixture.instanceToken,
      transfer.transferId,
    );
    const chunks = [];
    for await (const chunk of read.chunks) {
      chunks.push(chunk);
    }
    expect(Buffer.concat(chunks).toString()).toBe("original");
    expect(() =>
      fixture.capabilities.beginTransfer(
        fixture.instanceToken,
        transfer.transferId,
        "GET",
      ),
    ).toThrow();
    fixture.refStore.close();
  });

  it("streams a bounded write and atomically publishes new content", async () => {
    const fixture = await setup();
    const handle = fixture.capabilities.issueHandle(
      fixture.instanceToken,
      fixture.entry,
      1,
      true,
    );
    const transfer = fixture.capabilities.issueTransfer(
      fixture.instanceToken,
      handle.handleId,
      "PUT",
      100,
    );
    async function* source() {
      yield Buffer.from("up");
      yield Buffer.from("dated");
    }
    const result = await fixture.service.write(
      fixture.instanceToken,
      transfer.transferId,
      source(),
      7,
    );
    expect(result).toMatchObject({
      entryId: fixture.entry.entryIdHex,
      revision: 2,
      size: 7,
    });
    const index = await loadCurrentEntryIndex(
      fixture.repository,
      fixture.refStore,
    );
    const updated = index.get(fixture.entry.entryIdHex)!;
    const chunks = [];
    for await (const chunk of fixture.contentStore.readChunks(updated.content!)) {
      chunks.push(chunk);
    }
    expect(Buffer.concat(chunks).toString()).toBe("updated");
    fixture.refStore.close();
  });

  it("creates no file until a saveAs handle receives a complete PUT", async () => {
    const fixture = await setup();
    const before = await fixture.host.listDirectory(fixture.instanceToken);
    const pending = await fixture.host.issueSaveHandle(
      fixture.instanceToken,
      before.rootEntryId,
      "new-note.md",
    );
    expect(before.entries.map((entry) => entry.name)).not.toContain(
      "new-note.md",
    );
    await expect(
      fixture.host.getMetadata(fixture.instanceToken, pending.handleId),
    ).resolves.toMatchObject({
      name: "new-note.md",
      pending: true,
      size: 0,
    });

    const transfer = fixture.host.issueTransfer(
      fixture.instanceToken,
      pending.handleId,
      "PUT",
    );
    async function* source() {
      yield Buffer.from("new content");
    }
    const result = await fixture.service.write(
      fixture.instanceToken,
      transfer.transferId,
      source(),
      11,
    );
    expect(result).toMatchObject({ revision: 2, size: 11 });
    const after = await fixture.host.listDirectory(fixture.instanceToken);
    expect(after.entries).toContainEqual(
      expect.objectContaining({
        entryId: result.entryId,
        name: "new-note.md",
        size: 11,
      }),
    );
    await expect(
      fixture.host.getMetadata(fixture.instanceToken, pending.handleId),
    ).resolves.toMatchObject({
      entryId: result.entryId,
      pending: false,
      changed: false,
    });
    fixture.refStore.close();
  });

  it("rejects stale handles before reading or publishing", async () => {
    const fixture = await setup();
    const handle = fixture.capabilities.issueHandle(
      fixture.instanceToken,
      { ...fixture.entry, content: { ...fixture.entry.content!, fidHex: "aa".repeat(16) } },
      1,
      true,
    );
    const transfer = fixture.capabilities.issueTransfer(
      fixture.instanceToken,
      handle.handleId,
      "GET",
      1,
    );
    await expect(
      fixture.service.read(fixture.instanceToken, transfer.transferId),
    ).rejects.toMatchObject({ code: "FILE_VERSION_CONFLICT" });
    fixture.refStore.close();
  });

  it("prevents a stale writable handle from overwriting a newer revision", async () => {
    const fixture = await setup();
    const first = fixture.capabilities.issueHandle(
      fixture.instanceToken,
      fixture.entry,
      1,
      true,
    );
    const stale = fixture.capabilities.issueHandle(
      fixture.instanceToken,
      fixture.entry,
      1,
      true,
    );
    const firstTransfer = fixture.capabilities.issueTransfer(
      fixture.instanceToken,
      first.handleId,
      "PUT",
      100,
    );
    async function* firstWrite() {
      yield Buffer.from("winner");
    }
    await fixture.service.write(
      fixture.instanceToken,
      firstTransfer.transferId,
      firstWrite(),
      6,
    );

    const staleTransfer = fixture.capabilities.issueTransfer(
      fixture.instanceToken,
      stale.handleId,
      "PUT",
      100,
    );
    async function* staleWrite() {
      yield Buffer.from("loser");
    }
    await expect(
      fixture.service.write(
        fixture.instanceToken,
        staleTransfer.transferId,
        staleWrite(),
        5,
      ),
    ).rejects.toMatchObject({
      code: "FILE_VERSION_CONFLICT",
    });
    const index = await loadCurrentEntryIndex(
      fixture.repository,
      fixture.refStore,
    );
    expect(index.revision).toBe(2);
    const chunks = [];
    for await (const chunk of fixture.contentStore.readChunks(
      index.get(fixture.entry.entryIdHex)!.content!,
    )) {
      chunks.push(chunk);
    }
    expect(Buffer.concat(chunks).toString()).toBe("winner");
    fixture.refStore.close();
  });

  it("does not publish a file when immutable storage fails mid-save", async () => {
    const fixture = await setup();
    const listing = await fixture.host.listDirectory(fixture.instanceToken);
    const pending = await fixture.host.issueSaveHandle(
      fixture.instanceToken,
      listing.rootEntryId,
      "must-not-appear.txt",
    );
    const transfer = fixture.host.issueTransfer(
      fixture.instanceToken,
      pending.handleId,
      "PUT",
    );
    fixture.objectStore.failCreates = true;
    async function* source() {
      yield Buffer.from("uncommitted");
    }
    await expect(
      fixture.service.write(
        fixture.instanceToken,
        transfer.transferId,
        source(),
        11,
      ),
    ).rejects.toThrow("simulated object store outage");
    fixture.objectStore.failCreates = false;

    const after = await fixture.host.listDirectory(fixture.instanceToken);
    expect(after.revision).toBe(1);
    expect(after.entries.map((entry) => entry.name)).not.toContain(
      "must-not-appear.txt",
    );
    fixture.refStore.close();
  });
});

function id(byte: number): Uint8Array {
  return Uint8Array.from({ length: 16 }, () => byte);
}
