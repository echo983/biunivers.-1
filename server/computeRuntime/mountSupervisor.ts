import { spawn, execFile } from "node:child_process";
import { chmod } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import type { RunPaths } from "./runDirectoryManager.js";

const execFileAsync = promisify(execFile);
const CAPABILITY_PATTERN = /^[0-9a-f]{64}$/;

export interface ManagedProcess {
  readonly pid: number;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  terminate(signal: NodeJS.Signals): void;
}

export interface CommandLauncher {
  start(executable: string, arguments_: readonly string[]): ManagedProcess;
}

export interface MountController {
  isMounted(path: string): Promise<boolean>;
  makeWorkspaceWritable(path: string): Promise<void>;
  unmount(path: string): Promise<void>;
}

export interface MountedRun {
  runIdHex: string;
  pvlogfsPid: number;
  overlayPid: number;
}

interface ActiveMount {
  paths: RunPaths;
  pvlogfs: ManagedProcess;
  overlay: ManagedProcess;
}

export class MountSupervisorError extends Error {
  constructor(
    public readonly code:
      | "MOUNT_INVALID"
      | "MOUNT_ALREADY_ACTIVE"
      | "MOUNT_NOT_ACTIVE"
      | "MOUNT_START_FAILED"
      | "MOUNT_CLEANUP_FAILED",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MountSupervisorError";
  }
}

export class MountSupervisor {
  readonly #pvlogfsBinary: string;
  readonly #overlayBinary: string;
  readonly #launcher: CommandLauncher;
  readonly #mounts: MountController;
  readonly #pollIntervalMs: number;
  readonly #mountTimeoutMs: number;
  readonly #active = new Map<string, ActiveMount>();

  constructor(options: {
    pvlogfsBinary: string;
    overlayBinary?: string;
    launcher?: CommandLauncher;
    mounts?: MountController;
    pollIntervalMs?: number;
    mountTimeoutMs?: number;
  }) {
    if (
      !options.pvlogfsBinary.startsWith("/") ||
      (options.overlayBinary !== undefined &&
        !options.overlayBinary.startsWith("/"))
    ) {
      throw invalid("Mount binaries must use fixed absolute paths.");
    }
    this.#pvlogfsBinary = options.pvlogfsBinary;
    this.#overlayBinary = options.overlayBinary ?? "/usr/bin/fuse-overlayfs";
    this.#launcher = options.launcher ?? new SystemCommandLauncher();
    this.#mounts = options.mounts ?? new SystemMountController();
    this.#pollIntervalMs = positive(
      options.pollIntervalMs ?? 50,
      "mount poll interval",
    );
    this.#mountTimeoutMs = positive(
      options.mountTimeoutMs ?? 10_000,
      "mount timeout",
    );
  }

  async prepare(input: {
    runIdHex: string;
    paths: RunPaths;
    capabilityHex: string;
  }): Promise<MountedRun> {
    validateRunPaths(input.runIdHex, input.paths);
    if (!CAPABILITY_PATTERN.test(input.capabilityHex)) {
      throw invalid("PVLogFS capability is invalid.");
    }
    if (this.#active.has(input.runIdHex)) {
      throw new MountSupervisorError(
        "MOUNT_ALREADY_ACTIVE",
        "Run mounts are already active.",
      );
    }
    const snapshotPath = join(input.paths.root, "snapshot.json");
    const socketPath = join(input.paths.root, "gateway.sock");
    let pvlogfs: ManagedProcess | undefined;
    let overlay: ManagedProcess | undefined;
    try {
      pvlogfs = this.#launcher.start(this.#pvlogfsBinary, [
        "--allow-other",
        snapshotPath,
        socketPath,
        input.capabilityHex,
        input.paths.lower,
      ]);
      await this.#waitUntilMounted(input.paths.lower, pvlogfs);
      overlay = this.#launcher.start(this.#overlayBinary, [
        "-f",
        "-o",
        [
          `lowerdir=${input.paths.lower}`,
          `upperdir=${input.paths.upper}`,
          `workdir=${input.paths.work}`,
          "allow_other",
        ].join(","),
        input.paths.merged,
      ]);
      await this.#waitUntilMounted(input.paths.merged, overlay);
      await this.#mounts.makeWorkspaceWritable(input.paths.merged);
      this.#active.set(input.runIdHex, {
        paths: input.paths,
        pvlogfs,
        overlay,
      });
      return {
        runIdHex: input.runIdHex,
        pvlogfsPid: pvlogfs.pid,
        overlayPid: overlay.pid,
      };
    } catch (error) {
      await this.#cleanupPartial(input.paths, pvlogfs, overlay);
      throw new MountSupervisorError(
        "MOUNT_START_FAILED",
        "Run mount stack could not be prepared.",
        { cause: error },
      );
    }
  }

  inspect(runIdHex: string): MountedRun | undefined {
    const active = this.#active.get(runIdHex);
    return active
      ? {
          runIdHex,
          pvlogfsPid: active.pvlogfs.pid,
          overlayPid: active.overlay.pid,
        }
      : undefined;
  }

  async cleanup(runIdHex: string): Promise<void> {
    const active = this.#active.get(runIdHex);
    if (!active) {
      throw new MountSupervisorError(
        "MOUNT_NOT_ACTIVE",
        "Run mount stack is not active.",
      );
    }
    const errors = await this.#cleanupPartial(
      active.paths,
      active.pvlogfs,
      active.overlay,
    );
    if (errors.length === 0) {
      this.#active.delete(runIdHex);
      return;
    }
    throw new MountSupervisorError(
      "MOUNT_CLEANUP_FAILED",
      `Run mount cleanup failed at ${errors.join(", ")}.`,
    );
  }

  async #waitUntilMounted(
    path: string,
    process: ManagedProcess,
  ): Promise<void> {
    const deadline = Date.now() + this.#mountTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.#mounts.isMounted(path)) return;
      const exited = await Promise.race([
        process.exited.then(() => true),
        delay(this.#pollIntervalMs).then(() => false),
      ]);
      if (exited) throw new Error("Mount process exited before readiness.");
    }
    throw new Error("Mount readiness timed out.");
  }

  async #cleanupPartial(
    paths: RunPaths,
    pvlogfs?: ManagedProcess,
    overlay?: ManagedProcess,
  ): Promise<string[]> {
    const errors: string[] = [];
    if (await this.#mounts.isMounted(paths.merged)) {
      try {
        await this.#mounts.unmount(paths.merged);
      } catch {
        errors.push("unmount-merged");
      }
    }
    if (overlay) {
      overlay.terminate("SIGTERM");
      if (!(await ensureExit(overlay))) errors.push("stop-overlay");
    }
    if (await this.#mounts.isMounted(paths.lower)) {
      try {
        await this.#mounts.unmount(paths.lower);
      } catch {
        errors.push("unmount-lower");
      }
    }
    if (pvlogfs) {
      pvlogfs.terminate("SIGTERM");
      if (!(await ensureExit(pvlogfs))) errors.push("stop-pvlogfs");
    }
    return errors;
  }
}

