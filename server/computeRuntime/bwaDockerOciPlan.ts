import { basename, resolve } from "node:path";
import type { DockerOciPlan } from "./dockerOciPlan.js";
import { parseInstalledReference } from "./dockerImageAdapter.js";

const RUN_ID_PATTERN = /^[0-9a-f]{32}$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export const BWA_EXECUTOR_ID = "bwa.workspace-application.v1";

export interface BwaOciLimits {
  cpuLimit: number;
  memoryBytes: number;
  pidsLimit: number;
  temporaryBytes: number;
  timeoutMs: number;
  outputBytesLimit: number;
}

export const DEFAULT_BWA_OCI_LIMITS: BwaOciLimits = Object.freeze({
  cpuLimit: 2,
  memoryBytes: 1024 * 1024 * 1024,
  pidsLimit: 256,
  temporaryBytes: 256 * 1024 * 1024,
  timeoutMs: 30_000,
  outputBytesLimit: 1024 * 1024,
});

export interface BwaLaunchSpec {
  imageReference: string;
  environment: Readonly<Record<string, string>>;
}

export function buildBwaDockerOciPlan(input: {
  runIdHex: string;
  mergedPath: string;
  launch: BwaLaunchSpec;
  limits?: BwaOciLimits;
}): DockerOciPlan {
  const limits = input.limits ?? DEFAULT_BWA_OCI_LIMITS;
  if (
    !RUN_ID_PATTERN.test(input.runIdHex) ||
    input.runIdHex === "0".repeat(32) ||
    !input.mergedPath.startsWith("/") ||
    resolve(input.mergedPath) !== input.mergedPath ||
    basename(input.mergedPath) !== "merged"
  ) {
    throw new Error("BWA OCI Run identity or merged path is invalid.");
  }
  parseInstalledReference(input.launch.imageReference);
  validateLimits(limits);
  const environment = validateEnvironment(input.launch.environment);
  const containerName = `biunivers-run-${input.runIdHex}`;
  const environmentArguments = Object.entries({
    ...environment,
    BIUNIVERS_WORKSPACE_PATH: "/workspace",
    BIUNIVERS_HTTP_PORT: "8080",
    BIUNIVERS_PROTOCOL_VERSION: "1",
  })
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([name, value]) => ["--env", `${name}=${value}`]);
  return {
    executable: "docker",
    containerName,
    createArguments: [
      "create",
      "--name",
      containerName,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      String(limits.pidsLimit),
      "--memory",
      String(limits.memoryBytes),
      "--cpus",
      String(limits.cpuLimit),
      "--user",
      "65532:65532",
      "--volume",
      `${input.mergedPath}:/workspace:rw`,
      "--workdir",
      "/workspace",
      "--tmpfs",
      `/tmp:rw,nosuid,nodev,noexec,size=${limits.temporaryBytes}`,
      ...environmentArguments,
      input.launch.imageReference,
    ],
    startArguments: ["start", containerName],
    freezeArguments: ["pause", containerName],
    thawArguments: ["unpause", containerName],
    stopArguments: ["stop", "--time", "10", containerName],
    inspectArguments: [
      "inspect",
      "--format",
      "{{json .State}}",
      containerName,
    ],
    removeArguments: ["rm", "--force", containerName],
  };
}

export function bwaCommandLimits(limits: BwaOciLimits = DEFAULT_BWA_OCI_LIMITS) {
  validateLimits(limits);
  return { timeoutMs: limits.timeoutMs, outputBytesLimit: limits.outputBytesLimit };
}

function validateEnvironment(value: Readonly<Record<string, string>>): Record<string, string> {
  const entries = Object.entries(value);
  if (entries.length > 256) throw new Error("BWA environment is invalid.");
  let totalBytes = 0;
  const output: Record<string, string> = {};
  for (const [name, item] of entries) {
    if (
      !ENVIRONMENT_NAME_PATTERN.test(name) ||
      name.startsWith("BIUNIVERS_") ||
      typeof item !== "string" ||
      item.includes("\0") ||
      Buffer.byteLength(item) > 64 * 1024
    ) {
      throw new Error("BWA environment is invalid.");
    }
    totalBytes += Buffer.byteLength(name) + Buffer.byteLength(item);
    output[name] = item;
  }
  if (totalBytes > 256 * 1024) throw new Error("BWA environment is invalid.");
  return output;
}

function validateLimits(value: BwaOciLimits): void {
  if (
    !Number.isFinite(value.cpuLimit) ||
    value.cpuLimit <= 0 ||
    value.cpuLimit > 64 ||
    !positiveInteger(value.memoryBytes) ||
    !positiveInteger(value.pidsLimit) ||
    !positiveInteger(value.temporaryBytes) ||
    !positiveInteger(value.timeoutMs) ||
    !positiveInteger(value.outputBytesLimit)
  ) {
    throw new Error("BWA OCI limits are invalid.");
  }
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
