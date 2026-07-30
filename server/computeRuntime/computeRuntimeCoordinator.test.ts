import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ComputeRuntimeCoordinator,
  type SnapshotProvisioner,
} from "./computeRuntimeCoordinator.js";
import { ExecutorRegistry, type ExecutorDefinition } from "./executorRegistry.js";
import { RunDirectoryManager } from "./runDirectoryManager.js";

const roots: string[] = [];
const runIdHex = "11".repeat(16);
const workspaceIdHex = "22".repeat(16);
const executor: ExecutorDefinition = {
  executorId: "system.diagnostic",
  image: `ghcr.io/echo983/diagnostic@sha256:${"33".repeat(32)}`,
  entrypoint: "/usr/local/bin/diagnostic",
  arguments: [],
  uid: 10001,
  gid: 10001,
  cpuLimit: 0.5,
  memoryBytes: 128 * 1024 * 1024,
  pidsLimit: 32,
  timeoutMs: 1000,
  upperBytesLimit: 1024 * 1024,
  upperInodesLimit: 1000,
  outputBytesLimit: 4096,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function setup(options: { failStart?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "biunivers-coordinator-"));
  roots.push(root);
  let now = 100;
  const directories = new RunDirectoryManager({
    root: join(root, "runs"),
    now: () => now++,
  });
  const events: string[] = [];
  const activeMounts = new Set<string>();
  const mounts = {
    async prepare(input: { runIdHex: string }) {
      events.push("mount:prepare");
      activeMounts.add(input.runIdHex);
      return { runIdHex: input.runIdHex, pvlogfsPid: 1, overlayPid: 2 };
    },
    inspect(id: string) {
      return activeMounts.has(id)
        ? { runIdHex: id, pvlogfsPid: 1, overlayPid: 2 }
        : undefined;
    },
    async cleanup(id: string) {
      events.push("mount:cleanup");
      activeMounts.delete(id);
    },
  };
  const snapshots: SnapshotProvisioner = {
    async provision(input) {
      events.push("snapshot:provision");
      await writeFile(join(input.paths.root, "snapshot.json"), "{}");
      await writeFile(join(input.paths.root, "gateway.sock"), "");
    },
    async release() {
      events.push("snapshot:release");
    },
  };
  let containerRunning = false;
  const oci = {
    async create() {
      events.push("oci:create");
      return "a".repeat(64);
    },
    async start() {
      events.push("oci:start");
      if (options.failStart) throw new Error("start failed");
      containerRunning = true;
    },
    async inspect() {
      events.push("oci:inspect");
      return {
        status: containerRunning ? "running" : "exited",
        running: containerRunning,
        paused: false,
        restarting: false,
        oomKilled: false,
        dead: false,
        pid: containerRunning ? 123 : 0,
        exitCode: 0,
        startedAt: "",
        finishedAt: "",
      };
    },
    async stop() {
      events.push("oci:stop");
      containerRunning = false;
    },
    async remove() {
      events.push("oci:remove");
      containerRunning = false;
    },
  };
  return {
    root,
    directories,
    events,
    coordinator: new ComputeRuntimeCoordinator({
      directories,
      executors: new ExecutorRegistry([executor]),
      mounts,
      snapshots,
      oci,
    }),
  };
}

describe("ComputeRuntimeCoordinator", () => {
  it("coordinates prepare, start, inspect, and stop while preserving Upper", async () => {
    const setupResult = await setup();
    const prepared = await setupResult.coordinator.prepare({
      runIdHex,
      workspaceIdHex,
      inputHeadFidHex: "44".repeat(16),
      revision: 0,
      executorId: executor.executorId,
      capabilityHex: "55".repeat(32),
    });
    expect(prepared.state).toBe("PREPARED");
    const upperFile = join(
      setupResult.directories.paths(runIdHex).upper,
      "result.txt",
    );
    await writeFile(upperFile, "preserve");

    const running = await setupResult.coordinator.start(runIdHex);
    expect(running).toMatchObject({
      state: "RUNNING",
      runtimeIdentity: "a".repeat(64),
    });
    expect(await setupResult.coordinator.inspect(runIdHex)).toMatchObject({
      manifest: { state: "RUNNING" },
      container: { running: true, pid: 123 },
    });
    const stopped = await setupResult.coordinator.stop(runIdHex);
    expect(stopped.state).toBe("STOPPED");
    expect(await readFile(upperFile, "utf8")).toBe("preserve");
    expect(setupResult.events).toEqual([
      "snapshot:provision",
      "mount:prepare",
      "oci:create",
      "oci:start",
      "oci:inspect",
      "oci:inspect",
      "oci:stop",
      "oci:remove",
      "mount:cleanup",
      "snapshot:release",
    ]);
  });

  it("marks a failed start, removes the container, cleans mounts, and preserves Upper", async () => {
    const setupResult = await setup({ failStart: true });
    await setupResult.coordinator.prepare({
      runIdHex,
      workspaceIdHex,
      inputHeadFidHex: "44".repeat(16),
      revision: 0,
      executorId: executor.executorId,
      capabilityHex: "55".repeat(32),
    });
    const upperFile = join(
      setupResult.directories.paths(runIdHex).upper,
      "partial.txt",
    );
    await writeFile(upperFile, "keep");
    await expect(setupResult.coordinator.start(runIdHex)).rejects.toThrow(
      "start failed",
    );
    expect(await setupResult.directories.inspect(runIdHex)).toMatchObject({
      state: "FAILED",
      errorCode: "START_FAILED",
    });
    expect(await readFile(upperFile, "utf8")).toBe("keep");
    expect(setupResult.events).toContain("oci:remove");
    expect(setupResult.events).toContain("mount:cleanup");
    expect(setupResult.events).toContain("snapshot:release");
  });

  it("cleans an active Run on daemon shutdown and preserves Upper", async () => {
    const setupResult = await setup();
    await setupResult.coordinator.prepare({
      runIdHex,
      workspaceIdHex,
      inputHeadFidHex: "44".repeat(16),
      revision: 0,
      executorId: executor.executorId,
      capabilityHex: "55".repeat(32),
    });
    await setupResult.coordinator.start(runIdHex);
    const upperFile = join(
      setupResult.directories.paths(runIdHex).upper,
      "shutdown-result.txt",
    );
    await writeFile(upperFile, "keep");

    await setupResult.coordinator.shutdown();

    expect(await setupResult.directories.inspect(runIdHex)).toMatchObject({
      state: "FAILED",
      errorCode: "DAEMON_SHUTDOWN",
    });
    expect(await readFile(upperFile, "utf8")).toBe("keep");
    expect(setupResult.events).toEqual([
      "snapshot:provision",
      "mount:prepare",
      "oci:create",
      "oci:start",
      "oci:stop",
      "oci:remove",
      "mount:cleanup",
      "snapshot:release",
    ]);
  });
});