export class SystemCommandLauncher implements CommandLauncher {
  start(executable: string, arguments_: readonly string[]): ManagedProcess {
    const child = spawn(executable, [...arguments_], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    if (!child.pid) throw new Error("Mount process did not receive a PID.");
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    return {
      pid: child.pid,
      exited,
      terminate: (signal) => child.kill(signal),
    };
  }
}

export class SystemMountController implements MountController {
  async isMounted(path: string): Promise<boolean> {
    try {
      await execFileAsync("/usr/bin/mountpoint", ["--quiet", path]);
      return true;
    } catch {
      return false;
    }
  }

  async makeWorkspaceWritable(path: string): Promise<void> {
    await chmod(path, 0o707);
  }

  async unmount(path: string): Promise<void> {
    try {
      await execFileAsync("/usr/bin/fusermount3", ["-u", path]);
    } catch {
      await execFileAsync("/usr/bin/fusermount3", ["-uz", path]);
    }
  }
}

function validateRunPaths(runIdHex: string, paths: RunPaths): void {
  const expectedRootSuffix = `/${runIdHex}`;
  if (
    !/^[0-9a-f]{32}$/.test(runIdHex) ||
    !paths.root.endsWith(expectedRootSuffix) ||
    paths.lower !== join(paths.root, "lower") ||
    paths.upper !== join(paths.root, "upper") ||
    paths.work !== join(paths.root, "work") ||
    paths.merged !== join(paths.root, "merged") ||
    paths.manifest !== join(paths.root, "runtime.json")
  ) {
    throw invalid("Run mount paths are outside the fixed layout.");
  }
}

async function ensureExit(process: ManagedProcess): Promise<boolean> {
  if (
    await Promise.race([
      process.exited.then(() => true, () => true),
      delay(2_000).then(() => false),
    ])
  ) {
    return true;
  }
  process.terminate("SIGKILL");
  return await Promise.race([
    process.exited.then(() => true, () => true),
    delay(2_000).then(() => false),
  ]);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid(`${label} is invalid.`);
  }
  return value;
}

function invalid(message: string): MountSupervisorError {
  return new MountSupervisorError("MOUNT_INVALID", message);
}
