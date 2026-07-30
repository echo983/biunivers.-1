import { timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { ComputeRuntimeCoordinator } from "./computeRuntimeCoordinator.js";

const MAX_FRAME_BYTES = 64 * 1024;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

type RuntimeExecutor = Pick<
  ComputeRuntimeCoordinator,
  "prepare" | "start" | "inspect" | "freeze" | "thaw" | "stop" | "destroy"
>;

export class ComputeRuntimeServer {
  readonly #socketPath: string;
  readonly #token: Buffer;
  readonly #runtime: RuntimeExecutor;
  #server?: Server;

  constructor(options: {
    socketPath: string;
    authenticationTokenHex: string;
    runtime: RuntimeExecutor;
  }) {
    if (
      !options.socketPath.startsWith("/") ||
      !TOKEN_PATTERN.test(options.authenticationTokenHex)
    ) {
      throw new Error("Compute Runtime server configuration is invalid.");
    }
    this.#socketPath = options.socketPath;
    this.#token = Buffer.from(options.authenticationTokenHex, "hex");
    this.#runtime = options.runtime;
  }

  async listen(): Promise<void> {
    await mkdir(dirname(this.#socketPath), { recursive: true, mode: 0o700 });
    await removeStaleSocket(this.#socketPath);
    this.#server = createServer({ allowHalfOpen: true }, (socket) =>
      this.#accept(socket),
    );
    await new Promise<void>((resolve, reject) => {
      const server = this.#server!;
      server.once("error", reject);
      server.listen(this.#socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(this.#socketPath, 0o600);
  }

  async close(): Promise<void> {
    if (this.#server) {
      const server = this.#server;
      this.#server = undefined;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await rm(this.#socketPath, { force: true });
  }

  #accept(socket: Socket): void {
    const chunks: Buffer[] = [];
    let total = 0;
    socket.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_FRAME_BYTES + 4) {
        socket.destroy();
        return;
      }
      chunks.push(chunk);
    });
    socket.on("end", () => {
      void this.#respond(socket, Buffer.concat(chunks));
    });
    socket.on("error", () => undefined);
  }

  async #respond(socket: Socket, frame: Buffer): Promise<void> {
    try {
      if (frame.byteLength < 4) throw new Error("Runtime frame is truncated.");
      const length = frame.readUInt32BE(0);
      const payload = frame.subarray(4);
      if (
        length !== payload.byteLength ||
        length === 0 ||
        length > MAX_FRAME_BYTES
      ) {
        throw new Error("Runtime frame length is invalid.");
      }
      const request = parseRequest(JSON.parse(payload.toString("utf8")));
      const suppliedToken = Buffer.from(request.tokenHex, "hex");
      if (!timingSafeEqual(suppliedToken, this.#token)) {
        throw new Error("Runtime authentication failed.");
      }
      let result: unknown;
      if (request.operation === "prepare") {
        result = await this.#runtime.prepare(request.input);
      } else if (request.operation === "start") {
        result = await this.#runtime.start(request.runIdHex);
      } else if (request.operation === "inspect") {
        result = await this.#runtime.inspect(request.runIdHex);
      } else if (request.operation === "freeze") {
        result = await this.#runtime.freeze(request.runIdHex);
      } else if (request.operation === "thaw") {
        result = await this.#runtime.thaw(request.runIdHex);
      } else if (request.operation === "destroy") {
        result = await this.#runtime.destroy(
          request.runIdHex,
          request.preserveUpper,
        );
      } else {
        result = await this.#runtime.stop(request.runIdHex);
      }
      socket.end(encodeFrame({ ok: true, result }));
    } catch (error) {
      socket.end(
        encodeFrame({
          ok: false,
          error: error instanceof Error ? error.message : "Runtime error.",
        }),
      );
    }
  }
}

type RuntimeRequest =
  | {
      tokenHex: string;
      operation: "prepare";
      input: {
        runIdHex: string;
        workspaceIdHex: string;
        inputHeadFidHex: string;
        revision: number;
        executorId: string;
        capabilityHex: string;
      };
    }
  | {
      tokenHex: string;
      operation: "start" | "inspect" | "freeze" | "thaw" | "stop";
      runIdHex: string;
    }
  | {
      tokenHex: string;
      operation: "destroy";
      runIdHex: string;
      preserveUpper: boolean;
    };

function parseRequest(value: unknown): RuntimeRequest {
  if (!value || typeof value !== "object") throw invalidRequest();
  const request = value as Record<string, unknown>;
  if (
    typeof request.tokenHex !== "string" ||
    !TOKEN_PATTERN.test(request.tokenHex)
  ) {
    throw invalidRequest();
  }
  if (request.operation === "prepare") {
    requireExactKeys(request, ["tokenHex", "operation", "input"]);
    if (!request.input || typeof request.input !== "object") {
      throw invalidRequest();
    }
    const input = request.input as Record<string, unknown>;
    requireExactKeys(input, [
      "runIdHex",
      "workspaceIdHex",
      "inputHeadFidHex",
      "revision",
      "executorId",
      "capabilityHex",
    ]);
    if (
      typeof input.runIdHex !== "string" ||
      typeof input.workspaceIdHex !== "string" ||
      typeof input.inputHeadFidHex !== "string" ||
      !Number.isSafeInteger(input.revision) ||
      typeof input.executorId !== "string" ||
      typeof input.capabilityHex !== "string"
    ) {
      throw invalidRequest();
    }
    return {
      tokenHex: request.tokenHex,
      operation: "prepare",
      input: {
        runIdHex: input.runIdHex,
        workspaceIdHex: input.workspaceIdHex,
        inputHeadFidHex: input.inputHeadFidHex,
        revision: input.revision as number,
        executorId: input.executorId,
        capabilityHex: input.capabilityHex,
      },
    };
  }
  if (request.operation === "destroy") {
    requireExactKeys(request, [
      "tokenHex",
      "operation",
      "runIdHex",
      "preserveUpper",
    ]);
    if (
      typeof request.runIdHex !== "string" ||
      typeof request.preserveUpper !== "boolean"
    ) {
      throw invalidRequest();
    }
    return request as RuntimeRequest;
  }
  if (
    !["start", "inspect", "freeze", "thaw", "stop"].includes(
      request.operation as string,
    ) ||
    typeof request.runIdHex !== "string"
  ) {
    throw invalidRequest();
  }
  requireExactKeys(request, ["tokenHex", "operation", "runIdHex"]);
  return request as RuntimeRequest;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw invalidRequest();
  }
}

function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

function invalidRequest(): Error {
  return new Error("Runtime request is invalid.");
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    const status = await lstat(socketPath);
    if (!status.isSocket()) {
      throw new Error(
        "Compute Runtime socket path exists and is not a Unix socket.",
      );
    }
    await rm(socketPath);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}
