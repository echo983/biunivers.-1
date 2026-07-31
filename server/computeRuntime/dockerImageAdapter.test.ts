import { describe, expect, it } from "vitest";
import type { CommandExecutor, CommandResult } from "./dockerOciAdapter.js";
import {
  DockerImageAdapter,
  parseDiscoveryReference,
  parseInstalledReference,
} from "./dockerImageAdapter.js";

const digest = `sha256:${"a".repeat(64)}`;

class FakeExecutor implements CommandExecutor {
  private readonly mutableCalls: string[][] = [];
  get calls(): readonly string[][] {
    return this.mutableCalls;
  }
  readonly results: CommandResult[] = [];

  async execute(
    executable: string,
    arguments_: readonly string[],
    _options: { timeoutMs: number; maxOutputBytes: number },
  ): Promise<CommandResult> {
    void _options;
    expect(executable).toBe("docker");
    this.mutableCalls.push([...arguments_]);
    const result = this.results.shift();
    if (!result) throw new Error("missing fake result");
    return result;
  }
}

function inspection(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([
    {
      RepoDigests: [`ghcr.io/echo983/probe@${digest}`],
      Architecture: "amd64",
      Os: "linux",
      Config: {
        Labels: {
          "io.biunivers.workspace-application.protocol": "1",
          "org.opencontainers.image.description": "Probe",
          "org.opencontainers.image.source": "https://github.com/echo983/probe",
        },
        Entrypoint: ["/app/start"],
        Cmd: [],
      },
      ...overrides,
    },
  ]);
}

describe("DockerImageAdapter", () => {
  it("normalizes public GHCR discovery references and rejects expanded input", () => {
    expect(parseDiscoveryReference("ghcr.io/Echo983/Probe:v1")).toEqual({
      repository: "ghcr.io/echo983/probe",
      discoveryReference: "ghcr.io/echo983/probe:v1",
    });
    expect(parseDiscoveryReference("ghcr.io/echo983/probe").discoveryReference).toBe(
      "ghcr.io/echo983/probe:latest",
    );
    for (const value of [
      "ubuntu",
      "https://ghcr.io/echo983/probe",
      "ghcr.io/echo983/probe@sha256:abc",
      "ghcr.io/echo983/probe:v1 --privileged",
    ]) {
      expect(() => parseDiscoveryReference(value)).toThrow("invalid");
    }
  });

  it("pulls then trusts the unique matching local RepoDigest", async () => {
    const executor = new FakeExecutor();
    executor.results.push(
      { stdout: "pulled", stderr: "" },
      { stdout: inspection(), stderr: "" },
    );
    const result = await new DockerImageAdapter(executor).pullAndInspect(
      "ghcr.io/echo983/probe:stable",
    );
    expect(result).toMatchObject({
      canonicalRepository: "ghcr.io/echo983/probe",
      digest,
      imageReference: `ghcr.io/echo983/probe@${digest}`,
      architecture: "amd64",
    });
    expect(executor.calls).toEqual([
      ["pull", "ghcr.io/echo983/probe:stable"],
      ["image", "inspect", "ghcr.io/echo983/probe:stable"],
    ]);
  });

  it("inspects an installed digest without pulling and fails closed on mismatch", async () => {
    const executor = new FakeExecutor();
    executor.results.push({ stdout: inspection(), stderr: "" });
    const reference = `ghcr.io/echo983/probe@${digest}`;
    expect(parseInstalledReference(reference)).toEqual({
      repository: "ghcr.io/echo983/probe",
      digest,
    });
    await expect(new DockerImageAdapter(executor).inspectInstalled(reference)).resolves.toMatchObject({
      digest,
    });
    expect(executor.calls).toEqual([["image", "inspect", reference]]);

    const mismatch = new FakeExecutor();
    mismatch.results.push({
      stdout: inspection({ RepoDigests: [`ghcr.io/echo983/probe@sha256:${"b".repeat(64)}`] }),
      stderr: "",
    });
    await expect(
      new DockerImageAdapter(mismatch).inspectInstalled(reference),
    ).rejects.toMatchObject({ code: "OCI_OUTPUT_INVALID" });
  });
});
