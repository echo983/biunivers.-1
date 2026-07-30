import { describe, expect, it } from "vitest";
import {
  MountSupervisor,
  type CommandLauncher,
  type ManagedProcess,
  type MountController,
} from "./mountSupervisor.js";
import type { RunPaths } from "./runDirectoryManager.js";

const runIdHex = "11".repeat(16);
const root = `/run/biunivers/workspaces/${runIdHex}`;
const paths: RunPaths = {
  root,
  lower: `${root}/lower`,
  upper: `${root}/upper`,
  work: `${root}/work`,
  merged: `${root}/merged`,
  manifest: `${root}/runtime.json`,
};

class FakeProcess implements ManagedProcess {
  readonly exited: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  readonly signals: NodeJS.Signals[] = [];
  #resolve!: (value: {
    code: number | null;
    signal: NodeJS.Signals | null;
  }) => void;

  constructor(
    readonly pid: number,
    private readonly log: string[],
    private readonly label: string,
  ) {
    this.exited = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  terminate(signal: NodeJS.Signals): void {
    this.signals.push(signal);
    this.log.push(`stop:${this.label}:${signal}`);
    this.#resolve({ code: null, signal });
  }
}

class FakeMounts implements MountController {
  readonly mounted = new Set<string>();
  readonly log: string[] = [];

  async isMounted(path: string): Promise<boolean> {
    return this.mounted.has(path);
  }

  async makeWorkspaceWritable(path: string): Promise<void> {
    this.log.push(
      `writable:${path.endsWith("/merged") ? "merged" : path.endsWith("/upper") ? "upper" : "other"}`,
    );
  }

  async unmount(path: string): Promise<void> {
    this.log.push(`unmount:${path.endsWith("/merged") ? "merged" : "lower"}`);
    this.mounted.delete(path);
  }
}

function fakeLauncher(
  mounts: FakeMounts,
  options: { failOverlay?: boolean } = {},
): { launcher: CommandLauncher; calls: Array<[string, readonly string[]]> } {
  const calls: Array<[string, readonly string[]]> = [];
  let pid = 100;
  return {
    calls,
    launcher: {
      start(executable, arguments_) {
        calls.push([executable, arguments_]);
        const overlay = executable.endsWith("fuse-overlayfs");
        if (!overlay) mounts.mounted.add(paths.lower);
        if (overlay && !options.failOverlay) mounts.mounted.add(paths.merged);
        return new FakeProcess(
          pid++,
          mounts.log,
          overlay ? "overlay" : "pvlogfs",
        );
      },
    },
  };
}

describe("MountSupervisor", () => {
  it("mounts PVLogFS before fuse-overlayfs and cleans up in the frozen order", async () => {
    const mounts = new FakeMounts();
    const { launcher, calls } = fakeLauncher(mounts);
    const supervisor = new MountSupervisor({
      pvlogfsBinary: "/opt/biunivers/bin/biunivers-pvlogfs",
      overlayBinary: "/usr/bin/fuse-overlayfs",
      launcher,
      mounts,
      pollIntervalMs: 1,
      mountTimeoutMs: 20,
    });
    const mounted = await supervisor.prepare({
      runIdHex,
      paths,
      capabilityHex: "22".repeat(32),
    });
    expect(mounted).toEqual({
      runIdHex,
      pvlogfsPid: 100,
      overlayPid: 101,
    });
    expect(calls[0]).toEqual([
      "/opt/biunivers/bin/biunivers-pvlogfs",
      [
        "--allow-other",
        `${root}/snapshot.json`,
        `${root}/gateway.sock`,
        "22".repeat(32),
        paths.lower,
      ],
    ]);
    expect(calls[1]).toEqual([
      "/usr/bin/fuse-overlayfs",
      [
        "-f",
        "-o",
        `lowerdir=${paths.lower},upperdir=${paths.upper},workdir=${paths.work},allow_other,squash_to_uid=65532,squash_to_gid=65532`,
        paths.merged,
      ],
    ]);

    await supervisor.cleanup(runIdHex);
    expect(mounts.log).toEqual([
      "writable:upper",
      "unmount:merged",
      "stop:overlay:SIGTERM",
      "unmount:lower",
      "stop:pvlogfs:SIGTERM",
    ]);
    expect(supervisor.inspect(runIdHex)).toBeUndefined();
  });

  it("rolls back a partial stack without deleting Upper when overlay readiness fails", async () => {
    const mounts = new FakeMounts();
    const { launcher } = fakeLauncher(mounts, { failOverlay: true });
    const supervisor = new MountSupervisor({
      pvlogfsBinary: "/opt/biunivers/bin/biunivers-pvlogfs",
      launcher,
      mounts,
      pollIntervalMs: 1,
      mountTimeoutMs: 5,
    });
    await expect(
      supervisor.prepare({
        runIdHex,
        paths,
        capabilityHex: "22".repeat(32),
      }),
    ).rejects.toMatchObject({ code: "MOUNT_START_FAILED" });
    expect(mounts.log).toEqual([
      "writable:upper",
      "stop:overlay:SIGTERM",
      "unmount:lower",
      "stop:pvlogfs:SIGTERM",
    ]);
    expect(supervisor.inspect(runIdHex)).toBeUndefined();
  });

  it("rejects capabilities and paths outside the fixed Run layout", async () => {
    const mounts = new FakeMounts();
    const { launcher } = fakeLauncher(mounts);
    const supervisor = new MountSupervisor({
      pvlogfsBinary: "/opt/biunivers/bin/biunivers-pvlogfs",
      launcher,
      mounts,
    });
    await expect(
      supervisor.prepare({
        runIdHex,
        paths: { ...paths, upper: "/tmp/upper" },
        capabilityHex: "22".repeat(32),
      }),
    ).rejects.toMatchObject({ code: "MOUNT_INVALID" });
    await expect(
      supervisor.prepare({
        runIdHex,
        paths,
        capabilityHex: "caller-token",
      }),
    ).rejects.toMatchObject({ code: "MOUNT_INVALID" });
  });
});
