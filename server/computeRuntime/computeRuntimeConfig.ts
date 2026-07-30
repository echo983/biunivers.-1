import { basename, resolve } from "node:path";
import type { ExecutorDefinition } from "./executorRegistry.js";

type Environment = Record<string, string | undefined>;

export interface ComputeRuntimeConfig {
  runRoot: string;
  socketPath: string;
  cachePath: string;
  pvlogfsBinary: string;
  authenticationTokenHex: string;
  executors: readonly ExecutorDefinition[];
}

export function loadComputeRuntimeConfig(
  environment: Environment = process.env,
): ComputeRuntimeConfig {
  const dataDir = absoluteDirectory(
    environment.BIUNIVERS_DATA_DIR?.trim() || "/data",
    "BIUNIVERS_DATA_DIR",
  );
  const runRoot = absoluteDirectory(
    environment.BIUNIVERS_RUNTIME_ROOT?.trim() ||
      `${dataDir}/compute-runtime/runs`,
    "BIUNIVERS_RUNTIME_ROOT",
  );
  const cachePath = absoluteDirectory(
    environment.BIUNIVERS_RUNTIME_CACHE?.trim() ||
      `${dataDir}/compute-runtime/chunk-cache`,
    "BIUNIVERS_RUNTIME_CACHE",
  );
  const socketPath = absoluteFile(
    environment.BIUNIVERS_RUNTIME_SOCKET?.trim() ||
      `${dataDir}/compute-runtime/runtime.sock`,
    "BIUNIVERS_RUNTIME_SOCKET",
  );
  const pvlogfsBinary = absoluteFile(
    environment.BIUNIVERS_PVLOGFS_BINARY?.trim() ||
      "/opt/biunivers/bin/biunivers-pvlogfs",
    "BIUNIVERS_PVLOGFS_BINARY",
  );
  const authenticationTokenHex =
    environment.BIUNIVERS_RUNTIME_AUTH_TOKEN?.trim() ?? "";
  if (!/^[0-9a-f]{64}$/.test(authenticationTokenHex)) {
    throw new Error(
      "BIUNIVERS_RUNTIME_AUTH_TOKEN must be a random 256-bit lowercase hex value.",
    );
  }

  return Object.freeze({
    runRoot,
    socketPath,
    cachePath,
    pvlogfsBinary,
    authenticationTokenHex,
    executors: Object.freeze([loadDiagnosticExecutor(environment)]),
  });
}

function loadDiagnosticExecutor(
  environment: Environment,
): ExecutorDefinition {
  const image = environment.BIUNIVERS_DIAGNOSTIC_EXECUTOR_IMAGE?.trim() ?? "";
  if (!/^(?:[a-z0-9][a-z0-9._/-]*@)?sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error(
      "BIUNIVERS_DIAGNOSTIC_EXECUTOR_IMAGE must be digest-pinned.",
    );
  }
  return Object.freeze({
    executorId: "system.diagnostic",
    image,
    entrypoint: "/usr/local/bin/biunivers-diagnostic",
    arguments: Object.freeze([]),
    uid: 65532,
    gid: 65532,
    cpuLimit: 1,
    memoryBytes: 256 * 1024 * 1024,
    pidsLimit: 64,
    timeoutMs: 30_000,
    upperBytesLimit: 256 * 1024 * 1024,
    upperInodesLimit: 10_000,
    outputBytesLimit: 1024 * 1024,
  });
}

function absoluteDirectory(value: string, key: string): string {
  const path = resolve(value);
  if (!value.startsWith("/") || path !== value || path === "/") {
    throw new Error(`${key} must be an absolute, normalized non-root path.`);
  }
  return path;
}

function absoluteFile(value: string, key: string): string {
  const path = resolve(value);
  if (
    !value.startsWith("/") ||
    path !== value ||
    path === "/" ||
    basename(path).length === 0
  ) {
    throw new Error(`${key} must be an absolute, normalized file path.`);
  }
  return path;
}
