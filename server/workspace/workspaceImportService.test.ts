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
import { WorkspaceDeriver } from "./workspaceDeriver.js";
import { WorkspaceImportService } from "./workspaceImportService.js";
import { WorkspaceContentImportService } from "./workspaceContentImportService.js";

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
    if (!bytes) throw new Error("missing");
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
  const root = await mkdtemp(join(tmpdir(), "biunivers-workspace-import-"));
  roots.push(root);
  const repository = new ImmutableObjectRepository(
    new MemoryStore(),
    "users/alice",
  );
  const genesisIds = ids(0x10, 2);
  const genesis = await initializeGenesisFileSystem({
    databasePath: join(root, "refs.sqlite"),
    repository,
    writerId: "test",
    createdAtMs: 100,
    randomId: () => genesisIds.shift()!,
  });
  const mainIds = ids(0x20, 16);
  const mainTransactions = new FileSystemTransactions({
    refId: "main",
    repository,
    refStore: genesis.store,
    writerId: "main-test",
    now: () => 200,
    randomId: () => mainIds.shift()!,
  });
  const contentStore = new FileContentStore(repository);
  const originalContent = await contentStore.putBytes(Buffer.from("original"));
  const project = await mainTransactions.createDirectory({
    parentEntryIdHex: genesis.rootEntryIdHex,
    name: "project",
  });
  await mainTransactions.createFile({
    parentEntryIdHex: project.entryIdHex,
    name: "note.txt",
    content: originalContent,
  });
  const imports = await mainTransactions.createDirectory({
    parentEntryIdHex: genesis.rootEntryIdHex,
    name: "imports",
  });
  const deriveIds = ids(0x40, 16);
  const derived = await new WorkspaceDeriver({
    repository,
    refStore: genesis.store,
    writerId: "derive-test",
    now: () => 300,
    randomId: () => deriveIds.shift()!,
  }).derive({
    name: "Import fixture",
    selectedEntryIdsHex: [project.entryIdHex],
  });
  const workspaceIndex = await loadCurrentEntryIndex(
    repository,
    genesis.store,
    derived.workspace.refId,
  );
  const workspaceProject = workspaceIndex.listChildren(
    workspaceIndex.rootEntryIdHex,
  )[0]!;
  const workspaceNote = workspaceIndex.listChildren(
    workspaceProject.entryIdHex,
  )[0]!;
  const changedContent = await contentStore.putBytes(Buffer.from("changed"));
  const workspaceIds = ids(0x60, 16);
  const workspaceTransactions = new FileSystemTransactions({
    refId: derived.workspace.refId,
    repository,
    refStore: genesis.store,
    writerId: "workspace-test",
    now: () => 400,
    randomId: () => workspaceIds.shift()!,
  });
  await workspaceTransactions.setFileContent({
    entryIdHex: workspaceNote.entryIdHex,
    expectedContentFidHex: workspaceNote.content!.fidHex,
    content: changedContent,
  });
  const resultDirectory = await workspaceTransactions.createDirectory({
    parentEntryIdHex: workspaceProject.entryIdHex,
    name: "result",
  });
  const generatedContent = await contentStore.putBytes(Buffer.from("generated"));
  await workspaceTransactions.createFile({
    parentEntryIdHex: resultDirectory.entryIdHex,
    name: "answer.txt",
    content: generatedContent,
  });

  return {
    repository,
    refStore: genesis.store,
    mainTransactions,
    mainRootEntryIdHex: genesis.rootEntryIdHex,
    mainProjectEntryIdHex: project.entryIdHex,
    importsEntryIdHex: imports.entryIdHex,
    workspaceIdHex: derived.workspace.workspaceIdHex,
    workspaceProjectEntryIdHex: workspaceProject.entryIdHex,
    changedContent,
    generatedContent,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("WorkspaceContentImportService", () => {
  it("atomically adds a recursive main selection with new IDs, reused FIDs, and automatic renaming", async () => {
    const fixture = await setup();
    const workspace = fixture.refStore.getWorkspace(fixture.workspaceIdHex);
    const workspaceBefore = fixture.refStore.getRef(workspace.refId);
    const mainBefore = fixture.refStore.getRef("main");
    const targetBefore = await loadCurrentEntryIndex(fixture.repository, fixture.refStore, workspace.refId);
    const importIds = ids(0xa0, 16);
    const service = new WorkspaceContentImportService({
      repository: fixture.repository,
      refStore: fixture.refStore,
      writerId: "content-import-test",
      randomId: () => importIds.shift()!,
    });

    const result = await service.execute({
      workspaceIdHex: fixture.workspaceIdHex,
      selectedEntryIdsHex: [fixture.mainProjectEntryIdHex],
      destinationEntryIdHex: targetBefore.rootEntryIdHex,
      mainRevision: mainBefore.revision,
      workspaceRevision: workspaceBefore.revision,
    });

    expect(result.revision).toBe(workspaceBefore.revision + 1);
    expect(result.roots[0]?.name).toBe("project (main)");
    const target = await loadCurrentEntryIndex(fixture.repository, fixture.refStore, workspace.refId);
    const imported = target.listChildren(target.rootEntryIdHex).find((entry) => entry.name === "project (main)")!;
    expect(imported.entryIdHex).not.toBe(fixture.mainProjectEntryIdHex);
    const source = await loadCurrentEntryIndex(fixture.repository, fixture.refStore, "main");
    expect(target.listChildren(imported.entryIdHex)[0]?.content).toEqual(
      source.listChildren(fixture.mainProjectEntryIdHex)[0]?.content,
    );
    expect(fixture.refStore.getRef("main")).toEqual(mainBefore);
  });

  it("does not publish when main changes before the guarded Workspace CAS", async () => {
    const fixture = await setup();
    const workspace = fixture.refStore.getWorkspace(fixture.workspaceIdHex);
    const workspaceBefore = fixture.refStore.getRef(workspace.refId);
    const mainBefore = fixture.refStore.getRef("main");
    const target = await loadCurrentEntryIndex(fixture.repository, fixture.refStore, workspace.refId);
    await fixture.mainTransactions.createDirectory({
      parentEntryIdHex: fixture.mainRootEntryIdHex,
      name: "concurrent",
    });
    const service = new WorkspaceContentImportService({
      repository: fixture.repository,
      refStore: fixture.refStore,
      writerId: "content-import-test",
    });
    await expect(service.execute({
      workspaceIdHex: fixture.workspaceIdHex,
      selectedEntryIdsHex: [fixture.mainProjectEntryIdHex],
      destinationEntryIdHex: target.rootEntryIdHex,
      mainRevision: mainBefore.revision,
      workspaceRevision: workspaceBefore.revision,
    })).rejects.toMatchObject<Partial<RefStoreError>>({ code: "REF_CONFLICT" });
    expect(fixture.refStore.getRef(workspace.refId)).toEqual(workspaceBefore);
  });
});

describe("WorkspaceImportService", () => {
  it("atomically imports a recursive selection with new Entry IDs and reused content FIDs", async () => {
    const fixture = await setup();
    const importIds = ids(0x80, 16);
    const service = new WorkspaceImportService({
      repository: fixture.repository,
      refStore: fixture.refStore,
      writerId: "import-test",
      randomId: () => importIds.shift()!,
    });
    const workspace = fixture.refStore.getWorkspace(fixture.workspaceIdHex);
    const workspaceRef = fixture.refStore.getRef(workspace.refId);
    const mainBefore = fixture.refStore.getRef("main");

    const result = await service.execute({
      workspaceIdHex: fixture.workspaceIdHex,
      selectedEntryIdsHex: [fixture.workspaceProjectEntryIdHex],
      destinationEntryIdHex: fixture.importsEntryIdHex,
      workspaceRevision: workspaceRef.revision,
      mainRevision: mainBefore.revision,
      conflictPolicy: "cancel",
    });

    expect(result.revision).toBe(mainBefore.revision + 1);
    expect(result.roots).toHaveLength(1);
    expect(result.roots[0]?.newEntryIdHex).not.toBe(
      fixture.workspaceProjectEntryIdHex,
    );
    const main = await loadCurrentEntryIndex(
      fixture.repository,
      fixture.refStore,
      "main",
    );
    const importedProject = main
      .listChildren(fixture.importsEntryIdHex)
      .find((entry) => entry.name === "project")!;
    const importedChildren = main.listChildren(importedProject.entryIdHex);
    expect(importedChildren.map((entry) => entry.name)).toEqual([
      "note.txt",
      "result",
    ]);
    expect(
      importedChildren.find((entry) => entry.name === "note.txt")?.content,
    ).toEqual(fixture.changedContent);
    const importedResult = importedChildren.find(
      (entry) => entry.name === "result",
    )!;
    expect(main.listChildren(importedResult.entryIdHex)[0]?.content).toEqual(
      fixture.generatedContent,
    );
  });

  it("does not publish when either revision or destination naming conflicts", async () => {
    const fixture = await setup();
    const service = new WorkspaceImportService({
      repository: fixture.repository,
      refStore: fixture.refStore,
      writerId: "import-test",
    });
    const workspace = fixture.refStore.getWorkspace(fixture.workspaceIdHex);
    const workspaceRevision = fixture.refStore.getRef(
      workspace.refId,
    ).revision;
    const staleMainRevision = fixture.refStore.getRef("main").revision;
    await fixture.mainTransactions.createDirectory({
      parentEntryIdHex: fixture.importsEntryIdHex,
      name: "unrelated",
    });
    const mainAfterConcurrentChange = fixture.refStore.getRef("main");

    await expect(
      service.execute({
        workspaceIdHex: fixture.workspaceIdHex,
        selectedEntryIdsHex: [fixture.workspaceProjectEntryIdHex],
        destinationEntryIdHex: fixture.importsEntryIdHex,
        workspaceRevision,
        mainRevision: staleMainRevision,
        conflictPolicy: "cancel",
      }),
    ).rejects.toMatchObject<Partial<RefStoreError>>({ code: "REF_CONFLICT" });
    expect(fixture.refStore.getRef("main")).toEqual(mainAfterConcurrentChange);

    await fixture.mainTransactions.createDirectory({
      parentEntryIdHex: fixture.importsEntryIdHex,
      name: "project",
    });
    const mainBeforeNamingConflict = fixture.refStore.getRef("main");
    await expect(
      service.execute({
        workspaceIdHex: fixture.workspaceIdHex,
        selectedEntryIdsHex: [fixture.workspaceProjectEntryIdHex],
        destinationEntryIdHex: fixture.importsEntryIdHex,
        workspaceRevision,
        mainRevision: mainBeforeNamingConflict.revision,
        conflictPolicy: "cancel",
      }),
    ).rejects.toThrow("already contains");
    expect(fixture.refStore.getRef("main")).toEqual(mainBeforeNamingConflict);
    const main = await loadCurrentEntryIndex(
      fixture.repository,
      fixture.refStore,
      "main",
    );
    expect(
      main
        .listChildren(fixture.importsEntryIdHex)
        .filter((entry) => entry.name === "project"),
    ).toHaveLength(1);
  });
});

function ids(start: number, count: number): Uint8Array[] {
  return Array.from({ length: count }, (_, index) =>
    Uint8Array.from({ length: 16 }, () => start + index),
  );
}
