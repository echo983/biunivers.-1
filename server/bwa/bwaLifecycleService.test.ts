import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteRefStore, type CreateWorkspaceInput } from "../files/sqliteRefStore.js";
import { BwaLifecycleService } from "./bwaLifecycleService.js";

const roots: string[] = [];
const workspaceIdHex = "22".repeat(16);
const instanceIdHex = "33".repeat(16);
const runIdHex = "44".repeat(16);
const restartedRunIdHex = "45".repeat(16);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("BwaLifecycleService", () => {
  it("serializes start, normal stop, no-op commit, and cleanup", async () => {
    const source = await setup();
    const calls: string[] = [];
    const runtime = {
      prepareBwa: vi.fn(async (input) => {
        calls.push("prepare");
        expect(input.environment).toEqual({ MODE: "safe", TOKEN: "secret" });
      }),
      start: vi.fn(async (id) => {
        calls.push("start");
        source.store.transitionWorkspaceRun({
          runIdHex: id,
          expectedState: "PREPARING",
          newState: "RUNNING",
          runtimeIdentity: "container-test",
          timestampMs: source.tick(),
        });
      }),
      stop: vi.fn(async (id) => {
        calls.push("stop");
        source.store.transitionWorkspaceRun({
          runIdHex: id,
          expectedState: "RUNNING",
          newState: "STOPPED",
          timestampMs: source.tick(),
        });
      }),
      commit: vi.fn(async (id) => {
        calls.push("commit");
        source.store.transitionWorkspaceRun({
          runIdHex: id,
          expectedState: "STOPPED",
          newState: "COMMITTING",
          timestampMs: source.tick(),
        });
        const ref = source.store.getRef(`ws-${workspaceIdHex}`);
        source.store.completeUnchangedWorkspaceRun({
          runIdHex: id,
          expectedHeadFidHex: ref.headFidHex,
          expectedRevision: ref.revision,
          timestampMs: source.tick(),
        });
      }),
      destroy: vi.fn(async () => calls.push("destroy")),
    };
    const lifecycle = new BwaLifecycleService({
      refStore: source.store,
      environment: {
        resolveEnvironment: vi.fn().mockResolvedValue({ MODE: "safe", TOKEN: "secret" }),
      },
      runtime,
      now: source.tick,
      randomId: (bytes) =>
        bytes === 16 ? Buffer.from(runIdHex, "hex") : Buffer.alloc(bytes, 0x55),
    });

    expect(await lifecycle.start(instanceIdHex)).toMatchObject({
      runIdHex,
      state: "RUNNING",
    });
    expect(source.store.getBwaRunBinding(runIdHex).executorDigest).toBe(
      `sha256:${"a".repeat(64)}`,
    );
    expect(await lifecycle.stop(instanceIdHex)).toMatchObject({
      runIdHex,
      state: "COMMITTED",
    });
    expect(source.store.getBwaInstance(instanceIdHex).desiredState).toBe("STOPPED");
    expect(source.store.getWorkspace(workspaceIdHex).activeWriteRunIdHex).toBeNull();
    expect(calls).toEqual(["prepare", "start", "stop", "commit", "destroy"]);
    source.store.close();
  });

  it("fails closed, preserves the unresolved Run, and releases its write lease", async () => {
    const source = await setup();
    const lifecycle = new BwaLifecycleService({
      refStore: source.store,
      environment: { resolveEnvironment: vi.fn().mockResolvedValue({ TOKEN: "secret" }) },
      runtime: {
        prepareBwa: vi.fn().mockResolvedValue(undefined),
        start: vi.fn().mockRejectedValue(new Error("start failed")),
        stop: vi.fn(),
        commit: vi.fn(),
        destroy: vi.fn().mockResolvedValue(undefined),
      },
      now: source.tick,
      randomId: (bytes) =>
        bytes === 16 ? Buffer.from(runIdHex, "hex") : Buffer.alloc(bytes, 0x55),
    });

    await expect(lifecycle.start(instanceIdHex)).rejects.toMatchObject({
      code: "RUNTIME_START_FAILED",
    });
    expect(source.store.getWorkspaceRun(runIdHex)).toMatchObject({
      state: "FAILED",
      errorCode: "BWA_START_FAILED",
    });
    expect(source.store.getWorkspace(workspaceIdHex).activeWriteRunIdHex).toBeNull();
    expect(source.store.getBwaInstance(instanceIdHex).desiredState).toBe("STOPPED");
    await expect(lifecycle.start(instanceIdHex)).rejects.toMatchObject({
      code: "INSTANCE_RUN_BLOCKED",
    });
    source.store.close();
  });

  it("keeps an abnormal exited Upper blocked until it is explicitly discarded", async () => {
    const source = await setup();
    const runtime = runtimeForStartedRun(source, {
      finalizeExited: async (id: string) => {
        source.store.transitionWorkspaceRun({
          runIdHex: id,
          expectedState: "RUNNING",
          newState: "FAILED",
          errorCode: "CONTAINER_EXIT_FAILED",
          timestampMs: source.tick(),
        });
      },
    });
    const lifecycle = lifecycleFor(source, runtime);

    await lifecycle.start(instanceIdHex);
    expect(await lifecycle.finalizeExited(instanceIdHex)).toMatchObject({
      state: "FAILED",
      errorCode: "CONTAINER_EXIT_FAILED",
    });
    await expect(lifecycle.start(instanceIdHex)).rejects.toMatchObject({
      code: "INSTANCE_RUN_BLOCKED",
    });
    expect(await lifecycle.discardFailedUpper(instanceIdHex, runIdHex)).toMatchObject({
      state: "DISCARDED",
    });
    expect(runtime.destroy).toHaveBeenCalledWith(runIdHex, false);
    source.store.close();
  });

  it("reacquires the lease and publishes an explicitly accepted failed Upper", async () => {
    const source = await setup();
    const runtime = runtimeForStartedRun(source, {
      finalizeExited: async (id: string) => {
        source.store.transitionWorkspaceRun({
          runIdHex: id,
          expectedState: "RUNNING",
          newState: "FAILED",
          errorCode: "CONTAINER_EXIT_FAILED",
          timestampMs: source.tick(),
        });
      },
      commit: async (id: string) => {
        source.store.transitionWorkspaceRun({
          runIdHex: id,
          expectedState: "STOPPED",
          newState: "COMMITTING",
          timestampMs: source.tick(),
        });
        const ref = source.store.getRef(`ws-${workspaceIdHex}`);
        source.store.completeUnchangedWorkspaceRun({
          runIdHex: id,
          expectedHeadFidHex: ref.headFidHex,
          expectedRevision: ref.revision,
          timestampMs: source.tick(),
        });
      },
    });
    const lifecycle = lifecycleFor(source, runtime);

    await lifecycle.start(instanceIdHex);
    await lifecycle.finalizeExited(instanceIdHex);
    expect(await lifecycle.publishFailedUpper(instanceIdHex, runIdHex)).toMatchObject({
      state: "COMMITTED",
    });
    expect(source.store.getWorkspace(workspaceIdHex).activeWriteRunIdHex).toBeNull();
    expect(runtime.reopenFailed).toHaveBeenCalledWith(runIdHex);
    source.store.close();
  });

  it("commits and rebuilds a save-restart under one lifecycle lock", async () => {
    const source = await setup();
    const calls: string[] = [];
    const runtime = {
      prepareBwa: vi.fn(async ({ runIdHex: id }) => calls.push(`prepare:${id}`)),
      start: vi.fn(async (id: string) => {
        calls.push(`start:${id}`);
        source.store.transitionWorkspaceRun({
          runIdHex: id,
          expectedState: "PREPARING",
          newState: "RUNNING",
          runtimeIdentity: `container-${id}`,
          timestampMs: source.tick(),
        });
      }),
      stop: vi.fn(async (id: string) => {
        calls.push(`stop:${id}`);
        source.store.transitionWorkspaceRun({
          runIdHex: id,
          expectedState: "RUNNING",
          newState: "STOPPED",
          timestampMs: source.tick(),
        });
      }),
      commit: vi.fn(async (id: string) => {
        calls.push(`commit:${id}`);
        source.store.transitionWorkspaceRun({
          runIdHex: id,
          expectedState: "STOPPED",
          newState: "COMMITTING",
          timestampMs: source.tick(),
        });
        const ref = source.store.getRef(`ws-${workspaceIdHex}`);
        source.store.completeUnchangedWorkspaceRun({
          runIdHex: id,
          expectedHeadFidHex: ref.headFidHex,
          expectedRevision: ref.revision,
          timestampMs: source.tick(),
        });
      }),
      destroy: vi.fn(async (id: string) => calls.push(`destroy:${id}`)),
      finalizeExited: vi.fn(),
      reopenFailed: vi.fn(),
    };
    const runIds = [runIdHex, restartedRunIdHex];
    const lifecycle = new BwaLifecycleService({
      refStore: source.store,
      environment: { resolveEnvironment: vi.fn().mockResolvedValue({}) },
      runtime,
      now: source.tick,
      randomId: (bytes) =>
        bytes === 16
          ? Buffer.from(runIds.shift() ?? "00".repeat(16), "hex")
          : Buffer.alloc(bytes, 0x55),
    });

    await lifecycle.start(instanceIdHex);
    expect(await lifecycle.saveAndRestart(instanceIdHex)).toMatchObject({
      runIdHex: restartedRunIdHex,
      state: "RUNNING",
    });
    expect(source.store.getWorkspaceRun(runIdHex).state).toBe("COMMITTED");
    expect(source.store.getBwaRunBinding(runIdHex).stopReason).toBe("SAVE_RESTART");
    expect(source.store.getBwaInstance(instanceIdHex).desiredState).toBe("RUNNING");
    expect(calls).toEqual([
      `prepare:${runIdHex}`,
      `start:${runIdHex}`,
      `stop:${runIdHex}`,
      `commit:${runIdHex}`,
      `destroy:${runIdHex}`,
      `prepare:${restartedRunIdHex}`,
      `start:${restartedRunIdHex}`,
    ]);
    source.store.close();
  });

  it("keeps the committed Head and RUNNING intent when restart startup fails", async () => {
    const source = await setup();
    const runIds = [runIdHex, restartedRunIdHex];
    const runtime = runtimeForStartedRun(source, {
      stop: async (id: string) => {
        source.store.transitionWorkspaceRun({
          runIdHex: id,
          expectedState: "RUNNING",
          newState: "STOPPED",
          timestampMs: source.tick(),
        });
      },
      commit: async (id: string) => {
        source.store.transitionWorkspaceRun({
          runIdHex: id,
          expectedState: "STOPPED",
          newState: "COMMITTING",
          timestampMs: source.tick(),
        });
        const ref = source.store.getRef(`ws-${workspaceIdHex}`);
        source.store.completeUnchangedWorkspaceRun({
          runIdHex: id,
          expectedHeadFidHex: ref.headFidHex,
          expectedRevision: ref.revision,
          timestampMs: source.tick(),
        });
      },
      start: async (id: string) => {
        if (id === restartedRunIdHex) throw new Error("restart failed");
        source.store.transitionWorkspaceRun({
          runIdHex: id,
          expectedState: "PREPARING",
          newState: "RUNNING",
          runtimeIdentity: "container-test",
          timestampMs: source.tick(),
        });
      },
    });
    const lifecycle = new BwaLifecycleService({
      refStore: source.store,
      environment: { resolveEnvironment: vi.fn().mockResolvedValue({}) },
      runtime,
      now: source.tick,
      randomId: (bytes) =>
        bytes === 16
          ? Buffer.from(runIds.shift() ?? "00".repeat(16), "hex")
          : Buffer.alloc(bytes, 0x55),
    });

    await lifecycle.start(instanceIdHex);
    await expect(lifecycle.saveAndRestart(instanceIdHex)).rejects.toMatchObject({
      code: "RUNTIME_START_FAILED",
    });
    expect(source.store.getWorkspaceRun(runIdHex).state).toBe("COMMITTED");
    expect(source.store.getWorkspaceRun(restartedRunIdHex)).toMatchObject({
      state: "FAILED",
      errorCode: "BWA_START_FAILED",
    });
    expect(source.store.getBwaInstance(instanceIdHex).desiredState).toBe("RUNNING");
    source.store.close();
  });
});

