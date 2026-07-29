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
import type { IndexedEntry } from "../files/entryIndex.js";
import {
  createFileTransferRouter,
  type FileTransferExecutor,
} from "./fileTransferRouter.js";

const servers: Server[] = [];
const appId = "io.example.notes";
const appBaseOrigin = "http://localhost:8081";
const appOrigin = appSpecificOrigin(appBaseOrigin, appId);
const file: IndexedEntry = {
  entryIdHex: "11".repeat(16),
  parentEntryIdHex: "22".repeat(16),
  name: "notes.md",
  kind: "file",
  createdAtMs: 1,
  mtimeMs: 2,
  content: {
    kind: "chunk",
    fidHex: "33".repeat(16),
    size: 5,
  },
};

async function listen(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not bind");
  }
  return `http://127.0.0.1:${address.port}`;
}

function setup() {
  const capabilities = new FileCapabilityRegistry();
  const instance = capabilities.createInstance(appId, "window-1");
  const handle = capabilities.issueHandle(
    instance.instanceToken,
    file,
    1,
    true,
  );
  const writes: Uint8Array[] = [];
  const transfers: FileTransferExecutor = {
    async read(instanceToken, transferId) {
      capabilities.beginTransfer(instanceToken, transferId, "GET");
      async function* chunks() {
        try {
          yield Buffer.from("hello");
        } finally {
          capabilities.finishTransfer(instanceToken, transferId);
        }
      }
      return { size: 5, chunks: chunks() };
    },
    async write(instanceToken, transferId, source, contentLength) {
      capabilities.beginTransfer(
        instanceToken,
        transferId,
        "PUT",
        contentLength,
      );
      try {
        for await (const chunk of source) {
          writes.push(Uint8Array.from(chunk));
        }
        return {
          entryId: file.entryIdHex,
          revision: 2,
          size: writes.reduce((total, chunk) => total + chunk.byteLength, 0),
          mtimeMs: 3,
        };
      } finally {
        capabilities.finishTransfer(instanceToken, transferId);
      }
    },
  };
  const app = express();
  app.use(
    "/api/v1/files/transfers",
    createFileTransferRouter({
      appOrigin: appBaseOrigin,
      capabilities,
      transfers,
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
          ? 400
          : typeof error === "object" &&
              error !== null &&
              "status" in error &&
              typeof error.status === "number"
            ? error.status
            : 500;
      response.status(status).json({ error: "rejected" });
    },
  );
  return {
    app,
    capabilities,
    instanceToken: instance.instanceToken,
    handleId: handle.handleId,
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

describe("File transfer HTTP router", () => {
  it("serves a one-shot GET after an exact-origin preflight", async () => {
    const fixture = setup();
    const transfer = fixture.capabilities.issueTransfer(
      fixture.instanceToken,
      fixture.handleId,
      "GET",
      99,
    );
    const origin = await listen(fixture.app);
    const url = `${origin}/api/v1/files/transfers/${transfer.transferId}`;
    const preflight = await fetch(url, {
      method: "OPTIONS",
      headers: {
        origin: appOrigin,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      appOrigin,
    );
    expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();

    const response = await fetch(url, {
      headers: {
        origin: appOrigin,
        authorization: `Biunivers-Instance ${fixture.instanceToken}`,
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(appOrigin);
    await expect(response.text()).resolves.toBe("hello");
    expect(
      (
        await fetch(url, {
          headers: {
            origin: appOrigin,
            authorization: `Biunivers-Instance ${fixture.instanceToken}`,
          },
        })
      ).status,
    ).toBe(400);
  });

  it("streams a bounded PUT and rejects another app origin", async () => {
    const fixture = setup();
    const transfer = fixture.capabilities.issueTransfer(
      fixture.instanceToken,
      fixture.handleId,
      "PUT",
      10,
    );
    const origin = await listen(fixture.app);
    const url = `${origin}/api/v1/files/transfers/${transfer.transferId}`;

    const forbidden = await fetch(url, {
      method: "OPTIONS",
      headers: {
        origin: appSpecificOrigin(appBaseOrigin, "io.example.other"),
        "access-control-request-method": "PUT",
      },
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("access-control-allow-origin")).toBeNull();

    const response = await fetch(url, {
      method: "PUT",
      headers: {
        origin: appOrigin,
        authorization: `Biunivers-Instance ${fixture.instanceToken}`,
        "content-type": "application/octet-stream",
      },
      body: "updated",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      entryId: file.entryIdHex,
      revision: 2,
      size: 7,
    });
    expect(Buffer.concat(fixture.writes).toString()).toBe("updated");
  });
});
