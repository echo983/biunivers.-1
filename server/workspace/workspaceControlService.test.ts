import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileCapabilityRegistry } from "../files/fileCapabilityRegistry.js";
import { SqliteRefStore } from "../files/sqliteRefStore.js";
import type { ImmutableObjectRepository } from "../files/immutableObjectRepository.js";
import type { WorkspaceDeriver } from "./workspaceDeriver.js";
import { WorkspaceControlService } from "./workspaceControlService.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("WorkspaceControlService", () => {
  it("allows file-manager creation and content import without granting Workspace administration", async () => {
    const root = await mkdtemp(join(tmpdir(), "biunivers-workspace-control-"));
    roots.push(root);
    const refStore = await SqliteRefStore.initialize(join(root, "refs.sqlite"));
    const capabilities = new FileCapabilityRegistry({
      randomToken: tokenSequence(),
    });
    const files = capabilities.createInstance("system.files", "files-window");
    const workspaces = capabilities.createInstance(
      "system.workspaces",
      "workspace-window",
    );
    const thirdParty = capabilities.createInstance(
      "io.github.example.app",
      "third-party-window",
    );
    const derive = vi.fn().mockResolvedValue({
      workspace: {
        workspaceIdHex: "11".repeat(16),
        refId: `ws-${"11".repeat(16)}`,
        name: "Project",
        sourceRefId: "main",
        sourceHeadFidHex: "22".repeat(16),
        baselineHeadFidHex: "33".repeat(16),
        state: "READY",
        retention: "TEMPORARY",
        activeWriteRunIdHex: null,
        createdAtMs: 1,
        updatedAtMs: 1,
      },
      rootEntryIdHex: "44".repeat(16),
      checkpointFidHex: "55".repeat(16),
      entryCount: 2,
    });
    const compare = vi.fn().mockResolvedValue({
      workspaceIdHex: "11".repeat(16),
      changes: [],
    });
    const compareText = vi.fn().mockResolvedValue({
      available: true,
      path: "notes.txt",
      unifiedDiff: "--- baseline/notes.txt\n",
    });
    const executeImport = vi.fn().mockResolvedValue({
      revision: 4,
      roots: [],
    });
    const addFromMain = vi.fn().mockResolvedValue({ revision: 5, roots: [] });
    const service = new WorkspaceControlService({
      repository: {} as ImmutableObjectRepository,
      refStore,
      capabilities,
      writerId: "test",
      deriver: { derive } as unknown as WorkspaceDeriver,
      diff: { compare },
      textDiff: { compare: compareText },
      importer: { execute: executeImport },
      contentImporter: { execute: addFromMain },
    });

    const created = await service.create(files.instanceToken, {
      name: "Project",
      selectedEntryIds: ["66".repeat(16)],
    });
    expect(created.workspace.revision).toBe(0);
    expect(derive).toHaveBeenCalledOnce();
    await expect(
      service.create(workspaces.instanceToken, {
        name: "Denied",
        selectedEntryIds: ["66".repeat(16)],
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(service.list(workspaces.instanceToken)).toEqual([]);
    expect(service.list(files.instanceToken)).toEqual([]);
    expect(() => service.list(thirdParty.instanceToken)).toThrowError(
      expect.objectContaining({ code: "PERMISSION_DENIED" }),
    );
    await expect(
      service.diff(workspaces.instanceToken, "11".repeat(16)),
    ).resolves.toMatchObject({ changes: [] });
    expect(compare).toHaveBeenCalledWith("11".repeat(16));
    await expect(
      service.diff(thirdParty.instanceToken, "11".repeat(16)),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      service.textDiff(
        workspaces.instanceToken,
        "11".repeat(16),
        "notes.txt",
      ),
    ).resolves.toMatchObject({ available: true });
    expect(compareText).toHaveBeenCalledWith("11".repeat(16), "notes.txt");
    await expect(
      service.textDiff(
        thirdParty.instanceToken,
        "11".repeat(16),
        "notes.txt",
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    const importInput = {
      workspaceIdHex: "11".repeat(16),
      selectedEntryIdsHex: ["66".repeat(16)],
      destinationEntryIdHex: "77".repeat(16),
      workspaceRevision: 2,
      mainRevision: 3,
      conflictPolicy: "rename" as const,
    };
    await expect(
      service.importToMain(workspaces.instanceToken, importInput),
    ).resolves.toMatchObject({ revision: 4 });
    expect(executeImport).toHaveBeenCalledWith(importInput);
    await expect(
      service.importToMain(thirdParty.instanceToken, importInput),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    const contentInput = {
      workspaceIdHex: "11".repeat(16),
      selectedEntryIdsHex: ["66".repeat(16)],
      destinationEntryIdHex: "77".repeat(16),
      workspaceRevision: 4,
      mainRevision: 3,
    };
    await expect(service.addFromMain(files.instanceToken, contentInput)).resolves.toMatchObject({ revision: 5 });
    expect(addFromMain).toHaveBeenCalledWith(contentInput);
    await expect(service.addFromMain(thirdParty.instanceToken, contentInput)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    refStore.close();
  });
});

function tokenSequence(): () => string {
  let value = 0;
  return () => String(value++).padStart(43, "a");
}
