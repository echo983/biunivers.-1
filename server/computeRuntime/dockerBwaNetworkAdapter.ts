import { isIP } from "node:net";
import {
  DockerOciError,
  SystemCommandExecutor,
  type CommandExecutor,
} from "./dockerOciAdapter.js";

export const BWA_DOCKER_NETWORK = "biunivers-bwa";
const MANAGED_LABEL = "io.biunivers.managed";
const MANAGED_VALUE = "bwa.v1";
const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface BwaRuntimeEndpoint {
  address: string;
  port: 8080;
  runtimeIdentity: string;
}

export class DockerBwaNetworkAdapter {
  readonly #executor: CommandExecutor;

  constructor(executor: CommandExecutor = new SystemCommandExecutor()) {
    this.#executor = executor;
  }

  async ensure(): Promise<void> {
    let inspection: unknown;
    try {
      inspection = await this.#inspectNetwork();
    } catch (error) {
      if (!(error instanceof DockerOciError) || error.code !== "OCI_COMMAND_FAILED") throw error;
      try {
        await this.#execute([
          "network",
          "create",
          "--driver",
          "bridge",
          "--label",
          `${MANAGED_LABEL}=${MANAGED_VALUE}`,
          BWA_DOCKER_NETWORK,
        ]);
      } catch {
        // A concurrent daemon may have created the same fixed network.
      }
      inspection = await this.#inspectNetwork();
    }
    validateNetworkInspection(inspection);
  }

  async resolve(
    containerName: string,
    runtimeIdentity: string,
  ): Promise<BwaRuntimeEndpoint> {
    if (
      !/^biunivers-run-[0-9a-f]{32}$/.test(containerName) ||
      !/^[0-9a-f]{12,64}$/.test(runtimeIdentity)
    ) {
      throw new Error("BWA endpoint identity is invalid.");
    }
    const result = await this.#execute(["container", "inspect", containerName]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      throw invalid("Docker container endpoint inspection returned invalid JSON.", error);
    }
    if (!Array.isArray(parsed) || parsed.length !== 1) {
      throw invalid("Docker container endpoint inspection returned an unexpected result.");
    }
    const container = record(parsed[0]);
    const state = record(container.State);
    const networkSettings = record(container.NetworkSettings);
    const networks = record(networkSettings.Networks);
    const network = record(networks[BWA_DOCKER_NETWORK]);
    const address = network.IPAddress;
    if (
      typeof container.Id !== "string" ||
      container.Id !== runtimeIdentity ||
      state.Running !== true ||
      state.Paused !== false ||
      typeof address !== "string" ||
      isIP(address) === 0
    ) {
      throw invalid("Docker BWA endpoint identity or state is invalid.");
    }
    return { address, port: 8080, runtimeIdentity };
  }

  async #inspectNetwork(): Promise<unknown> {
    const result = await this.#execute(["network", "inspect", BWA_DOCKER_NETWORK]);
    try {
      return JSON.parse(result.stdout);
    } catch (error) {
      throw invalid("Docker network inspect returned invalid JSON.", error);
    }
  }

  async #execute(arguments_: readonly string[]) {
    try {
      return await this.#executor.execute("docker", arguments_, {
        timeoutMs: 30_000,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      });
    } catch (error) {
      throw new DockerOciError(
        "OCI_COMMAND_FAILED",
        `Docker BWA network ${arguments_[1] ?? "operation"} failed.`,
        { cause: error },
      );
    }
  }
}

function validateNetworkInspection(value: unknown): void {
  if (!Array.isArray(value) || value.length !== 1) {
    throw invalid("Docker BWA network inspection is invalid.");
  }
  const network = record(value[0]);
  const labels = record(network.Labels);
  if (
    network.Name !== BWA_DOCKER_NETWORK ||
    network.Driver !== "bridge" ||
    network.Internal !== false ||
    labels[MANAGED_LABEL] !== MANAGED_VALUE
  ) {
    throw invalid("Existing Docker BWA network is not the managed bridge.");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("Docker BWA network output contains an invalid object.");
  }
  return value as Record<string, unknown>;
}

function invalid(message: string, cause?: unknown): DockerOciError {
  return new DockerOciError("OCI_OUTPUT_INVALID", message, { cause });
}
