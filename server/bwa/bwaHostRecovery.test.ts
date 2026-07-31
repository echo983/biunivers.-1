import { describe, expect, it, vi } from "vitest";
import type { SqliteRefStore } from "../files/sqliteRefStore.js";
import type { RunDirectoryManager } from "../computeRuntime/runDirectoryManager.js";
import { BwaHostRecovery } from "./bwaHostRecovery.js";

const instanceIdHex = "11".repeat(16);
const runIdHex = "22".repeat(16);

describe("BwaHostRecovery", () => {
  it("turns an interrupted pre-commit STOPPED BWA into a preserved failure", async () => {
    const transitionWorkspaceRun = vi.fn();
    const setBwaInstanceDesiredState = vi.fn();
    const localTransition = vi.fn().mockResolvedValue(undefined);
    const refStore = {
      listBwaApplications: vi.fn().mockReturnValue([{ applicationId: "ghcr.io/echo983/probe" }]),
      listBwaInstances: vi.fn().mockReturnValue([{ instanceIdHex, desiredState: "RUNNING" }]),
      listBwaRunBindings: vi.fn().mockReturnValue([{ run: { runIdHex, state: "STOPPED" } }]),
      transitionWorkspaceRun,
      setBwaInstanceDesiredState,
    } as unknown as SqliteRefStore;
    const directories = {
      inspect: vi.fn().mockResolvedValue({ state: "STOPPED" }),
      transition: localTransition,
    } as unknown as RunDirectoryManager;

    await expect(
      new BwaHostRecovery({ now: () => 500 }).reconcile(directories, refStore),
    ).resolves.toEqual({ failed: [runIdHex], stoppedInstances: [instanceIdHex] });
    expect(localTransition).toHaveBeenCalledWith({
      runIdHex,
      expectedState: "STOPPED",
      newState: "FAILED",
      errorCode: "INTERRUPTED_BWA_FINALIZE",
    });
    expect(transitionWorkspaceRun).toHaveBeenCalledWith({
      runIdHex,
      expectedState: "STOPPED",
      newState: "FAILED",
      errorCode: "INTERRUPTED_BWA_FINALIZE",
      timestampMs: 500,
    });
    expect(setBwaInstanceDesiredState).toHaveBeenCalledWith(instanceIdHex, "STOPPED", 500);
  });
});
