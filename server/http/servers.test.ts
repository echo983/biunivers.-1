// @vitest-environment node

import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppStore } from "../apps/appStore.js";
import type { ServerConfig } from "../config.js";
import { FileCapabilityRegistry } from "../files/fileCapabilityRegistry.js";
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

    const fileService = await fetch(
      `${origin}/api/v1/admin/file-service`,
      {
        headers: {
          authorization: `Bearer ${dependencies.config.adminToken}`,
        },
      },
    );
    await expect(fileService.json()).resolves.toEqual({
      mode: "disabled",
      writable: false,
    });

    const unavailableBackup = await fetch(
      `${origin}/api/v1/admin/file-service/backups`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${dependencies.config.adminToken}`,
        },
      },
    );
    expect(unavailableBackup.status).toBe(503);
    await expect(unavailableBackup.json()).resolves.toMatchObject({
      error: { code: "HOST_API_UNSUPPORTED" },
    });
  });

  it("creates a controlled File Service backup through the admin endpoint", async () => {
    const dependencies = await createDependencies();
    const result = {
      createdAt: "2026-07-29T12:00:00.000Z",
      revision: 3,
      rootEntryIdHex: "11".repeat(16),
      size: 24_576,
      fileName: "latest.sqlite",
    };
    const origin = await listen(
      createDesktopServer({
        ...dependencies,
        fileServiceBackup: {
          createLatest: async () => result,
        },
      }).listen(0, "127.0.0.1"),
    );

    const unauthorized = await fetch(
      `${origin}/api/v1/admin/file-service/backups`,
      { method: "POST" },
    );
    expect(unauthorized.status).toBe(401);

    const created = await fetch(
      `${origin}/api/v1/admin/file-service/backups`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${dependencies.config.adminToken}`,
        },
      },
    );
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    await expect(created.json()).resolves.toEqual(result);
  });

  it("bootstraps file instances only for the trusted desktop and active apps", async () => {
    const dependencies = await createDependencies();
    await dependencies.appStore.write({
      schemaVersion: 1,
      apps: [
        {
          appId: "io.example.notes",
          repository: "https://github.com/example/notes",
          requestedRef: "main",
          commitSha: "01".repeat(20),
          version: "1.0.0",
          protocol: "biunivers.static-app/1",
          manifest: {
            appId: "io.example.notes",
            name: "Notes",
            version: "1.0.0",
            protocol: "biunivers.static-app/1",
            entry: "index.html",
            window: {
              defaultWidth: 800,
              defaultHeight: 600,
            },
          },
          configuration: {},
          status: "active",
          installedAt: "2026-07-29T00:00:00.000Z",
          updatedAt: "2026-07-29T00:00:00.000Z",
        },
      ],
    });
    const origin = await listen(
      createDesktopServer({
        ...dependencies,
        fileServiceStatus: {
          mode: "ready",
          writable: true,
          revision: 0,
          rootEntryIdHex: "11".repeat(16),
        },
        fileCapabilities: new FileCapabilityRegistry(),
      }).listen(0, "127.0.0.1"),
    );
    const body = JSON.stringify({
      appId: "io.example.notes",
      windowInstanceId: "window-1",
    });

    const forbidden = await fetch(`${origin}/api/v1/host/instances`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body,
    });
    expect(forbidden.status).toBe(403);

    const created = await fetch(`${origin}/api/v1/host/instances`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: dependencies.config.desktopOrigin,
        "sec-fetch-site": "same-origin",
      },
      body,
    });
    expect(created.status).toBe(201);
    const instance = (await created.json()) as {
      instanceToken: string;
      expiresAt: string;
    };
    expect(instance.instanceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Number.isNaN(Date.parse(instance.expiresAt))).toBe(false);

    const closed = await fetch(
      `${origin}/api/v1/host/instances/current`,
      {
        method: "DELETE",
        headers: {
          origin: dependencies.config.desktopOrigin,
          "sec-fetch-site": "same-origin",
          authorization: `Biunivers-Instance ${instance.instanceToken}`,
        },
      },
    );
    expect(closed.status).toBe(204);
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
