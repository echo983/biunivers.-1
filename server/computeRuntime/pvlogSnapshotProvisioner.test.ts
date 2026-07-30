import { describe, expect, it, vi } from "vitest";
import { PvlogSnapshotProvisioner } from "./pvlogSnapshotProvisioner.js";

const fixed = {
  runIdHex: "11".repeat(16),
  workspaceIdHex: "22".repeat(16),
  inputHeadFidHex: "33".repeat(16),
  revision: 7,
  paths: { root: "/var/lib/biunivers/runtime/11" },
  capabilityHex: "44".repeat(32),
};

describe("PvlogSnapshotProvisioner", () => {
  it("publishes the exact requested snapshot and releases it", async () => {
    const listen = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const createGateway = vi.fn().mockResolvedValue({
      snapshot: {
        workspaceIdHex: fixed.workspaceIdHex,
        headFidHex: fixed.inputHeadFidHex,
        revision: fixed.revision,
      },
      listen,
      close,
    });
    const provisioner = makeProvisioner(createGateway);

    await provisioner.provision(fixed);
    expect(createGateway).toHaveBeenCalledWith({
      workspaceIdHex: fixed.workspaceIdHex,
      socketPath: `${fixed.paths.root}/gateway.sock`,
      snapshotPath: `${fixed.paths.root}/snapshot.json`,
      capability: Buffer.from(fixed.capabilityHex, "hex"),
    });
    expect(listen).toHaveBeenCalledOnce();
    await expect(provisioner.provision(fixed)).rejects.toThrow(
      "already provisioned",
    );
    await provisioner.release(fixed.runIdHex);
    expect(close).toHaveBeenCalledOnce();
  });

  it("fails closed when the captured HEAD has advanced", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const listen = vi.fn();
    const provisioner = makeProvisioner(
      vi.fn().mockResolvedValue({
        snapshot: {
          workspaceIdHex: fixed.workspaceIdHex,
          headFidHex: "55".repeat(16),
          revision: fixed.revision + 1,
        },
        listen,
        close,
      }),
    );

    await expect(provisioner.provision(fixed)).rejects.toThrow(
      "requested fixed HEAD",
    );
    expect(listen).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes a partially started gateway when listen fails", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const provisioner = makeProvisioner(
      vi.fn().mockResolvedValue({
        snapshot: {
          workspaceIdHex: fixed.workspaceIdHex,
          headFidHex: fixed.inputHeadFidHex,
          revision: fixed.revision,
        },
        listen: vi.fn().mockRejectedValue(new Error("socket failed")),
        close,
      }),
    );

    await expect(provisioner.provision(fixed)).rejects.toThrow("socket failed");
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects malformed capabilities before constructing a gateway", async () => {
    const createGateway = vi.fn();
    const provisioner = makeProvisioner(createGateway);
    await expect(
      provisioner.provision({ ...fixed, capabilityHex: "caller-token" }),
    ).rejects.toThrow("capability is invalid");
    expect(createGateway).not.toHaveBeenCalled();
  });
});

function makeProvisioner(createGateway: ReturnType<typeof vi.fn>) {
  return new PvlogSnapshotProvisioner({
    snapshotProvider: {} as never,
    contentReader: {} as never,
    createGateway,
  });
}
