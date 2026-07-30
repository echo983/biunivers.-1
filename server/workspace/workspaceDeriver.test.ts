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
import { RefStoreError } from "../files/sqliteRefStore.js";
import {
  WorkspaceDerivationError,
  WorkspaceDeriver,
} from "./workspaceDeriver.js";

const roots: string[] = [];

class MemoryStore implements ImmutableObjectStore {
  readonly objects = new Map<string, Uint8Array>();

  async create(
    key: ObjectKey,
    completeBytes: Uint8Array,
  ): Promise<CreateObjectResult> {
    const encoded = JSON.stringify(key);
    const existing = this.objects.get(encoded);
    if (existing) {
      if (!Buffer.from(existing).equals(Buffer.from(completeBytes))) {
        throw new Error("collision");
      }
      return "already-exists-identical";
    }
    this.objects.set(encoded, Uint8Array.from(completeBytes));
    return "created";
  }

  async get(key: ObjectKey): Promise<Uint8Array> {
    const bytes = this.objects.get(JSON.stringify(key));
    if (!bytes) {
      throw new Error("missing");
    }
    return Uint8Array.from(bytes);
  }

  async head(key: ObjectKey): Promise<ObjectMetadata> {
    return { size: (await this.get(key)).byteLength };
  }

  async list(): Promise<ObjectListItem[]> {
    return [];
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "biunivers-workspace-derive-"));
  roots.push(root);
  const repository = new ImmutableObjectRepository(
    new MemoryStore(),
    "users/alice",
  );
  const genesisIds = [id(0x10), id(0x20)];
  const genesis = await initializeGenesisFileSystem({
    databasePath: join(root, "refs.sqlite"),
    repository,
    writerId: "test",
    createdAtMs: 100,
    randomId: () => genesisIds.shift()!,
  });
  const transactionIds = Array.from({ length: 16 }, (_, index) =>
    id(0x30 + index),
  );
  const transactions = new FileSystemTransactions({
    refId: "main",
    repository,
    refStore: genesis.store,
    writerId: "test",
    now: () => 200,
    randomId: () => transactionIds.shift()!,
  });
  const contentStore = new FileContentStore(repository);
  const noteContent = await contentStore.putBytes(Buffer.from("workspace note"));
  const looseContent = await contentStore.putBytes(Buffer.from("loose"));
  const ignoredContent = await contentStore.putBytes(Buffer.from("ignored"));
  const folder = await transactions.createDirectory({
    parentEntryIdHex: genesis.rootEntryIdHex,
    name: "project",
  });
  const nested = await transactions.createDirectory({
    parentEntryIdHex: folder.entryIdHex,
    name: "docs",
  });
  const note = await transactions.createFile({
    parentEntryIdHex: nested.entryIdHex,
    name: "note.md",
    content: noteContent,
  });
  const loose = await transactions.createFile({
    parentEntryIdHex: genesis.rootEntryIdHex,
    name: "loose.txt",
    content: looseContent,
  });
  const ignored = await transactions.createFile({
    parentEntryIdHex: genesis.rootEntryIdHex,
    name: "ignored.txt",
    content: ignoredContent,
  });
  const empty = await transactions.createDirectory({
    parentEntryIdHex: genesis.rootEntryIdHex,
    name: "empty",
  });
  return {
    repository,
    refStore: genesis.store,
    rootEntryIdHex: genesis.rootEntryIdHex,
    transactions,
    folder,
    nested,
    note,
    loose,
    ignored,
    empty,
    noteContent,
    looseContent,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("WorkspaceDeriver", () => {
  it("publishes a revision-zero independent tree while reusing content FIDs", async () => {
    const source = await setup();
    const ids = Array.from({ length: 16 }, (_, index) => id(0x80 + index));
    const deriver = new WorkspaceDeriver({
      repository: source.repository,
      refStore: source.refStore,
      writerId: "workspace-test",
      now: () => 500,
      randomId: () => ids.shift()!,
    });

    const result = await deriver.derive({
      name: "Selected project",
      selectedEntryIdsHex: [
        source.folder.entryIdHex,
        source.loose.entryIdHex,
        source.empty.entryIdHex,
      ],
      retention: "KEPT",
    });

    expect(result.workspace.refId).toBe(
      `ws-${result.workspace.workspaceIdHex}`,
    );
    expect(result.workspace.sourceRefId).toBe("main");
    expect(result.workspace.retention).toBe("KEPT");
    expect(result.workspace.baselineHeadFidHex).not.toBe(
      result.workspace.sourceHeadFidHex,
    );
    expect(source.refStore.getRef(result.workspace.refId).revision).toBe(0);
    const index = await loadCurrentEntryIndex(
      source.repository,
      source.refStore,
      result.workspace.refId,
    );
    expect(index.revision).toBe(0);
    expect(result.entryCount).toBe(6);
    expect(index.rootEntryIdHex).toBe(result.rootEntryIdHex);
    expect(index.rootEntryIdHex).not.toBe(source.rootEntryIdHex);

    const topLevel = index.listChildren(index.rootEntryIdHex);
    expect(topLevel.map((entry) => entry.name)).toEqual([
      "empty",
      "loose.txt",
      "project",
    ]);
    const project = topLevel.find((entry) => entry.name === "project")!;
    const docs = index.listChildren(project.entryIdHex)[0];
    const note = index.listChildren(docs.entryIdHex)[0];
    const loose = topLevel.find((entry) => entry.name === "loose.txt")!;
    expect([
      project.entryIdHex,
      docs.entryIdHex,
      note.entryIdHex,
      loose.entryIdHex,
    ]).not.toContain(source.folder.entryIdHex);
    expect(note.content).toEqual(source.noteContent);
    expect(loose.content).toEqual(source.looseContent);
    const empty = topLevel.find((entry) => entry.name === "empty")!;
    expect(index.listChildren(empty.entryIdHex)).toEqual([]);
    expect(index.listChildren(index.rootEntryIdHex)).not.toContainEqual(
      expect.objectContaining({ name: "ignored.txt" }),
    );
  });

  it("rejects selections whose Entries do not share one direct parent", async () => {
    const source = await setup();
    const deriver = new WorkspaceDeriver({
      repository: source.repository,
      refStore: source.refStore,
      writerId: "workspace-test",
    });
    await expect(
      deriver.derive({
        name: "Invalid",
        selectedEntryIdsHex: [
          source.loose.entryIdHex,
          source.note.entryIdHex,
        ],
      }),
    ).rejects.toMatchObject<Partial<WorkspaceDerivationError>>({
      code: "SELECTION_PARENT_MISMATCH",
    });
  });

  it("enforces recursive Entry and depth limits before publication", async () => {
    const source = await setup();
    const entryLimited = new WorkspaceDeriver({
      repository: source.repository,
      refStore: source.refStore,
      writerId: "workspace-test",
      maxDerivedEntries: 3,
    });
    await expect(
      entryLimited.derive({
        name: "Too many",
        selectedEntryIdsHex: [source.folder.entryIdHex],
      }),
    ).rejects.toMatchObject<Partial<WorkspaceDerivationError>>({
      code: "ENTRY_LIMIT_EXCEEDED",
    });

    const depthLimited = new WorkspaceDeriver({
      repository: source.repository,
      refStore: source.refStore,
      writerId: "workspace-test",
      maxDepth: 2,
    });
    await expect(
      depthLimited.derive({
        name: "Too deep",
        selectedEntryIdsHex: [source.folder.entryIdHex],
      }),
    ).rejects.toMatchObject<Partial<WorkspaceDerivationError>>({
      code: "DEPTH_LIMIT_EXCEEDED",
    });
  });

  it("rejects duplicate selections and oversized packed metadata", async () => {
    const source = await setup();
    const deriver = new WorkspaceDeriver({
      repository: source.repository,
      refStore: source.refStore,
      writerId: "workspace-test",
      maxPackedBytes: 100,
    });
    await expect(
      deriver.derive({
        name: "Duplicate",
        selectedEntryIdsHex: [
          source.loose.entryIdHex,
          source.loose.entryIdHex,
        ],
      }),
    ).rejects.toMatchObject<Partial<WorkspaceDerivationError>>({
      code: "INVALID_SELECTION",
    });
    await expect(
      deriver.derive({
        name: "Too large",
        selectedEntryIdsHex: [source.loose.entryIdHex],
      }),
    ).rejects.toMatchObject<Partial<WorkspaceDerivationError>>({
      code: "METADATA_LIMIT_EXCEEDED",
    });
  });

  it("leaves no Workspace or Ref when the source Head changes before publication", async () => {
    const source = await setup();
    const ids = Array.from({ length: 12 }, (_, index) => id(0xe0 + index));
    const workspaceIdHex = Buffer.from(ids[0]).toString("hex");
    const deriver = new WorkspaceDeriver({
      repository: source.repository,
      refStore: source.refStore,
      writerId: "workspace-test",
      now: () => 500,
      randomId: () => ids.shift()!,
      beforePublish: async () => {
        await source.transactions.createDirectory({
          parentEntryIdHex: source.rootEntryIdHex,
          name: "raced",
        });
      },
    });

    await expect(
      deriver.derive({
        name: "Raced",
        selectedEntryIdsHex: [source.loose.entryIdHex],
      }),
    ).rejects.toMatchObject<Partial<RefStoreError>>({
      code: "REF_CONFLICT",
    });
    expect(() =>
      source.refStore.getRef(`ws-${workspaceIdHex}`),
    ).toThrowError(
      expect.objectContaining<Partial<RefStoreError>>({
        code: "REF_NOT_FOUND",
      }),
    );
    expect(() => source.refStore.getWorkspace(workspaceIdHex)).toThrowError(
      expect.objectContaining<Partial<RefStoreError>>({
        code: "WORKSPACE_NOT_FOUND",
      }),
    );
  });
});

function id(byte: number): Uint8Array {
  return new Uint8Array(16).fill(byte);
}
