import { join } from "node:path";
import { PvlogFsGateway } from "../workspace/pvlogFsGateway.js";
import type { WorkspaceContentReader } from "../workspace/workspaceContentReader.js";
import type { WorkspaceSnapshotProvider } from "../workspace/workspaceSnapshotProvider.js";
import type { SnapshotProvisioner } from "./computeRuntimeCoordinator.js";

interface GatewayHandle {
  readonly snapshot: {
    workspaceIdHex: string;
    headFidHex: string;
    revision: number;
  };
  listen(): Promise<void>;
  close(): Promise<void>;
}

type GatewayFactory = (input: {
  workspaceIdHex: string;
  socketPath: string;
  snapshotPath: string;
  capability: Uint8Array;
}) => Promise<GatewayHandle>;

export class PvlogSnapshotProvisioner implements SnapshotProvisioner {
  readonly #createGateway: GatewayFactory;
  readonly #active = new Map<string, GatewayHandle>();

  constructor(options: {
    snapshotProvider: WorkspaceSnapshotProvider;
    contentReader: WorkspaceContentReader;
    createGateway?: GatewayFactory;
  }) {
    this.#createGateway =
      options.createGateway ??
      (async (input) =>
        await PvlogFsGateway.create({
          workspaceIdHex: input.workspaceIdHex,
          socketPath: input.socketPath,
          snapshotPath: input.snapshotPath,
          snapshotProvider: options.snapshotProvider,
          contentReader: options.contentReader,
          randomCapability: () => input.capability,
        }));
  }

  async provision(input: {
    runIdHex: string;
    workspaceIdHex: string;
    inputHeadFidHex: string;
    revision: number;
    paths: { root: string };
    capabilityHex: string;
  }): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(input.capabilityHex)) {
      throw new Error("Run snapshot capability is invalid.");
    }
    if (this.#active.has(input.runIdHex)) {
      throw new Error("Run snapshot is already provisioned.");
    }
    const gateway = await this.#createGateway({
      workspaceIdHex: input.workspaceIdHex,
      socketPath: join(input.paths.root, "gateway.sock"),
      snapshotPath: join(input.paths.root, "snapshot.json"),
      capability: Buffer.from(input.capabilityHex, "hex"),
    });
    if (
      gateway.snapshot.workspaceIdHex !== input.workspaceIdHex ||
      gateway.snapshot.headFidHex !== input.inputHeadFidHex ||
      gateway.snapshot.revision !== input.revision
    ) {
      await gateway.close();
      throw new Error(
        "Workspace snapshot no longer matches the requested fixed HEAD.",
      );
    }
    try {
      await gateway.listen();
      this.#active.set(input.runIdHex, gateway);
    } catch (error) {
      await gateway.close().catch(() => undefined);
      throw error;
    }
  }

  async release(runIdHex: string): Promise<void> {
    const gateway = this.#active.get(runIdHex);
    if (!gateway) return;
    this.#active.delete(runIdHex);
    await gateway.close();
  }
}
