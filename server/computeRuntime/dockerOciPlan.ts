import { basename, resolve } from "node:path";
import type { ExecutorDefinition } from "./executorRegistry.js";

const RUN_ID_PATTERN = /^[0-9a-f]{32}$/;

export interface DockerOciPlan {
  executable: "docker";
  containerName: string;
  createArguments: string[];
  startArguments: string[];
  stopArguments: string[];
  inspectArguments: string[];
  removeArguments: string[];
}

export function buildDockerOciPlan(input: {
  runIdHex: string;
  mergedPath: string;
  executor: ExecutorDefinition;
}): DockerOciPlan {
  if (
    !RUN_ID_PATTERN.test(input.runIdHex) ||
    input.runIdHex === "0".repeat(32) ||
    !input.mergedPath.startsWith("/") ||
    resolve(input.mergedPath) !== input.mergedPath ||
    basename(input.mergedPath) !== "merged"
  ) {
    throw new Error("OCI Run identity or merged path is invalid.");
  }
  const containerName = `biunivers-run-${input.runIdHex}`;
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
      String(input.executor.pidsLimit),
      "--memory",
      String(input.executor.memoryBytes),
      "--cpus",
      String(input.executor.cpuLimit),
      "--user",
      `${input.executor.uid}:${input.executor.gid}`,
      "--volume",
      `${input.mergedPath}:/workspace:rw`,
      "--workdir",
      "/workspace",
      "--entrypoint",
      input.executor.entrypoint,
      input.executor.image,
      ...input.executor.arguments,
    ],
    startArguments: ["start", containerName],
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
