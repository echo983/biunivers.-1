import { createConnection } from "node:net";

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const MAX_FRAME_BYTES = 512 * 1024;

export interface BwaRuntimeClient {
  prepareBwa(input: {
    runIdHex: string;
    workspaceIdHex: string;
    inputHeadFidHex: string;
    revision: number;
    capabilityHex: string;
    imageReference: string;
    environment: Record<string, string>;
  }): Promise<unknown>;
  start(runIdHex: string): Promise<unknown>;
  inspect(runIdHex: string): Promise<unknown>;
  logs(runIdHex: string): Promise<unknown>;
  resolveBwaEndpoint(runIdHex: string): Promise<unknown>;
  stop(runIdHex: string): Promise<unknown>;
  finalizeExited(runIdHex: string): Promise<unknown>;
  reopenFailed(runIdHex: string): Promise<unknown>;
  commit(runIdHex: string): Promise<unknown>;
  destroy(runIdHex: string, preserveUpper: boolean): Promise<unknown>;
}

export class ComputeRuntimeLifecycleClient implements BwaRuntimeClient {
  readonly #socketPath: string;
  readonly #tokenHex: string;

  constructor(options: { socketPath: string; authenticationTokenHex: string }) {
    if (!options.socketPath.startsWith("/") || !TOKEN_PATTERN.test(options.authenticationTokenHex)) {
      throw new Error("Compute Runtime Lifecycle client configuration is invalid.");
    }
    this.#socketPath = options.socketPath;
    this.#tokenHex = options.authenticationTokenHex;
  }

  async prepareBwa(input: Parameters<BwaRuntimeClient["prepareBwa"]>[0]) {
    return await this.#exchange({ tokenHex: this.#tokenHex, operation: "prepareBwa", input });
  }

  async start(runIdHex: string) {
    return await this.#run("start", runIdHex);
  }

  async inspect(runIdHex: string) {
    return await this.#run("inspect", runIdHex);
  }

  async logs(runIdHex: string) {
    return await this.#run("logs", runIdHex);
  }

  async resolveBwaEndpoint(runIdHex: string) {
    return await this.#run("resolveBwaEndpoint", runIdHex);
  }

  async stop(runIdHex: string) {
    return await this.#run("stop", runIdHex);
  }

  async finalizeExited(runIdHex: string) {
    return await this.#run("finalizeExited", runIdHex);
  }

  async reopenFailed(runIdHex: string) {
    return await this.#run("reopenFailed", runIdHex);
  }

  async commit(runIdHex: string) {
    return await this.#run("commit", runIdHex);
  }

  async destroy(runIdHex: string, preserveUpper: boolean) {
    return await this.#exchange({
      tokenHex: this.#tokenHex,
      operation: "destroy",
      runIdHex,
      preserveUpper,
    });
  }

  async #run(
    operation:
      | "start"
      | "inspect"
      | "logs"
      | "stop"
      | "commit"
      | "finalizeExited"
      | "reopenFailed"
      | "resolveBwaEndpoint",
    runIdHex: string,
  ) {
    return await this.#exchange({ tokenHex: this.#tokenHex, operation, runIdHex });
  }

  async #exchange(request: Record<string, unknown>): Promise<unknown> {
    const payload = Buffer.from(JSON.stringify(request));
    if (payload.byteLength === 0 || payload.byteLength > MAX_FRAME_BYTES) {
      throw new Error("Runtime Lifecycle request is too large.");
    }
    const frame = Buffer.allocUnsafe(payload.byteLength + 4);
    frame.writeUInt32BE(payload.byteLength, 0);
    payload.copy(frame, 4);
    const chunks: Buffer[] = [];
    let total = 0;
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(this.#socketPath);
      socket.on("connect", () => socket.end(frame));
      socket.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > MAX_FRAME_BYTES + 4) {
          socket.destroy(new Error("Runtime Lifecycle response is too large."));
          return;
        }
        chunks.push(chunk);
      });
      socket.on("end", resolve);
      socket.on("error", reject);
    });
    const response = Buffer.concat(chunks);
    if (response.byteLength < 4 || response.readUInt32BE(0) !== response.byteLength - 4) {
      throw new Error("Runtime Lifecycle response frame is invalid.");
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(response.subarray(4).toString("utf8"));
    } catch (error) {
      throw new Error("Runtime Lifecycle response is invalid.", { cause: error });
    }
    if (!envelope || typeof envelope !== "object") {
      throw new Error("Runtime Lifecycle response is invalid.");
    }
    const value = envelope as Record<string, unknown>;
    if (value.ok !== true) {
      throw new Error(typeof value.error === "string" ? value.error : "Runtime request failed.");
    }
    return value.result;
  }
}
