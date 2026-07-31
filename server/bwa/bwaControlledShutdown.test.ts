import { describe, expect, it, vi } from "vitest";
import type { SqliteRefStore } from "../files/sqliteRefStore.js";
import { BwaControlledShutdown } from "./bwaControlledShutdown.js";

const runningId = "11".repeat(16);
const stoppedId = "22".repeat(16);

describe("BwaControlledShutdown", () => {
  it("commits only running Instances with HOST_SHUTDOWN intent", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const shutdown = new BwaControlledShutdown({
      refStore: store(),
      lifecycle: { stop },
    });

    await expect(shutdown.shutdown()).resolves.toEqual({
      committed: [runningId],
      failed: [],
    });
    expect(stop).toHaveBeenCalledExactlyOnceWith(runningId, "HOST_SHUTDOWN");
  });

  it("continues after one Instance fails and reports its preserved failure", async () => {
    const failure = new Error("commit failed");
    const shutdown = new BwaControlledShutdown({
      refStore: store(),
      lifecycle: { stop: vi.fn().mockRejectedValue(failure) },
    });

    const report = await shutdown.shutdown();
    expect(report.committed).toEqual([]);
    expect(report.failed).toEqual([{ instanceIdHex: runningId, error: failure }]);
  });
});

function store(): SqliteRefStore {
  return {
    listBwaApplications: vi.fn().mockReturnValue([{ applicationId: "ghcr.io/echo983/probe" }]),
    listBwaInstances: vi.fn().mockReturnValue([
      { instanceIdHex: runningId },
      { instanceIdHex: stoppedId },
    ]),
    listBwaRunBindings: vi.fn((id: string) => [
      { run: { state: id === runningId ? "RUNNING" : "COMMITTED" } },
    ]),
  } as unknown as SqliteRefStore;
}
