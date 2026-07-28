// @vitest-environment node

import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppStore } from "../apps/appStore.js";
import type { ServerConfig } from "../config.js";
import { createAppServer } from "./appServer.js";
import { createDesktopServer } from "./desktopServer.js";

const servers: Server[] = [];
const temporaryDirectories: string[] = [];

async function listen(server: Server) {
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not bind a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function createDependencies() {
  const directory = await mkdtemp(join(tmpdir(), "biunivers-http-"));
  temporaryDirectories.push(directory);
  const clientDir = join(directory, "client");
  const store = new AppStore(join(directory, "data"));
  await store.initialize();
  await mkdir(clientDir, { recursive: true });
  await writeFile(join(clientDir, "index.html"), "<h1>Biunivers</h1>");

  const config: ServerConfig = {
    adminToken: "a-secure-token-value",
    dataDir: store.dataDir,
    desktopPort: 8080,
    appPort: 8081,
    desktopOrigin: "http://localhost:8080",
    appOrigin: "http://localhost:8081",
    maxAppBytes: 100 * 1024 * 1024,
    maxAppFiles: 5_000,
  };

  return { config, appStore: store, clientDir };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("desktop and app origins", () => {
  it("serves the desktop, health and an empty public app registry", async () => {
    const dependencies = await createDependencies();
    const origin = await listen(
      createDesktopServer(dependencies).listen(0, "127.0.0.1"),
    );

    await expect(fetch(`${origin}/health`).then((response) => response.json()))
      .resolves.toEqual({ status: "ok" });
    await expect(
      fetch(`${origin}/api/v1/apps`).then((response) => response.json()),
    ).resolves.toEqual({ apps: [] });
    await expect(fetch(origin).then((response) => response.text())).resolves
      .toContain("Biunivers");
  });

  it("requires the admin bearer token", async () => {
    const dependencies = await createDependencies();
    const origin = await listen(
      createDesktopServer(dependencies).listen(0, "127.0.0.1"),
    );

    const unauthorized = await fetch(`${origin}/api/v1/admin/apps`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${origin}/api/v1/admin/apps`, {
      headers: {
        authorization: `Bearer ${dependencies.config.adminToken}`,
      },
    });
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toEqual({
      schemaVersion: 1,
      apps: [],
    });
  });

  it("does not expose desktop or admin routes on the app origin", async () => {
    const origin = await listen(
      createAppServer().listen(0, "127.0.0.1"),
    );

    expect((await fetch(`${origin}/api/v1/admin/apps`)).status).toBe(404);
    expect((await fetch(origin)).status).toBe(404);
    expect((await fetch(`${origin}/health`)).status).toBe(200);
  });
});
