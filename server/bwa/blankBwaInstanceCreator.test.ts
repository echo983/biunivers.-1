import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCurrentEntryIndex } from "../files/entryIndex.js";
import { initializeGenesisFileSystem } from "../files/genesisFileSystem.js";
import { ImmutableObjectRepository } from "../files/immutableObjectRepository.js";
import type {
  CreateObjectResult,
  ImmutableObjectStore,
  ObjectKey,
  ObjectListItem,
  ObjectMetadata,
} from "../files/objectStore.js";
import { BlankBwaInstanceCreator } from "./blankBwaInstanceCreator.js";

const roots: string[] = [];

class MemoryStore implements ImmutableObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  async create(key: ObjectKey, bytes: Uint8Array): Promise<CreateObjectResult> {
    const encoded = JSON.stringify(key);
    if (this.objects.has(encoded)) return "already-exists-identical";
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("BlankBwaInstanceCreator", () => {
  it("atomically publishes an empty Workspace, Instance, and default binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "biunivers-bwa-blank-"));
    roots.push(root);
    const repository = new ImmutableObjectRepository(new MemoryStore(), "users/test");
    const genesisIds = [Buffer.alloc(16, 0x10), Buffer.alloc(16, 0x11)];
    const genesis = await initializeGenesisFileSystem({
      databasePath: join(root, "refs.sqlite"),
      repository,
      writerId: "test",
      createdAtMs: 100,
      randomId: () => genesisIds.shift()!,
    });
    genesis.store.createBwaApplication({
      applicationId: "ghcr.io/echo983/probe",
      installedDigest: `sha256:${"a".repeat(64)}`,
      previousDigest: null,
      protocolVersion: 1,
      title: "Probe",
      description: "Probe",
      sourceUrl: "https://github.com/echo983/probe",
      imageVersion: null,
      imageRevision: null,
      imageLicenses: null,
      enabled: true,
      defaultInstanceIdHex: null,
      createdAtMs: 101,
      updatedAtMs: 101,
    });
    const ids = [0x20, 0x21, 0x22, 0x23].map((value) => Buffer.alloc(16, value));
    const result = await new BlankBwaInstanceCreator({
      repository,
      refStore: genesis.store,
      writerId: "bwa-test",
      now: () => 200,
      randomId: () => ids.shift()!,
    }).create({
      applicationId: "ghcr.io/echo983/probe",
      workspaceName: "Blank state",
      instanceName: "Blank state",
    });

    expect(result.workspace.workspaceIdHex).toBe("20".repeat(16));
    expect(result.instance.instanceIdHex).toBe("23".repeat(16));
    expect(
      genesis.store.getBwaApplication("ghcr.io/echo983/probe").defaultInstanceIdHex,
    ).toBe(result.instance.instanceIdHex);
    const index = await loadCurrentEntryIndex(
      repository,
      genesis.store,
      result.workspace.refId,
    );
    expect(index.listChildren(index.rootEntryIdHex)).toEqual([]);
    expect(index.rootEntryIdHex).toBe("22".repeat(16));
    genesis.store.close();
  });
});
