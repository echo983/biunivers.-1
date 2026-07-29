// @vitest-environment node

import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

    const unavailableGc = await fetch(
      `${origin}/api/v1/admin/file-service/gc-reports`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${dependencies.config.adminToken}`,
        },
      },
    );
    expect(unavailableGc.status).toBe(503);
    await expect(unavailableGc.json()).resolves.toMatchObject({
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

  it("protects internal file mutations by desktop origin and instance token", async () => {
    const dependencies = await createDependencies();
    const createDirectory = vi.fn(async () => ({
      entryId: "22".repeat(16),
      revision: 4,
    }));
    const createFile = vi.fn(async () => ({
      entryId: "33".repeat(16),
      revision: 5,
    }));
    const copyFile = vi.fn(async () => ({
      entryId: "44".repeat(16),
      revision: 6,
    }));
    const origin = await listen(
      createDesktopServer({
        ...dependencies,
        internalFileManager: {
          createDirectory,
          createFile,
          copyFile,
          moveEntry: vi.fn(),
          removeEntry: vi.fn(),
        },
      }).listen(0, "127.0.0.1"),
    );
    const body = JSON.stringify({
      parentEntryId: "11".repeat(16),
      name: "Documents",
      expectedRevision: 3,
    });

    const forbidden = await fetch(
      `${origin}/api/v1/internal/files/directories`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.example",
        },
        body,
      },
    );
    expect(forbidden.status).toBe(403);

    const missingToken = await fetch(
      `${origin}/api/v1/internal/files/directories`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: dependencies.config.desktopOrigin,
          "sec-fetch-site": "same-origin",
        },
        body,
      },
    );
    expect(missingToken.status).toBe(401);

    const created = await fetch(
      `${origin}/api/v1/internal/files/directories`,
      {
        method: "POST",
        headers: {
          authorization: `Biunivers-Instance ${"a".repeat(43)}`,
          "content-type": "application/json",
          origin: dependencies.config.desktopOrigin,
          "sec-fetch-site": "same-origin",
        },
        body,
      },
    );
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toEqual({
      entryId: "22".repeat(16),
      revision: 4,
    });
    expect(createDirectory).toHaveBeenCalledWith("a".repeat(43), {
      parentEntryId: "11".repeat(16),
      name: "Documents",
      expectedRevision: 3,
    });

    const createdFile = await fetch(
      `${origin}/api/v1/internal/files/files`,
      {
        method: "POST",
        headers: {
          authorization: `Biunivers-Instance ${"a".repeat(43)}`,
          "content-type": "application/json",
          origin: dependencies.config.desktopOrigin,
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({
          parentEntryId: "11".repeat(16),
          name: "empty.txt",
          expectedRevision: 4,
        }),
      },
    );
    expect(createdFile.status).toBe(201);
    expect(createFile).toHaveBeenCalledWith("a".repeat(43), {
      parentEntryId: "11".repeat(16),
      name: "empty.txt",
      expectedRevision: 4,
    });

    const copied = await fetch(
      `${origin}/api/v1/internal/files/entries/${"33".repeat(16)}/copies`,
      {
        method: "POST",
        headers: {
          authorization: `Biunivers-Instance ${"a".repeat(43)}`,
          "content-type": "application/json",
          origin: dependencies.config.desktopOrigin,
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({
          newParentEntryId: "11".repeat(16),
          newName: "empty - copy.txt",
          expectedRevision: 5,
        }),
      },
    );
    expect(copied.status).toBe(201);
    expect(copyFile).toHaveBeenCalledWith(
      "a".repeat(43),
      "33".repeat(16),
      {
        newParentEntryId: "11".repeat(16),
        newName: "empty - copy.txt",
        expectedRevision: 5,
      },
    );
  });

  it("protects and validates internal resource handler resolution", async () => {
    const dependencies = await createDependencies();
    const resolveHandlers = vi.fn(async () => ({
      entryId: "22".repeat(16),
      name: "note.txt",
      extension: ".txt",
      revision: 3,
      requestedAction: "edit",
      effectiveAction: "edit",
      candidates: [],
    }));
    const origin = await listen(
      createDesktopServer({
        ...dependencies,
        openResourceResolver: { resolve: resolveHandlers },
      }).listen(0, "127.0.0.1"),
    );
    const body = JSON.stringify({
      entryId: "22".repeat(16),
      expectedRevision: 3,
      requestedAction: "edit",
    });
    const response = await fetch(
      `${origin}/api/v1/internal/open-resources/resolve`,
      {
        method: "POST",
        headers: {
          authorization: `Biunivers-Instance ${"a".repeat(43)}`,
          "content-type": "application/json",
          origin: dependencies.config.desktopOrigin,
          "sec-fetch-site": "same-origin",
        },
        body,
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(resolveHandlers).toHaveBeenCalledWith("a".repeat(43), {
      entryId: "22".repeat(16),
      expectedRevision: 3,
      requestedAction: "edit",
    });

    const forbidden = await fetch(
      `${origin}/api/v1/internal/open-resources/resolve`,
      {
        method: "POST",
        headers: {
          authorization: `Biunivers-Instance ${"a".repeat(43)}`,
          "content-type": "application/json",
          origin: "https://attacker.example",
        },
        body,
      },
    );
    expect(forbidden.status).toBe(403);
  });

  it("creates and claims resource launches through protected host APIs", async () => {
    const dependencies = await createDependencies();
    const createLaunch = vi.fn(async () => ({
      targetAppId: "io.github.example.notes",
      launchId: "b".repeat(43),
      expiresAt: "2026-07-29T12:05:00.000Z",
    }));
    const claimLaunch = vi.fn(async () => ({
      action: "edit",
      resource: {
        handleId: "c".repeat(43),
        name: "note.txt",
        permissions: ["read", "write"],
      },
    }));
    const cancelTarget = vi.fn();
    const origin = await listen(
      createDesktopServer({
        ...dependencies,
        openResourceLaunchService: {
          create: createLaunch,
          claim: claimLaunch,
          cancelTarget,
        },
      }).listen(0, "127.0.0.1"),
    );
    const headers = {
      authorization: `Biunivers-Instance ${"a".repeat(43)}`,
      "content-type": "application/json",
      origin: dependencies.config.desktopOrigin,
      "sec-fetch-site": "same-origin",
    };

    const created = await fetch(
      `${origin}/api/v1/internal/open-resources`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          entryId: "22".repeat(16),
          expectedRevision: 3,
          targetAppId: "io.github.example.notes",
          handlerId: "text",
          action: "edit",
        }),
      },
    );
    expect(created.status).toBe(201);
    expect(createLaunch).toHaveBeenCalledWith("a".repeat(43), {
      entryId: "22".repeat(16),
      expectedRevision: 3,
      targetAppId: "io.github.example.notes",
      handlerId: "text",
      action: "edit",
    });

    const claimed = await fetch(
      `${origin}/api/v1/host/open-resources/claim`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ launchId: "b".repeat(43) }),
      },
    );
    expect(claimed.status).toBe(200);
    expect(claimLaunch).toHaveBeenCalledWith(
      "a".repeat(43),
      "b".repeat(43),
    );
    expect(claimed.headers.get("cache-control")).toBe("no-store");

    const forbidden = await fetch(
      `${origin}/api/v1/internal/open-resources`,
      {
        method: "POST",
        headers: { ...headers, origin: "https://attacker.example" },
        body: "{}",
      },
    );
    expect(forbidden.status).toBe(403);
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
        internalFileAppIds: new Set(["system.files"]),
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

    const internalCreated = await fetch(
      `${origin}/api/v1/host/instances`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: dependencies.config.desktopOrigin,
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({
          appId: "system.files",
          windowInstanceId: "files-window-1",
        }),
      },
    );
    expect(internalCreated.status).toBe(201);

    const unknownApp = await fetch(`${origin}/api/v1/host/instances`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: dependencies.config.desktopOrigin,
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({
        appId: "system.unknown",
        windowInstanceId: "unknown-window-1",
      }),
    });
    expect(unknownApp.status).toBe(404);

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
