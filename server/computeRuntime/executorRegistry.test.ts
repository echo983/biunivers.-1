import { describe, expect, it } from "vitest";
import {
  ExecutorRegistry,
  type ExecutorDefinition,
} from "./executorRegistry.js";
import { buildDockerOciPlan } from "./dockerOciPlan.js";

const diagnostic: ExecutorDefinition = {
  executorId: "system.diagnostic",
  image: `ghcr.io/echo983/biunivers-diagnostic@sha256:${"11".repeat(32)}`,
  entrypoint: "/usr/local/bin/diagnostic",
  arguments: ["--workspace", "/workspace"],
  uid: 10001,
  gid: 10001,
  cpuLimit: 0.5,
  memoryBytes: 256 * 1024 * 1024,
  pidsLimit: 64,
  timeoutMs: 5 * 60 * 1000,
  upperBytesLimit: 1024 * 1024 * 1024,
  upperInodesLimit: 100_000,
  outputBytesLimit: 1024 * 1024,
};

describe("ExecutorRegistry and Docker OCI plan", () => {
  it("accepts only fixed digest-pinned non-root Executors", () => {
    const registry = new ExecutorRegistry([diagnostic]);
    expect(registry.get("system.diagnostic")).toEqual(diagnostic);
    expect(registry.list()).toEqual([diagnostic]);
    expect(() => registry.get("caller-chosen")).toThrowError(
      expect.objectContaining({ code: "EXECUTOR_NOT_FOUND" }),
    );
    expect(
      () =>
        new ExecutorRegistry([
          { ...diagnostic, image: "ghcr.io/echo983/latest" },
        ]),
    ).toThrowError(expect.objectContaining({ code: "EXECUTOR_INVALID" }));
    expect(
      () => new ExecutorRegistry([{ ...diagnostic, uid: 0 }]),
    ).toThrowError(expect.objectContaining({ code: "EXECUTOR_INVALID" }));
    expect(
      () => new ExecutorRegistry([diagnostic, diagnostic]),
    ).toThrowError(expect.objectContaining({ code: "EXECUTOR_DUPLICATE" }));
  });

  it("constructs a closed Docker plan without caller-controlled runtime options", () => {
    const runIdHex = "22".repeat(16);
    const plan = buildDockerOciPlan({
      runIdHex,
      mergedPath: `/run/biunivers/workspaces/${runIdHex}/merged`,
      executor: diagnostic,
    });
    expect(plan.containerName).toBe(`biunivers-run-${runIdHex}`);
    expect(plan.createArguments).toEqual([
      "create",
      "--name",
      plan.containerName,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "64",
      "--memory",
      String(256 * 1024 * 1024),
      "--cpus",
      "0.5",
      "--user",
      "10001:10001",
      "--volume",
      `/run/biunivers/workspaces/${runIdHex}/merged:/workspace:rw`,
      "--workdir",
      "/workspace",
      "--entrypoint",
      "/usr/local/bin/diagnostic",
      diagnostic.image,
      "--workspace",
      "/workspace",
    ]);
    expect(plan.createArguments).not.toContain("/dev/fuse");
    expect(plan.createArguments.join(" ")).not.toContain("docker.sock");
    expect(plan.createArguments.join(" ")).not.toContain("/data");
    expect(plan.startArguments).toEqual(["start", plan.containerName]);
  });

  it("rejects broad or caller-shaped merged paths", () => {
    for (const mergedPath of [
      "/",
      "/run/biunivers/workspaces/../merged",
      "relative/merged",
      "/tmp/not-workspace",
    ]) {
      expect(() =>
        buildDockerOciPlan({
          runIdHex: "22".repeat(16),
          mergedPath,
          executor: diagnostic,
        }),
      ).toThrow();
    }
  });
});
