import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { FileContentRef } from "../files/fileContentStore.js";
import { WorkspaceContentReader } from "./workspaceContentReader.js";
import {
  WorkspaceSnapshotProvider,
  type WorkspaceSnapshot,
} from "./workspaceSnapshotProvider.js";

const PROTOCOL_VERSION = 1;
const OP_READ = 1;
const MAX_FRAME_BYTES = 1024 * 1024 + 128;
const READ_REQUEST_BYTES = 1 + 1 + 32 + 16 + 8 + 4;

export interface PvlogFsGatewayMetrics {
  readRequests: number;
  bytesRead: number;
  rejectedRequests: number;
}

export class PvlogFsGateway {
  readonly snapshot: WorkspaceSnapshot;
  readonly capabilityHex: string;
  readonly #capability: Buffer;
  readonly #socketPath: string;
  readonly #snapshotPath: string;
  readonly #contentReader: WorkspaceContentReader;
  readonly #contentByEntryId = new Map<string, FileContentRef>();
  readonly #metrics: PvlogFsGatewayMetrics = {
    readRequests: 0,
    bytesRead: 0,
    rejectedRequests: 0,
  };
  #server?: Server;

  private constructor(options: {
    snapshot: WorkspaceSnapshot;
    socketPath: string;
    snapshotPath: string;
    contentReader: WorkspaceContentReader;
    capability: Uint8Array;
  }) {
    this.snapshot = options.snapshot;
    this.#socketPath = options.socketPath;
    this.#snapshotPath = options.snapshotPath;
    this.#contentReader = options.contentReader;
    this.#capability = Buffer.from(options.capability);
    if (
      this.#capability.byteLength !== 32 ||
      this.#capability.every((byte) => byte === 0)
    ) {
      throw new Error("PVLogFS capability must be a random 256-bit value.");
    }
    this.capabilityHex = this.#capability.toString("hex");
    for (const entry of this.snapshot.entries) {
      if (entry.content) {
        this.#contentByEntryId.set(entry.entryIdHex, entry.content);
      }
    }
  }

  static async create(options: {
    workspaceIdHex: string;
    snapshotProvider: WorkspaceSnapshotProvider;
    contentReader: WorkspaceContentReader;
    socketPath: string;
    snapshotPath: string;
    randomCapability?: () => Uint8Array;
  }): Promise<PvlogFsGateway> {
    const snapshot = await options.snapshotProvider.capture(
      options.workspaceIdHex,
    );
    return new PvlogFsGateway({
      ...options,
      snapshot,
      capability:
        options.randomCapability?.() ?? randomBytes(32),
    });
  }

  async listen(): Promise<void> {
    await mkdir(dirname(this.#socketPath), { recursive: true, mode: 0o700 });
    await mkdir(dirname(this.#snapshotPath), { recursive: true, mode: 0o700 });
    await Promise.all([
      rm(this.#socketPath, { force: true }),
      rm(this.#snapshotPath, { force: true }),
    ]);
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
    await writeSnapshotAtomically(this.#snapshotPath, {
      workspaceIdHex: this.snapshot.workspaceIdHex,
      headFidHex: this.snapshot.headFidHex,
      revision: this.snapshot.revision,
      rootInode: this.snapshot.rootInode,
      entries: this.snapshot.entries.map((entry) => ({
        inode: entry.inode,
        parentInode: entry.parentInode,
        entryIdHex: entry.entryIdHex,
        name: entry.name,
        kind: entry.kind,
        size: entry.content?.size ?? 0,
        mtimeMs: entry.mtimeMs,
      })),
    });
  }

  metrics(): PvlogFsGatewayMetrics {
    return { ...this.#metrics };
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
        this.#metrics.rejectedRequests += 1;
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
      if (frame.byteLength < 4) throw new Error("Request frame is truncated.");
      const length = frame.readUInt32BE(0);
      const payload = frame.subarray(4);
      if (length !== payload.byteLength || length !== READ_REQUEST_BYTES) {
        throw new Error("Request frame length is invalid.");
      }
      if (payload[0] !== PROTOCOL_VERSION || payload[1] !== OP_READ) {
        throw new Error("Request version or operation is unsupported.");
      }
      const capability = payload.subarray(2, 34);
      if (!timingSafeEqual(capability, this.#capability)) {
        throw new Error("Request capability is invalid.");
      }
      const entryIdHex = payload.subarray(34, 50).toString("hex");
      const offset = Number(payload.readBigUInt64BE(50));
      const size = payload.readUInt32BE(58);
      if (!Number.isSafeInteger(offset)) {
        throw new Error("Request offset exceeds the safe range.");
      }
      const content = this.#contentByEntryId.get(entryIdHex);
      if (!content) throw new Error("Requested Entry is not a snapshot file.");
      const bytes = await this.#contentReader.read(content, offset, size);
      this.#metrics.readRequests += 1;
      this.#metrics.bytesRead += bytes.byteLength;
      socket.end(responseFrame(0, bytes));
    } catch (error) {
      this.#metrics.rejectedRequests += 1;
      socket.end(
        responseFrame(
          1,
          Buffer.from(
            error instanceof Error ? error.message : "PVLogFS gateway error.",
          ),
        ),
      );
    }
  }
}

export function encodePvlogFsReadRequest(input: {
  capabilityHex: string;
  entryIdHex: string;
  offset: number;
  size: number;
}): Buffer {
  if (
    !/^[0-9a-f]{64}$/.test(input.capabilityHex) ||
    !/^[0-9a-f]{32}$/.test(input.entryIdHex) ||
    !Number.isSafeInteger(input.offset) ||
    input.offset < 0 ||
    !Number.isSafeInteger(input.size) ||
    input.size < 0 ||
    input.size > 1024 * 1024
  ) {
    throw new Error("PVLogFS read request is invalid.");
  }
  const payload = Buffer.alloc(READ_REQUEST_BYTES);
  payload[0] = PROTOCOL_VERSION;
  payload[1] = OP_READ;
  Buffer.from(input.capabilityHex, "hex").copy(payload, 2);
  Buffer.from(input.entryIdHex, "hex").copy(payload, 34);
  payload.writeBigUInt64BE(BigInt(input.offset), 50);
  payload.writeUInt32BE(input.size, 58);
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

function responseFrame(status: number, body: Uint8Array): Buffer {
  const frame = Buffer.allocUnsafe(5 + body.byteLength);
  frame.writeUInt32BE(1 + body.byteLength, 0);
  frame[4] = status;
  Buffer.from(body).copy(frame, 5);
  return frame;
}

async function writeSnapshotAtomically(
  path: string,
  value: unknown,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
