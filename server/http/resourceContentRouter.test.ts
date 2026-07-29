// @vitest-environment node

import { once } from "node:events";
import express from "express";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { appSpecificOrigin } from "../apps/appOrigin.js";
import {
  FileCapabilityError,
  FileCapabilityRegistry,
} from "../files/fileCapabilityRegistry.js";
import { parseSingleByteRange } from "../resources/byteRange.js";
import { ResourceSessionError } from "../resources/resourceSessionRegistry.js";
import {
  createResourceContentRouter,
  type ResourceContentExecutor,
} from "./resourceContentRouter.js";

const servers: Server[] = [];
const appId = "io.example.player";
const otherAppId = "io.example.other";
const appBaseOrigin = "http://localhost:8081";
const appOrigin = appSpecificOrigin(appBaseOrigin, appId);
const bytes = Buffer.from("0123456789");

async function listen(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return `http://127.0.0.1:${address.port}`;
}

function setup() {
  const capabilities = new FileCapabilityRegistry();
  const instance = capabilities.createInstance(appId, "window-1");
  const sessionId = Buffer.alloc(32, 7).toString("base64url");
  const writes: Uint8Array[] = [];
  const resources: ResourceContentExecutor = {
    async read(requestAppId, requestSessionId, rangeHeader) {
      if (requestAppId !== appId || requestSessionId !== sessionId) {
        throw new ResourceSessionError(
          "RESOURCE_SESSION_NOT_FOUND",
          "not found",
        );
      }
      const range = parseSingleByteRange(rangeHeader, bytes.length);
      const content = range
        ? bytes.subarray(range.start, range.endInclusive + 1)
        : bytes;
      async function* chunks() {
        yield content;
      }
      return {
        status: range ? 206 : 200,
        size: bytes.length,
        contentLength: content.length,
        mediaType: "video/x-matroska",
        range,
        chunks: chunks(),
      };
    },
    async write(requestAppId, requestSessionId, source) {
      if (requestAppId !== appId || requestSessionId !== sessionId) {
        throw new Error("not found");
      }
      for await (const chunk of source) writes.push(Uint8Array.from(chunk));
      return {
        sessionId,
        revision: 2,
        size: writes.reduce((sum, chunk) => sum + chunk.byteLength, 0),
        mtimeMs: 3,
        contentVersion: "version",
        expiresAt: new Date(9999999999999).toISOString(),
      };
    },
  };
  const activeApps = new Set([appId]);
  const app = express();
  app.use(
    "/api/v1/resource-content",
    createResourceContentRouter({
      appOrigin: appBaseOrigin,
      capabilities,
      resources,
      isAppActive: async (candidate) => activeApps.has(candidate),
      resolveAppIdForOrigin: async (origin) =>
        origin === appOrigin ? appId : undefined,
    }),
  );
  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      void _next;
      const status =
        error instanceof FileCapabilityError
          ? 401
          : error instanceof ResourceSessionError
            ? 404
            : typeof error === "object" &&
                error !== null &&
                "status" in error &&
                typeof error.status === "number"
              ? error.status
              : 500;
      response.status(status).json({ error: { code: "REJECTED" } });
    },
  );
  return {
    app,
    activeApps,
    instanceToken: instance.instanceToken,
    sessionId,
    writes,
  };
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
});

describe("Resource content HTTP router", () => {
  it("allows an active app preflight for reusable GET and PUT", async () => {
    const fixture = setup();
    const origin = await listen(fixture.app);
    const response = await fetch(`${origin}/api/v1/resource-content`, {
      method: "OPTIONS",
      headers: {
        origin: appOrigin,
        "access-control-request-method": "GET",
        "access-control-request-headers":
          "authorization,biunivers-resource-session,range",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      appOrigin,
    );
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "Biunivers-Resource-Session",
    );
  });

  it("serves repeated full and Range GETs from a header-bound session", async () => {
    const fixture = setup();
    const origin = await listen(fixture.app);
    const url = `${origin}/api/v1/resource-content`;
    const headers = {
      origin: appOrigin,
      authorization: `Biunivers-Instance ${fixture.instanceToken}`,
      "biunivers-resource-session": fixture.sessionId,
    };

    const full = await fetch(url, { headers });
    expect(full.status).toBe(200);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    await expect(full.text()).resolves.toBe("0123456789");

    const range = await fetch(url, {
      headers: { ...headers, range: "bytes=3-6" },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 3-6/10");
    expect(range.headers.get("content-length")).toBe("4");
    expect(range.headers.get("access-control-expose-headers")).toContain(
      "Content-Range",
    );
    await expect(range.text()).resolves.toBe("3456");
  });

  it("returns a standards-shaped 416 response", async () => {
    const fixture = setup();
    const origin = await listen(fixture.app);
    const response = await fetch(`${origin}/api/v1/resource-content`, {
      headers: {
        origin: appOrigin,
        authorization: `Biunivers-Instance ${fixture.instanceToken}`,
        "biunivers-resource-session": fixture.sessionId,
        range: "bytes=99-",
      },
    });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */10");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "RANGE_NOT_SATISFIABLE" },
    });
  });

  it("streams PUT and rejects another app origin", async () => {
    const fixture = setup();
    const origin = await listen(fixture.app);
    const url = `${origin}/api/v1/resource-content`;
    const forbidden = await fetch(url, {
      headers: {
        origin: appSpecificOrigin(appBaseOrigin, otherAppId),
        authorization: `Biunivers-Instance ${fixture.instanceToken}`,
        "biunivers-resource-session": fixture.sessionId,
      },
    });
    expect(forbidden.status).toBe(403);

    const written = await fetch(url, {
      method: "PUT",
      headers: {
        origin: appOrigin,
        authorization: `Biunivers-Instance ${fixture.instanceToken}`,
        "biunivers-resource-session": fixture.sessionId,
        "content-type": "application/octet-stream",
      },
      body: "saved",
    });
    expect(written.status).toBe(200);
    expect(Buffer.concat(fixture.writes).toString()).toBe("saved");
  });

  it("revokes data access when the app is no longer active", async () => {
    const fixture = setup();
    fixture.activeApps.delete(appId);
    const origin = await listen(fixture.app);
    const response = await fetch(`${origin}/api/v1/resource-content`, {
      headers: {
        origin: appOrigin,
        authorization: `Biunivers-Instance ${fixture.instanceToken}`,
        "biunivers-resource-session": fixture.sessionId,
      },
    });
    expect(response.status).toBe(403);
  });
});
