import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputeRuntimeServer } from "./computeRuntimeServer.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("ComputeRuntimeServer", () => {
  it("exposes only authenticated exact narrow operations on a private Unix socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "biunivers-runtime-server-"));
    roots.push(root);
    const socketPath = join(root, "runtime.sock");
    const tokenHex = "11".repeat(32);
    const runtime = {
      prepare: vi.fn().mockResolvedValue({ state: "PREPARED" }),
      start: vi.fn().mockResolvedValue({ state: "RUNNING" }),
      inspect: vi.fn().mockResolvedValue({ manifest: { state: "RUNNING" } }),
      stop: vi.fn().mockResolvedValue({ state: "STOPPED" }),
    };
    const server = new ComputeRuntimeServer({
      socketPath,
      authenticationTokenHex: tokenHex,
      runtime,
    });
    await server.listen();
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);

    const prepared = await exchange(socketPath, {
      tokenHex,
      operation: "prepare",
      input: {
        runIdHex: "22".repeat(16),
        workspaceIdHex: "33".repeat(16),
        inputHeadFidHex: "44".repeat(16),
        revision: 0,
        executorId: "system.diagnostic",
        capabilityHex: "55".repeat(32),
      },
    });
    expect(prepared).toEqual({ ok: true, result: { state: "PREPARED" } });
    expect(runtime.prepare).toHaveBeenCalledOnce();

    expect(
      await exchange(socketPath, {
        tokenHex,
        operation: "start",
        runIdHex: "22".repeat(16),
      }),
    ).toEqual({ ok: true, result: { state: "RUNNING" } });
    expect(runtime.start).toHaveBeenCalledWith("22".repeat(16));

    const denied = await exchange(socketPath, {
      tokenHex: "99".repeat(32),
      operation: "inspect",
      runIdHex: "22".repeat(16),
    });
    expect(denied).toMatchObject({ ok: false });
    expect(runtime.inspect).not.toHaveBeenCalled();

    const expanded = await exchange(socketPath, {
      tokenHex,
      operation: "start",
      runIdHex: "22".repeat(16),
      image: "caller-controlled",
    });
    expect(expanded).toEqual({
      ok: false,
      error: "Runtime request is invalid.",
    });
    expect(runtime.start).toHaveBeenCalledTimes(1);
    await server.close();
  });

  it("does not replace a non-socket path", async () => {
    const root = await mkdtemp(join(tmpdir(), "biunivers-runtime-file-"));
    roots.push(root);
    const socketPath = join(root, "runtime.sock");
    await writeFile(socketPath, "preserve me");
    const runtime = {
      prepare: vi.fn(),
      start: vi.fn(),
      inspect: vi.fn(),
      stop: vi.fn(),
    };
    const server = new ComputeRuntimeServer({
      socketPath,
      authenticationTokenHex: "11".repeat(32),
      runtime,
    });

    await expect(server.listen()).rejects.toThrow("not a Unix socket");
  });
});

async function exchange(
  socketPath: string,
  value: unknown,
): Promise<Record<string, unknown>> {
  const payload = Buffer.from(JSON.stringify(value));
  const request = Buffer.allocUnsafe(4 + payload.byteLength);
  request.writeUInt32BE(payload.byteLength, 0);
  payload.copy(request, 4);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.on("connect", () => socket.end(request));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", resolve);
    socket.on("error", reject);
  });
  const response = Buffer.concat(chunks);
  expect(response.readUInt32BE(0)).toBe(response.byteLength - 4);
  return JSON.parse(response.subarray(4).toString("utf8"));
}
