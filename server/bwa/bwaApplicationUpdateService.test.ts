import { describe, expect, it, vi } from "vitest";
import type { BwaApplicationRecord, SqliteRefStore } from "../files/sqliteRefStore.js";
import { BwaApplicationUpdateService } from "./bwaApplicationUpdateService.js";

const applicationId = "ghcr.io/echo983/probe";
const first = "11".repeat(16);
const second = "22".repeat(16);

describe("BwaApplicationUpdateService", () => {
  it("stops every running Instance, swaps one digest, then restarts them", async () => {
    const events: string[] = [];
    const application = record();
    const service = new BwaApplicationUpdateService({
      refStore: storeWithRunningInstances(),
      lifecycle: {
        stop: vi.fn(async (id) => events.push(`stop:${id}`)) as never,
        start: vi.fn(async (id) => events.push(`start:${id}`)) as never,
      },
      registry: {
        update: vi.fn(async () => {
          events.push("update");
          return application;
        }),
        rollback: vi.fn(),
      },
    });

    await expect(service.update(applicationId, `${applicationId}:next`)).resolves.toBe(application);
    expect(events).toEqual([
      `stop:${first}`,
      `stop:${second}`,
      "update",
      `start:${first}`,
      `start:${second}`,
    ]);
  });

  it("does not swap the digest when one Instance cannot stop", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn();
    const service = new BwaApplicationUpdateService({
      refStore: storeWithRunningInstances(),
      lifecycle: {
        stop: vi.fn(async (id) => {
          if (id === second) throw new Error("stop failed");
        }) as never,
        start: start as never,
      },
      registry: { update, rollback: vi.fn() },
    });

    await expect(service.update(applicationId, `${applicationId}:next`)).rejects.toMatchObject({
      code: "INSTANCE_STOP_FAILED",
    });
    expect(update).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledExactlyOnceWith(first);
  });
});

function storeWithRunningInstances(): SqliteRefStore {
  return {
    listBwaInstances: vi.fn().mockReturnValue([
      { instanceIdHex: first },
      { instanceIdHex: second },
    ]),
    listBwaRunBindings: vi.fn().mockReturnValue([{ run: { state: "RUNNING" } }]),
  } as unknown as SqliteRefStore;
}

function record(): BwaApplicationRecord {
  return {
    applicationId,
    installedDigest: `sha256:${"b".repeat(64)}`,
    previousDigest: `sha256:${"a".repeat(64)}`,
    protocolVersion: 1,
    title: "Probe",
    description: "Probe",
    sourceUrl: "https://github.com/echo983/probe",
    imageVersion: "2",
    imageRevision: null,
    imageLicenses: null,
    enabled: true,
    defaultInstanceIdHex: first,
    createdAtMs: 1,
    updatedAtMs: 2,
  };
}
