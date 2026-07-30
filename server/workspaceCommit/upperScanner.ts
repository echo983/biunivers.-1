import { execFile } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface UpperScanLimits {
  maxEntries: number;
  maxDepth: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface UpperScanEntry {
  path: string;
  kind: "file" | "directory" | "whiteout";
  size: number;
  mtimeNs: string;
  ctimeNs: string;
  device: string;
  inode: string;
  opaque: boolean;
}

export interface UpperScanResult {
  schemaVersion: 1;
  entries: UpperScanEntry[];
  totalFileBytes: number;
}

export interface UpperScannerExecutor {
  execute(
    executable: string,
    arguments_: readonly string[],
    options: { timeoutMs: number; maxOutputBytes: number },
  ): Promise<{ stdout: string; stderr: string }>;
}

export class UpperScanner {
  readonly #binary: string;
  readonly #executor: UpperScannerExecutor;

  constructor(options: {
    binary: string;
    executor?: UpperScannerExecutor;
  }) {
    if (
      !options.binary.startsWith("/") ||
      resolve(options.binary) !== options.binary
    ) {
      throw new Error("Upper scanner binary must be an absolute fixed path.");
    }
    this.#binary = options.binary;
    this.#executor = options.executor ?? new SystemUpperScannerExecutor();
  }

  async scan(input: {
    runIdHex: string;
    upperPath: string;
    limits: UpperScanLimits;
  }): Promise<UpperScanResult> {
    validateInput(input);
    const result = await this.#executor.execute(
      this.#binary,
      [
        input.upperPath,
        String(input.limits.maxEntries),
        String(input.limits.maxDepth),
        String(input.limits.maxFileBytes),
        String(input.limits.maxTotalBytes),
      ],
      { timeoutMs: 30_000, maxOutputBytes: 16 * 1024 * 1024 },
    );
    let value: unknown;
    try {
      value = JSON.parse(result.stdout);
    } catch (error) {
      throw new Error("Upper scanner returned invalid JSON.", { cause: error });
    }
    return validateResult(value, input.limits);
  }
}

class SystemUpperScannerExecutor implements UpperScannerExecutor {
  async execute(
    executable: string,
    arguments_: readonly string[],
    options: { timeoutMs: number; maxOutputBytes: number },
  ): Promise<{ stdout: string; stderr: string }> {
    const result = await execFileAsync(executable, [...arguments_], {
      encoding: "utf8",
      timeout: options.timeoutMs,
      maxBuffer: options.maxOutputBytes,
      windowsHide: true,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  }
}

function validateInput(input: {
  runIdHex: string;
  upperPath: string;
  limits: UpperScanLimits;
}): void {
  if (
    !/^[0-9a-f]{32}$/.test(input.runIdHex) ||
    !input.upperPath.startsWith("/") ||
    resolve(input.upperPath) !== input.upperPath ||
    basename(input.upperPath) !== "upper" ||
    basename(dirname(input.upperPath)) !== input.runIdHex ||
    Object.values(input.limits).some(
      (value) => !Number.isSafeInteger(value) || value < 1,
    )
  ) {
    throw new Error("Upper scan input is invalid.");
  }
}

function validateResult(
  value: unknown,
  limits: UpperScanLimits,
): UpperScanResult {
  if (!value || typeof value !== "object") throw invalidResult();
  const result = value as Record<string, unknown>;
  if (
    result.schemaVersion !== 1 ||
    !Array.isArray(result.entries) ||
    !Number.isSafeInteger(result.totalFileBytes) ||
    (result.totalFileBytes as number) < 0 ||
    (result.totalFileBytes as number) > limits.maxTotalBytes ||
    result.entries.length > limits.maxEntries
  ) {
    throw invalidResult();
  }
  let previous = "";
  let summedBytes = 0;
  const entries = result.entries.map((value) => {
    if (!value || typeof value !== "object") throw invalidResult();
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.path !== "string" ||
      !validRelativePath(entry.path, limits.maxDepth) ||
      entry.path <= previous ||
      !["file", "directory", "whiteout"].includes(entry.kind as string) ||
      !Number.isSafeInteger(entry.size) ||
      (entry.size as number) < 0 ||
      typeof entry.mtimeNs !== "string" ||
      !/^-?[0-9]+$/.test(entry.mtimeNs) ||
      typeof entry.ctimeNs !== "string" ||
      !/^-?[0-9]+$/.test(entry.ctimeNs) ||
      typeof entry.device !== "string" ||
      !/^[0-9]+$/.test(entry.device) ||
      typeof entry.inode !== "string" ||
      !/^[0-9]+$/.test(entry.inode) ||
      typeof entry.opaque !== "boolean"
    ) {
      throw invalidResult();
    }
    if (
      (entry.kind === "file" &&
        ((entry.size as number) > limits.maxFileBytes || entry.opaque)) ||
      (entry.kind !== "file" && entry.size !== 0) ||
      (entry.kind !== "directory" && entry.opaque)
    ) {
      throw invalidResult();
    }
    previous = entry.path;
    if (entry.kind === "file") summedBytes += entry.size as number;
    return {
      path: entry.path,
      kind: entry.kind,
      size: entry.size,
      mtimeNs: entry.mtimeNs,
      ctimeNs: entry.ctimeNs,
      device: entry.device,
      inode: entry.inode,
      opaque: entry.opaque,
    } as UpperScanEntry;
  });
  if (summedBytes !== result.totalFileBytes) throw invalidResult();
  return {
    schemaVersion: 1,
    entries,
    totalFileBytes: result.totalFileBytes as number,
  };
}

function validRelativePath(path: string, maxDepth: number): boolean {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    return false;
  }
  return path.split("/").length <= maxDepth;
}

function invalidResult(): Error {
  return new Error("Upper scanner returned an invalid result.");
}
