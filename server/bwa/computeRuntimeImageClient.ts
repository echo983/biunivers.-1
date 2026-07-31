import { createConnection } from "node:net";
import type { BwaImageInspection } from "../computeRuntime/dockerImageAdapter.js";
import type { BwaImageClient } from "./bwaRegistryService.js";

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const MAX_FRAME_BYTES = 1024 * 1024;

export class ComputeRuntimeImageClient implements BwaImageClient {
  readonly #socketPath: string;
  readonly #tokenHex: string;

  constructor(options: { socketPath: string; authenticationTokenHex: string }) {
    if (!options.socketPath.startsWith("/") || !TOKEN_PATTERN.test(options.authenticationTokenHex)) {
      throw new Error("Compute Runtime Image client configuration is invalid.");
    }
    this.#socketPath = options.socketPath;
    this.#tokenHex = options.authenticationTokenHex;
  }

  async pullAndInspect(reference: string): Promise<BwaImageInspection> {
    return await this.#exchange({
      tokenHex: this.#tokenHex,
      operation: "pullAndInspect",
      reference,
    });
  }

  async inspectInstalled(imageReference: string): Promise<BwaImageInspection> {
    return await this.#exchange({
      tokenHex: this.#tokenHex,
      operation: "inspectInstalled",
      imageReference,
    });
  }

  async #exchange(request: Record<string, unknown>): Promise<BwaImageInspection> {
    const payload = Buffer.from(JSON.stringify(request));
    if (payload.byteLength > 64 * 1024) throw new Error("Runtime Image request is too large.");
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
          socket.destroy(new Error("Runtime Image response is too large."));
          return;
        }
        chunks.push(chunk);
      });
      socket.on("end", resolve);
      socket.on("error", reject);
    });
    const response = Buffer.concat(chunks);
    if (response.byteLength < 4 || response.readUInt32BE(0) !== response.byteLength - 4) {
      throw new Error("Runtime Image response frame is invalid.");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(response.subarray(4).toString("utf8"));
    } catch (error) {
      throw new Error("Runtime Image response is invalid.", { cause: error });
    }
    if (!decoded || typeof decoded !== "object") throw new Error("Runtime Image response is invalid.");
    const envelope = decoded as Record<string, unknown>;
    if (envelope.ok !== true) {
      throw new Error(typeof envelope.error === "string" ? envelope.error : "Runtime Image request failed.");
    }
    return envelope.result as BwaImageInspection;
  }
}
