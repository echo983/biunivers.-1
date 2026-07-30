import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SystemMountController, type MountController } from "./mountSupervisor.js";
import {
  RunDirectoryManager,
  type RuntimeManifest,
} from "./runDirectoryManager.js";

const execFileAsync = promisify(execFile);

export interface RecoveryController {
  removeContainer(runIdHex: string): Promise<void>;
  unmountIfMounted(path: string): Promise<void>;
}

export interface RecoveryReport {
  recovered: string[];
}

export class InterruptedRunRecovery {
  readonly #controller: RecoveryController;

  constructor(
    controller: RecoveryController = new SystemRecoveryController(),
  ) {
    this.#controller = controller;
  }

  async recover(
    directories: RunDirectoryManager,
    knownRunIds: readonly string[],
  ): Promise<RecoveryReport> {
    const recovered: string[] = [];
    for (const runIdHex of knownRunIds) {
      const manifest = await directories.inspect(runIdHex);
      if (!isInterrupted(manifest)) continue;
      const paths = directories.paths(runIdHex);
      await this.#controller.removeContainer(runIdHex);
      await this.#controller.unmountIfMounted(paths.merged);
      await this.#controller.unmountIfMounted(paths.lower);
      await directories.transition({
        runIdHex,
        expectedState: manifest.state,
        newState: "FAILED",
        errorCode: "INTERRUPTED_DAEMON_RECOVERY",
      });
      recovered.push(runIdHex);
    }
    return { recovered };
  }
}

export class SystemRecoveryController implements RecoveryController {
  readonly #mounts: MountController;

  constructor(mounts: MountController = new SystemMountController()) {
    this.#mounts = mounts;
  }

  async removeContainer(runIdHex: string): Promise<void> {
    if (!/^[0-9a-f]{32}$/.test(runIdHex)) {
      throw new Error("Recovery Run ID is invalid.");
    }
    const name = `biunivers-run-${runIdHex}`;
    const result = await execFileAsync(
      "docker",
      [
        "container",
        "ls",
        "--all",
        "--quiet",
        "--no-trunc",
        "--filter",
        `name=^/${name}$`,
      ],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 },
    );
    const identities = result.stdout.trim()
      ? result.stdout.trim().split(/\s+/)
      : [];
    if (
      identities.length > 1 ||
      identities.some((identity) => !/^[0-9a-f]{64}$/.test(identity))
    ) {
      throw new Error("Recovery container query returned invalid output.");
    }
    if (identities.length === 1) {
      await execFileAsync("docker", ["rm", "--force", name], {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 64 * 1024,
      });
    }
  }

  async unmountIfMounted(path: string): Promise<void> {
    if (!(await this.#mounts.isMounted(path))) return;
    await this.#mounts.unmount(path);
    if (await this.#mounts.isMounted(path)) {
      throw new Error(`Recovery mount remained active: ${path}`);
    }
  }
}

function isInterrupted(manifest: RuntimeManifest): boolean {
  return (
    manifest.state === "PREPARING" ||
    manifest.state === "PREPARED" ||
    manifest.state === "RUNNING" ||
    manifest.state === "FROZEN"
  );
}
