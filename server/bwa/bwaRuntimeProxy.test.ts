import type { AddressInfo } from "node:net";
import http from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqliteRefStore } from "../files/sqliteRefStore.js";
import { BwaBrowserSessionRegistry } from "./bwaBrowserSessionRegistry.js";
import { bwaOriginLabel } from "./bwaOrigin.js";
import { createBwaRuntimeProxy } from "./bwaRuntimeProxy.js";

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
});

async function startProxy(
  sessions: BwaBrowserSessionRegistry,
  runState: "RUNNING" | "STOPPED",
  runtime = { resolveBwaEndpoint: vi.fn() },
): Promise<http.Server> {
  const refStore = {
    listBwaApplications: () => [{ applicationId: "ghcr.io/echo983/diagnostic", enabled: true }],
    listBwaInstances: () => [{ instanceIdHex }],
    listBwaRunBindings: () => [{ run: { runIdHex, state: runState } }],
  } as unknown as SqliteRefStore;
  const app = express();
  app.use(createBwaRuntimeProxy({ appOrigin, refStore, sessions, runtime }));
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
