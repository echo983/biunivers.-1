import { describe, expect, it, vi } from "vitest";
import type { SqliteRefStore } from "../files/sqliteRefStore.js";
import { BwaBrowserSessionRegistry } from "./bwaBrowserSessionRegistry.js";
import type { BwaLifecycleService } from "./bwaLifecycleService.js";
import { BwaManagerControlService } from "./bwaManagerControlService.js";
import type { BwaRegistryService } from "./bwaRegistryService.js";
import type { BwaApplicationUpdateService } from "./bwaApplicationUpdateService.js";

const instanceIdHex = "11".repeat(16);

describe("BwaManagerControlService", () => {
  it("projects management state and issues a short-lived open URL only for a running Instance", async () => {
    const runState = { value: "STOPPED" };
    const refStore = {
      listWorkspaces: vi.fn().mockReturnValue([]),
      getRef: vi.fn(),
      listBwaApplications: vi.fn().mockReturnValue([
        { applicationId: "ghcr.io/example/probe", enabled: true },
      ]),
      listBwaInstances: vi.fn().mockReturnValue([
        { instanceIdHex, applicationId: "ghcr.io/example/probe" },
      ]),
      getBwaInstance: vi.fn().mockReturnValue({
        instanceIdHex,
        applicationId: "ghcr.io/example/probe",
      }),
      listBwaEnvironment: vi.fn().mockReturnValue([
        { name: "TOKEN", value: null, sensitive: true },
      ]),
      listBwaRunBindings: vi.fn(() => [
        { run: { runIdHex: "22".repeat(16), state: runState.value } },
      ]),
    } as unknown as SqliteRefStore;
    const sessions = new BwaBrowserSessionRegistry({
      now: () => 1_000,
      random: (bytes) => Buffer.alloc(bytes, 9),
    });
    const runtime = {
      resolveBwaEndpoint: vi.fn().mockResolvedValue({
        address: "172.30.0.8",
        port: 8080,
      }),
    };
    const fetchHealth = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const service = new BwaManagerControlService({
      appOrigin: "http://localhost:8081",
      refStore,
      registry: {} as BwaRegistryService,
      lifecycle: {} as BwaLifecycleService,
      sessions,
      updates: {} as BwaApplicationUpdateService,
      runtime,
      fetch: fetchHealth,
    });
    expect(service.status()).toMatchObject({
      applications: [
        {
          instances: [
            { environment: [{ name: "TOKEN", value: null, sensitive: true }] },
          ],
        },
      ],
    });
    expect(() => service.open(instanceIdHex)).toThrowError(
      expect.objectContaining({ code: "INSTANCE_NOT_RUNNING" }),
    );
    runState.value = "RUNNING";
    const opened = service.open(instanceIdHex);
    const url = new URL(opened.url);
    expect(url.hostname).toMatch(/^bwa-[0-9a-f]{40}\.localhost$/);
    expect(url.pathname).toBe("/__biunivers/bootstrap");
    expect(url.searchParams.get("t")).toBeTruthy();
    expect(opened).not.toHaveProperty("workspaceIdHex");
    expect(opened).not.toHaveProperty("endpoint");
    await expect(service.waitUntilReady(instanceIdHex)).resolves.toEqual({ ready: true });
    expect(runtime.resolveBwaEndpoint).toHaveBeenCalledWith("22".repeat(16));
    expect(fetchHealth).toHaveBeenCalledWith(
      "http://172.30.0.8:8080/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