function lifecycleFor(source: Awaited<ReturnType<typeof setup>>, runtime: ReturnType<typeof runtimeForStartedRun>) {
  return new BwaLifecycleService({
    refStore: source.store,
    environment: { resolveEnvironment: vi.fn().mockResolvedValue({}) },
    runtime,
    now: source.tick,
    randomId: (bytes) =>
      bytes === 16 ? Buffer.from(runIdHex, "hex") : Buffer.alloc(bytes, 0x55),
  });
}

function runtimeForStartedRun(
  source: Awaited<ReturnType<typeof setup>>,
  overrides: Record<string, (id: string) => Promise<unknown>>,
) {
  return {
    prepareBwa: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(async (id: string) => {
      source.store.transitionWorkspaceRun({
        runIdHex: id,
        expectedState: "PREPARING",
        newState: "RUNNING",
        runtimeIdentity: "container-test",
        timestampMs: source.tick(),
      });
    }),
    stop: vi.fn(),
    finalizeExited: vi.fn(),
    reopenFailed: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn(),
    destroy: vi.fn().mockResolvedValue(undefined),
    ...Object.fromEntries(
      Object.entries(overrides).map(([name, implementation]) => [name, vi.fn(implementation)]),
    ),
  };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "biunivers-bwa-lifecycle-"));
  roots.push(root);
  const store = await SqliteRefStore.initialize(join(root, "refstore.sqlite"));
  let timestamp = 200;
  const tick = () => timestamp++;
  const main = {
    refId: "main",
    lineageIdHex: "10".repeat(16),
    headFidHex: "11".repeat(16),
    revision: 0,
    updatedAtMs: 100,
  };
  store.createRef(main);
  const workspace: CreateWorkspaceInput = {
    workspaceIdHex,
    refId: `ws-${workspaceIdHex}`,
    name: "Lifecycle workspace",
    sourceRefId: "main",
    sourceHeadFidHex: main.headFidHex,
    baselineHeadFidHex: "21".repeat(16),
    state: "READY",
    retention: "KEPT",
    activeWriteRunIdHex: null,
    createdAtMs: 101,
    updatedAtMs: 101,
    ref: {
      refId: `ws-${workspaceIdHex}`,
      lineageIdHex: "20".repeat(16),
      headFidHex: "21".repeat(16),
      revision: 0,
      updatedAtMs: 101,
    },
  };
  store.createWorkspace(workspace);
  store.createBwaApplication({
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
    createdAtMs: 102,
    updatedAtMs: 102,
  });
  store.createBwaInstance({
    instanceIdHex,
    applicationId: "ghcr.io/echo983/probe",
    workspaceIdHex,
    desiredState: "STOPPED",
    startupPolicy: "MANUAL",
    displayName: "Probe state",
    createdAtMs: 103,
    updatedAtMs: 103,
  });
  return { store, tick };
}
