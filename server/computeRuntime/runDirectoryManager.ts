import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const ID_PATTERN = /^[0-9a-f]{32}$/;
const FID_PATTERN = /^[0-9a-f]{32}$/;
const EXECUTOR_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export type LocalRunState =
  | "PREPARING"
  | "PREPARED"
  | "RUNNING"
  | "FROZEN"
  | "STOPPED"
  | "FAILED"
  | "DESTROYED";

export interface RuntimeManifest {
  schemaVersion: 1;
  runIdHex: string;
  workspaceIdHex: string;
  inputHeadFidHex: string;
  revision: number;
  executorId: string;
  state: LocalRunState;
  runtimeIdentity: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  errorCode: string | null;
}

export interface RunPaths {
  root: string;
  lower: string;
  upper: string;
  work: string;
  merged: string;
  manifest: string;
}

export interface ReconcileReport {
  known: string[];
  quarantined: Array<{ name: string; destination: string }>;
}

export class RunDirectoryError extends Error {
  constructor(
    public readonly code:
      | "INVALID_RUNTIME_VALUE"
      | "RUN_DIRECTORY_EXISTS"
      | "RUN_DIRECTORY_NOT_FOUND"
      | "RUN_DIRECTORY_CORRUPT"
      | "RUN_STATE_CONFLICT",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RunDirectoryError";
  }
}

export class RunDirectoryManager {
  readonly #root: string;
  readonly #quarantine: string;
  readonly #now: () => number;

