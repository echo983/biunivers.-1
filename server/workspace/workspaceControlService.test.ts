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
  it("separates file-manager creation from Workspace management authority", async () => {
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
    const service = new WorkspaceControlService({
      repository: {} as ImmutableObjectRepository,
      refStore,
      capabilities,
      writerId: "test",
      deriver: { derive } as unknown as WorkspaceDeriver,
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
    expect(() => service.list(files.instanceToken)).toThrowError(
      expect.objectContaining({ code: "PERMISSION_DENIED" }),
    );
    expect(() => service.list(thirdParty.instanceToken)).toThrowError(
      expect.objectContaining({ code: "PERMISSION_DENIED" }),
    );
    refStore.close();
  });
});

function tokenSequence(): () => string {
  let value = 0;
  return () => String(value++).padStart(43, "a");
}
