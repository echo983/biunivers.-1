import { describe, expect, it, vi } from "vitest";
import type { CommandExecutor } from "./dockerOciAdapter.js";
import { DockerBwaNetworkAdapter } from "./dockerBwaNetworkAdapter.js";

const identity = "a".repeat(64);
const containerName = `biunivers-run-${"11".repeat(16)}`;

describe("DockerBwaNetworkAdapter", () => {
  it("accepts only the labeled non-internal bridge", async () => {
    const executor = commandExecutor([
      JSON.stringify([{ Name: "biunivers-bwa", Driver: "bridge", Internal: false,
        Labels: { "io.biunivers.managed": "bwa.v1" } }]),
    ]);
    await expect(new DockerBwaNetworkAdapter(executor).ensure()).resolves.toBeUndefined();
  });

  it("resolves one running container IP bound to the immutable identity", async () => {
    const executor = commandExecutor([
      JSON.stringify([{ Id: identity, State: { Running: true, Paused: false },
        NetworkSettings: { Networks: { "biunivers-bwa": { IPAddress: "172.30.0.7" } } } }]),
    ]);
    await expect(
      new DockerBwaNetworkAdapter(executor).resolve(containerName, identity),
    ).resolves.toEqual({ address: "172.30.0.7", port: 8080, runtimeIdentity: identity });
  });

  it("rejects an endpoint whose container identity differs", async () => {
    const executor = commandExecutor([
      JSON.stringify([{ Id: "b".repeat(64), State: { Running: true, Paused: false },
        NetworkSettings: { Networks: { "biunivers-bwa": { IPAddress: "172.30.0.7" } } } }]),
    ]);
    await expect(
      new DockerBwaNetworkAdapter(executor).resolve(containerName, identity),
    ).rejects.toMatchObject({ code: "OCI_OUTPUT_INVALID" });
  });
});

function commandExecutor(outputs: string[]): CommandExecutor {
  const execute = vi.fn(async () => ({ stdout: outputs.shift() ?? "", stderr: "" }));
  return { execute };
}
