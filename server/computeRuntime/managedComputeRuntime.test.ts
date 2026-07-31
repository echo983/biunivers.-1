import { describe, expect, it, vi } from "vitest";
import type { SqliteRefStore } from "../files/sqliteRefStore.js";
import type { WorkspaceCommitCoordinator } from "../workspaceCommit/workspaceCommitCoordinator.js";
import type { ComputeRuntimeCoordinator } from "./computeRuntimeCoordinator.js";
import { ManagedComputeRuntime } from "./managedComputeRuntime.js";
import type { RunDirectoryManager } from "./runDirectoryManager.js";

const runIdHex = "11".repeat(16);
const workspaceIdHex = "22".repeat(16);
const headFidHex = "33".repeat(16);

describe("ManagedComputeRuntime", () => {
  it("synchronizes successful local start and stop with the control Run", async () => {
    const transitionWorkspaceRun = vi.fn();
    const runtime = {
      start: vi.fn().mockResolvedValue({
        state: "RUNNING",
        runtimeIdentity: "sha256:runtime",
      }),
      stop: vi.fn().mockResolvedValue({
        state: "STOPPED",
        runtimeIdentity: "sha256:runtime",
      }),
    };
    const managed = createManaged(runtime, {
      transitionWorkspaceRun,
    });

    await managed.start(runIdHex);
    await managed.stop(runIdHex);

    expect(transitionWorkspaceRun).toHaveBeenNthCalledWith(1, {
      runIdHex,
      expectedState: "PREPARING",
      newState: "RUNNING",
      runtimeIdentity: "sha256:runtime",
      timestampMs: 200,
    });
    expect(transitionWorkspaceRun).toHaveBeenNthCalledWith(2, {
      runIdHex,
      expectedState: "RUNNING",
      newState: "STOPPED",
      timestampMs: 200,
    });
  });

  it("derives the trusted Upper path for commit instead of accepting one from IPC", async () => {
    const commit = vi.fn().mockResolvedValue({ changed: true });
    const managed = createManaged(
      {},
      {},
      {
        inspect: vi.fn().mockResolvedValue({ state: "STOPPED" }),
        paths: vi.fn().mockReturnValue({
          upper: `/runtime/${runIdHex}/upper`,
        }),
      },
      { commit },
    );

    await expect(managed.commit(runIdHex)).resolves.toEqual({ changed: true });
    expect(commit).toHaveBeenCalledWith({
      runIdHex,
      upperPath: `/runtime/${runIdHex}/upper`,
    });
  });

  it("mirrors a control commit failure into the local manifest for Upper recovery", async () => {
    const transition = vi.fn().mockResolvedValue({ state: "FAILED" });
    const managed = createManaged(
      {},
      {},
      {
        inspect: vi.fn()
          .mockResolvedValueOnce({ state: "STOPPED" })
          .mockResolvedValueOnce({ state: "STOPPED" }),
        paths: vi.fn().mockReturnValue({ upper: `/runtime/${runIdHex}/upper` }),
        transition,
      },
      { commit: vi.fn().mockRejectedValue(new Error("commit failed")) },
    );

    await expect(managed.commit(runIdHex)).rejects.toThrow("commit failed");
    expect(transition).toHaveBeenCalledWith({
      runIdHex,
      expectedState: "STOPPED",
      newState: "FAILED",
      errorCode: "COW_COMMIT_FAILED",
    });
  });
});

function createManaged(
  runtimeOverride: Record<string, unknown> = {},
  refStoreOverride: Record<string, unknown> = {},
  directoryOverride: Record<string, unknown> = {},
  committerOverride: Record<string, unknown> = {},
): ManagedComputeRuntime {
  const runtime = {
    prepare: vi.fn(),
    start: vi.fn(),
    inspect: vi.fn(),
    freeze: vi.fn(),
    thaw: vi.fn(),
    stop: vi.fn(),
    destroy: vi.fn(),
    shutdown: vi.fn(),
    ...runtimeOverride,
  };
  const refStore = {
    getWorkspaceRun: vi.fn().mockReturnValue({
      runIdHex,
      workspaceIdHex,
      inputHeadFidHex: headFidHex,
      executorId: "system.diagnostic",
      state: "PREPARING",
    }),
    transitionWorkspaceRun: vi.fn(),
    ...refStoreOverride,
  };
  const directories = {
    inspect: vi.fn(),
    paths: vi.fn(),
    ...directoryOverride,
  };
  const committer = {
    commit: vi.fn(),
    ...committerOverride,
  };
  return new ManagedComputeRuntime({
    runtime: runtime as unknown as ComputeRuntimeCoordinator,
    directories: directories as unknown as RunDirectoryManager,
    refStore: refStore as unknown as SqliteRefStore,
    committer: committer as unknown as WorkspaceCommitCoordinator,
    images: {
      pullAndInspect: vi.fn(),
      inspectInstalled: vi.fn(),
    },
    now: () => 200,
  });
}