  constructor(options: { root: string; now?: () => number }) {
    if (
      !options.root.startsWith("/") ||
      basename(options.root).length === 0 ||
      resolve(options.root) !== options.root
    ) {
      throw invalid("Run root must be an absolute, non-root directory.");
    }
    this.#root = options.root;
    this.#quarantine = join(options.root, ".quarantine");
    this.#now = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await chmod(this.#root, 0o700);
    await mkdir(this.#quarantine, { recursive: true, mode: 0o700 });
    await chmod(this.#quarantine, 0o700);
  }

  paths(runIdHex: string): RunPaths {
    validateId(runIdHex, "Run ID");
    const root = join(this.#root, runIdHex);
    return {
      root,
      lower: join(root, "lower"),
      upper: join(root, "upper"),
      work: join(root, "work"),
      merged: join(root, "merged"),
      manifest: join(root, "runtime.json"),
    };
  }

  async prepare(input: {
    runIdHex: string;
    workspaceIdHex: string;
    inputHeadFidHex: string;
    revision: number;
    executorId: string;
  }): Promise<{ paths: RunPaths; manifest: RuntimeManifest }> {
    validateId(input.runIdHex, "Run ID");
    validateId(input.workspaceIdHex, "Workspace ID");
    if (
      !FID_PATTERN.test(input.inputHeadFidHex) ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 0 ||
      !EXECUTOR_PATTERN.test(input.executorId)
    ) {
      throw invalid("Run preparation identity is invalid.");
    }
    await this.initialize();
    const paths = this.paths(input.runIdHex);
    if (await pathExists(paths.root)) {
      throw new RunDirectoryError(
        "RUN_DIRECTORY_EXISTS",
        "Run directory already exists.",
      );
    }
    const temporary = join(
      this.#root,
      `.prepare-${input.runIdHex}-${randomUUID()}`,
    );
    const timestamp = this.#now();
    validateTimestamp(timestamp);
    const manifest: RuntimeManifest = {
      schemaVersion: 1,
      ...input,
      state: "PREPARING",
      runtimeIdentity: null,
      createdAtMs: timestamp,
      updatedAtMs: timestamp,
      errorCode: null,
    };
    try {
      await mkdir(temporary, { mode: 0o700 });
      for (const name of ["lower", "upper", "work", "merged"]) {
        await mkdir(join(temporary, name), { mode: 0o700 });
      }
      await writeJsonAtomic(join(temporary, "runtime.json"), manifest);
      await rename(temporary, paths.root);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      if (await pathExists(paths.root)) {
        throw new RunDirectoryError(
          "RUN_DIRECTORY_EXISTS",
          "Run directory was created concurrently.",
          { cause: error },
        );
      }
      throw error;
    }
    return { paths, manifest };
  }

  async inspect(runIdHex: string): Promise<RuntimeManifest> {
    const paths = this.paths(runIdHex);
    let value: unknown;
    try {
      value = JSON.parse(await readFile(paths.manifest, "utf8"));
    } catch (error) {
      throw new RunDirectoryError(
        (await pathExists(paths.root))
          ? "RUN_DIRECTORY_CORRUPT"
          : "RUN_DIRECTORY_NOT_FOUND",
        "Run manifest is missing or unreadable.",
        { cause: error },
      );
    }
    return validateManifest(value, runIdHex);
  }

  async transition(input: {
    runIdHex: string;
    expectedState: LocalRunState;
    newState: LocalRunState;
    runtimeIdentity?: string | null;
    errorCode?: string | null;
  }): Promise<RuntimeManifest> {
    const current = await this.inspect(input.runIdHex);
    if (current.state !== input.expectedState) {
      throw new RunDirectoryError(
        "RUN_STATE_CONFLICT",
        "Local Run state changed before its transition.",
      );
    }
    const timestamp = this.#now();
    validateTimestamp(timestamp);
    if (timestamp < current.updatedAtMs) {
      throw invalid("Run transition timestamp predates its current state.");
    }
    const updated: RuntimeManifest = {
      ...current,
      state: input.newState,
      runtimeIdentity:
        input.runtimeIdentity === undefined
          ? current.runtimeIdentity
          : input.runtimeIdentity,
      errorCode:
        input.errorCode === undefined ? current.errorCode : input.errorCode,
      updatedAtMs: timestamp,
    };
    validateManifest(updated, input.runIdHex);
    await writeJsonAtomic(this.paths(input.runIdHex).manifest, updated);
    return updated;
  }

  async destroy(runIdHex: string, preserveUpper: boolean): Promise<void> {
    const manifest = await this.inspect(runIdHex);
    if (manifest.state === "DESTROYED") {
      if (!preserveUpper) await rm(this.paths(runIdHex).root, { recursive: true });
      return;
    }
    if (manifest.state !== "STOPPED" && manifest.state !== "FAILED") {
      throw new RunDirectoryError(
        "RUN_STATE_CONFLICT",
        "Only a STOPPED or FAILED local Run can be destroyed.",
      );
    }
    const paths = this.paths(runIdHex);
    if (!preserveUpper) {
      await rm(paths.root, { recursive: true });
      return;
    }
    for (const path of [paths.lower, paths.work, paths.merged]) {
      await rm(path, { recursive: true, force: true });
    }
    for (const name of ["gateway.sock", "snapshot.json"]) {
      await rm(join(paths.root, name), { force: true });
    }
    await this.transition({
      runIdHex,
      expectedState: manifest.state,
      newState: "DESTROYED",
    });
  }

  async reconcile(knownRunIdsHex: ReadonlySet<string>): Promise<ReconcileReport> {
    await this.initialize();
    for (const runIdHex of knownRunIdsHex) validateId(runIdHex, "Run ID");
    const report: ReconcileReport = { known: [], quarantined: [] };
    const entries = await readdir(this.#root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".quarantine") continue;
      const source = join(this.#root, entry.name);
      if (
        entry.isDirectory() &&
        ID_PATTERN.test(entry.name) &&
        knownRunIdsHex.has(entry.name)
      ) {
        await this.inspect(entry.name);
        report.known.push(entry.name);
        continue;
      }
      const destination = join(
        this.#quarantine,
        `${entry.name}-${this.#now()}-${randomUUID()}`,
      );
      await rename(source, destination);
      report.quarantined.push({ name: entry.name, destination });
    }
    report.known.sort();
    report.quarantined.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    return report;
  }
}

function validateManifest(
  value: unknown,
  expectedRunIdHex: string,
): RuntimeManifest {
  if (!value || typeof value !== "object") {
    throw corrupt("Run manifest is not an object.");
  }
  const manifest = value as Record<string, unknown>;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.runIdHex !== expectedRunIdHex ||
    typeof manifest.workspaceIdHex !== "string" ||
    !ID_PATTERN.test(manifest.workspaceIdHex) ||
    typeof manifest.inputHeadFidHex !== "string" ||
    !FID_PATTERN.test(manifest.inputHeadFidHex) ||
    !Number.isSafeInteger(manifest.revision) ||
    (manifest.revision as number) < 0 ||
    typeof manifest.executorId !== "string" ||
    !EXECUTOR_PATTERN.test(manifest.executorId) ||
    ![
      "PREPARING",
      "PREPARED",
      "RUNNING",
      "FROZEN",
      "STOPPED",
      "FAILED",
      "DESTROYED",
    ].includes(manifest.state as string) ||
    (manifest.runtimeIdentity !== null &&
      typeof manifest.runtimeIdentity !== "string") ||
    !Number.isSafeInteger(manifest.createdAtMs) ||
    !Number.isSafeInteger(manifest.updatedAtMs) ||
    (manifest.createdAtMs as number) < 0 ||
    (manifest.updatedAtMs as number) < (manifest.createdAtMs as number) ||
    (manifest.errorCode !== null && typeof manifest.errorCode !== "string")
  ) {
    throw corrupt("Run manifest contains invalid fields.");
  }
  return manifest as unknown as RuntimeManifest;
}

async function writeJsonAtomic(
  path: string,
  value: unknown,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await open(path, "r").then((handle) => handle.close());
    return true;
  } catch {
    return false;
  }
}

function validateId(value: string, label: string): void {
  if (!ID_PATTERN.test(value) || value === "0".repeat(32)) {
    throw invalid(`${label} is invalid.`);
  }
}

function validateTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid("Runtime timestamp is invalid.");
  }
}

function invalid(message: string): RunDirectoryError {
  return new RunDirectoryError("INVALID_RUNTIME_VALUE", message);
}

function corrupt(message: string): RunDirectoryError {
  return new RunDirectoryError("RUN_DIRECTORY_CORRUPT", message);
}
