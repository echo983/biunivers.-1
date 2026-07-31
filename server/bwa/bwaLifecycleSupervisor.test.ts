import { describe, expect, it, vi } from "vitest";
import type { SqliteRefStore } from "../files/sqliteRefStore.js";
import { BwaLifecycleSupervisor } from "./bwaLifecycleSupervisor.js";

const instanceIdHex = "11".repeat(16);
const runIdHex = "22".repeat(16);

describe("BwaLifecycleSupervisor", () => {
  it("finalizes a database-active BWA exactly when its container has exited", async () => {
    const finalizeExited = vi.fn().mockResolvedValue(undefined);
    const inspect = vi.fn().mockResolvedValue({
      manifest: { state: "RUNNING" },
      container: { running: false, restarting: false },
    });
    const supervisor = new BwaLifecycleSupervisor({
      refStore: activeStore(),
      runtime: { inspect },
      lifecycle: { finalizeExited },
    });

    await expect(supervisor.reconcileOnce()).resolves.toMatchObject({
      inspected: [runIdHex],
      finalized: [runIdHex],
      failed: [],
    });
    expect(finalizeExited).toHaveBeenCalledExactlyOnceWith(instanceIdHex);
  });

  it("does not finalize a running or restarting container", async () => {
    const finalizeExited = vi.fn();
    const supervisor = new BwaLifecycleSupervisor({
      refStore: activeStore(),
      runtime: {
        inspect: vi.fn().mockResolvedValue({
          container: { running: false, restarting: true },
        }),
      },
      lifecycle: { finalizeExited },
    });

    expect((await supervisor.reconcileOnce()).finalized).toEqual([]);
    expect(finalizeExited).not.toHaveBeenCalled();
  });
});

function activeStore(): SqliteRefStore {
  return {
    listBwaApplications: vi.fn().mockReturnValue([{ applicationId: "ghcr.io/echo983/probe" }]),
    listBwaInstances: vi.fn().mockReturnValue([{ instanceIdHex }]),
    listBwaRunBindings: vi.fn().mockReturnValue([{ run: { runIdHex, state: "RUNNING" } }]),
  } as unknown as SqliteRefStore;
}
