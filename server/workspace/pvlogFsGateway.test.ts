import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodePvlogFsReadRequest,
  PvlogFsGateway,
} from "./pvlogFsGateway.js";
import type { WorkspaceContentReader } from "./workspaceContentReader.js";
import type { WorkspaceSnapshotProvider } from "./workspaceSnapshotProvider.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("PvlogFsGateway", () => {
  it("publishes a private fixed snapshot and serves capability-bound framed reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "biunivers-pvlog-gateway-"));
    roots.push(root);
    const socketPath = join(root, "gateway.sock");
    const snapshotPath = join(root, "snapshot.json");
    const fileId = "22".repeat(16);
    const read = vi.fn().mockResolvedValue(Buffer.from("payload"));
    const gateway = await PvlogFsGateway.create({
      workspaceIdHex: "33".repeat(16),
      socketPath,
      snapshotPath,
      randomCapability: () => new Uint8Array(32).fill(0x44),
      snapshotProvider: {
        capture: vi.fn().mockResolvedValue({
          workspaceIdHex: "33".repeat(16),
          refId: `ws-${"33".repeat(16)}`,
          lineageIdHex: "55".repeat(16),
          headFidHex: "66".repeat(16),
          revision: 0,
          rootEntryIdHex: "11".repeat(16),
          rootInode: 1,
          indexLoadMs: 1,
          entries: [
            {
              inode: 1,
              parentInode: null,
              entryIdHex: "11".repeat(16),
              name: "",
              kind: "directory",
              createdAtMs: 1,
              mtimeMs: 1,
            },
            {
              inode: 2,
              parentInode: 1,
              entryIdHex: fileId,
              name: "note.txt",
              kind: "file",
              createdAtMs: 1,
              mtimeMs: 1,
              content: {
                kind: "chunk",
                fidHex: "77".repeat(16),
                size: 7,
              },
            },
          ],
        }),
      } as unknown as WorkspaceSnapshotProvider,
      contentReader: { read } as unknown as WorkspaceContentReader,
    });
    await gateway.listen();

    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(snapshotPath, "utf8"))).toMatchObject({
      rootInode: 1,
      entries: [
        { inode: 1, size: 0 },
        { inode: 2, name: "note.txt", size: 7 },
      ],
    });
    const response = await exchange(
      socketPath,
      encodePvlogFsReadRequest({
        capabilityHex: gateway.capabilityHex,
        entryIdHex: fileId,
        offset: 2,
        size: 5,
      }),
    );
    expect(response.status).toBe(0);
    expect(response.body.toString()).toBe("payload");
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ fidHex: "77".repeat(16) }),
      2,
      5,
    );

    const denied = await exchange(
      socketPath,
      encodePvlogFsReadRequest({
        capabilityHex: "88".repeat(32),
        entryIdHex: fileId,
        offset: 0,
        size: 1,
      }),
    );
    expect(denied.status).toBe(1);
    expect(denied.body.toString()).toContain("capability");
    expect(gateway.metrics()).toEqual({
      readRequests: 1,
      bytesRead: 7,
      rejectedRequests: 1,
    });
    await gateway.close();
  });
});

async function exchange(
  socketPath: string,
  request: Uint8Array,
): Promise<{ status: number; body: Buffer }> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.on("connect", () => {
      socket.end(request);
    });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", resolve);
    socket.on("error", reject);
  });
  const frame = Buffer.concat(chunks);
  expect(frame.readUInt32BE(0)).toBe(frame.byteLength - 4);
  return { status: frame[4], body: frame.subarray(5) };
}
