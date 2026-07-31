import { describe, expect, it } from "vitest";
import {
  buildBwaDockerOciPlan,
  BWA_EXECUTOR_ID,
} from "./bwaDockerOciPlan.js";

const runIdHex = "11".repeat(16);
const imageReference = `ghcr.io/echo983/probe@sha256:${"a".repeat(64)}`;

describe("buildBwaDockerOciPlan", () => {
  it("builds a fixed non-root plan without overriding image entrypoint", () => {
    const plan = buildBwaDockerOciPlan({
      runIdHex,
      mergedPath: `/tmp/runs/${runIdHex}/merged`,
      launch: {
        imageReference,
        environment: { MODE: "safe", API_TOKEN: "secret-test-value" },
      },
    });
    expect(BWA_EXECUTOR_ID).toBe("bwa.workspace-application.v1");
    expect(plan.createArguments).toContain("65532:65532");
    expect(plan.createArguments).toContain("none");
    expect(plan.createArguments).toContain("ALL");
    expect(plan.createArguments).toContain("MODE=safe");
    expect(plan.createArguments).toContain("API_TOKEN=secret-test-value");
    expect(plan.createArguments).toContain("BIUNIVERS_HTTP_PORT=8080");
    expect(plan.createArguments).not.toContain("--workdir");
    expect(plan.createArguments.at(-1)).toBe(imageReference);
    expect(plan.createArguments).not.toContain("--entrypoint");
    expect(plan.createArguments).not.toContain("--privileged");
    expect(plan.createArguments).not.toContain("--network=host");
  });

  it("rejects mutable images, system environment overrides, and path injection", () => {
    expect(() =>
      buildBwaDockerOciPlan({
        runIdHex,
        mergedPath: `/tmp/runs/${runIdHex}/merged`,
        launch: { imageReference: "ghcr.io/echo983/probe:latest", environment: {} },
      }),
    ).toThrow("Installed BWA image reference is invalid");
    expect(() =>
      buildBwaDockerOciPlan({
        runIdHex,
        mergedPath: `/tmp/runs/${runIdHex}/merged`,
        launch: { imageReference, environment: { BIUNIVERS_HTTP_PORT: "9" } },
      }),
    ).toThrow("environment is invalid");
    expect(() =>
      buildBwaDockerOciPlan({
        runIdHex,
        mergedPath: "/tmp/not-a-run",
        launch: { imageReference, environment: {} },
      }),
    ).toThrow("identity or merged path is invalid");
  });
});
