import type { AddressInfo } from "node:net";
import http from "node:http";
import { Duplex } from "node:stream";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqliteRefStore } from "../files/sqliteRefStore.js";
import { BwaBrowserSessionRegistry } from "./bwaBrowserSessionRegistry.js";
import { bwaOriginLabel } from "./bwaOrigin.js";
import {
  createBwaRuntimeProxy,
  createBwaWebSocketProxy,
} from "./bwaRuntimeProxy.js";

const instanceIdHex = "11".repeat(16);
const runIdHex = "22".repeat(16);
const appOrigin = "http://localhost:8081";
const instanceHost = `${bwaOriginLabel(instanceIdHex)}.localhost:8081`;
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
});

describe("BWA Runtime Proxy", () => {
  it("exchanges a one-time bootstrap ticket for an Instance-bound HttpOnly cookie", async () => {
    const sessions = new BwaBrowserSessionRegistry({
      random: (bytes) => Buffer.alloc(bytes, 7),
    });
    const server = await startProxy(sessions, "STOPPED");
    const ticket = sessions.issueBootstrap(instanceIdHex).ticket;

    const bootstrap = await request(server, {
      host: instanceHost,
      path: `/__biunivers/bootstrap?t=${ticket}`,
      accept: "text/html",
    });
    expect(bootstrap.status).toBe(303);
    expect(bootstrap.headers.location).toBe("/");
    expect(bootstrap.headers["set-cookie"]?.[0]).toMatch(
      /^biunivers-bwa-session=.+; Path=\/; HttpOnly; SameSite=Strict$/,
    );

    const replay = await request(server, {
      host: instanceHost,
      path: `/__biunivers/bootstrap?t=${ticket}`,
      accept: "application/json",
    });
    expect(replay.status).toBe(401);
    expect(JSON.parse(replay.body).error.code).toBe("BWA_BOOTSTRAP_INVALID");
  });

  it("rejects absent and cross-Instance sessions before resolving an endpoint", async () => {
    const sessions = new BwaBrowserSessionRegistry();
    const runtime = { resolveBwaEndpoint: vi.fn() };
    const server = await startProxy(sessions, "RUNNING", runtime);

    const absent = await request(server, {
      host: instanceHost,
      path: "/api/state",
      accept: "application/json",
    });
    expect(absent.status).toBe(401);
    expect(JSON.parse(absent.body).error.code).toBe("BWA_SESSION_INVALID");

    const otherInstance = "33".repeat(16);
    const otherTicket = sessions.issueBootstrap(otherInstance);
    const otherSession = sessions.consumeBootstrap(
      otherInstance,
      otherTicket.ticket,
    ).session;
    const crossed = await request(server, {
      host: instanceHost,
      path: "/api/state",
      accept: "application/json",
      cookie: `biunivers-bwa-session=${otherSession}`,
    });
    expect(crossed.status).toBe(401);
    expect(runtime.resolveBwaEndpoint).not.toHaveBeenCalled();
  });

  it("returns an explicit stopped response for an authorized Instance without a running Run", async () => {
    const sessions = new BwaBrowserSessionRegistry();
    const runtime = { resolveBwaEndpoint: vi.fn() };
    const server = await startProxy(sessions, "STOPPED", runtime);
    const ticket = sessions.issueBootstrap(instanceIdHex);
    const session = sessions.consumeBootstrap(instanceIdHex, ticket.ticket).session;

    const stopped = await request(server, {
      host: instanceHost,
      path: "/",
      accept: "application/json",
      cookie: `biunivers-bwa-session=${session}`,
    });
    expect(stopped.status).toBe(503);
    expect(JSON.parse(stopped.body).error.code).toBe("BWA_STOPPED");
    expect(runtime.resolveBwaEndpoint).not.toHaveBeenCalled();
  });

  it("authorizes and forwards a WebSocket upgrade without exposing the host session cookie", async () => {
    const sessions = new BwaBrowserSessionRegistry();
    const ticket = sessions.issueBootstrap(instanceIdHex);
    const session = sessions.consumeBootstrap(instanceIdHex, ticket.ticket).session;
    const runtime = {
      resolveBwaEndpoint: vi.fn().mockResolvedValue({ address: "172.30.0.9", port: 8080 }),
    };
    const upstream = new CapturingSocket();
    const client = new CapturingSocket();
    const handler = createBwaWebSocketProxy({
      appOrigin,
      refStore: fakeRefStore("RUNNING"),
      sessions,
      runtime,
      connect: () => upstream as never,
    });
    handler(
      {
        method: "GET",
        url: "/socket?channel=one",
        headers: {
          host: instanceHost,
          connection: "Upgrade",
          upgrade: "websocket",
          cookie: `biunivers-bwa-session=${session}; application=value`,
          "sec-websocket-key": "fixture",
          "sec-websocket-version": "13",
        },
      } as http.IncomingMessage,
      client as never,
      Buffer.from("head"),
    );
    await vi.waitFor(() => expect(runtime.resolveBwaEndpoint).toHaveBeenCalledWith(runIdHex));
    upstream.emit("connect");
    await vi.waitFor(() => expect(upstream.text()).toContain("head"));

    expect(upstream.text()).toContain("GET /socket?channel=one HTTP/1.1");
    expect(upstream.text()).toContain("cookie: application=value");
    expect(upstream.text()).not.toContain(session);
    expect(upstream.text()).toContain("x-forwarded-proto: http");
    client.destroy();
    upstream.destroy();
  });
});

class CapturingSocket extends Duplex {
  readonly chunks: Buffer[] = [];

  override _read(): void {}

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function fakeRefStore(runState: "RUNNING" | "STOPPED"): SqliteRefStore {
  return {
    listBwaApplications: () => [
      { applicationId: "ghcr.io/echo983/diagnostic", enabled: true },
    ],
    listBwaInstances: () => [{ instanceIdHex }],
    listBwaRunBindings: () => [{ run: { runIdHex, state: runState } }],
  } as unknown as SqliteRefStore;
}

async function startProxy(
  sessions: BwaBrowserSessionRegistry,
  runState: "RUNNING" | "STOPPED",
  runtime = { resolveBwaEndpoint: vi.fn() },
): Promise<http.Server> {
  const app = express();
  app.use(
    createBwaRuntimeProxy({
      appOrigin,
      refStore: fakeRefStore(runState),
      sessions,
      runtime,
    }),
  );
  app.use((_request, response) => response.status(404).end());
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return server;
}

async function request(
  server: http.Server,
  input: {
    host: string;
    path: string;
    accept: string;
    cookie?: string;
  },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const address = server.address() as AddressInfo;
  return await new Promise((resolve, reject) => {
    const outbound = http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        path: input.path,
        headers: {
          Host: input.host,
          Accept: input.accept,
          ...(input.cookie ? { Cookie: input.cookie } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outbound.on("error", reject);
    outbound.end();
  });
}
