import type { Request, Response, Router } from "express";
import express from "express";
import type { WormholeRuntime } from "./wormholeRuntime.js";
import {
  WormholeFileError,
  type WebDavResource,
  type WormholeFileService,
} from "./wormholeFileService.js";
import {
  parseWebDavPath,
  webDavHref,
  WebDavPathError,
} from "./webDavPath.js";
import {
  WormholeLockError,
  WormholeLockRegistry,
} from "./wormholeLockRegistry.js";
import { ObjectStoreError } from "../files/objectStore.js";
import { RefStoreError } from "../files/sqliteRefStore.js";

interface WormholeRouterOptions {
  runtime: WormholeRuntime;
  files: WormholeFileService;
}

export function createWormholeRouter(options: WormholeRouterOptions): Router {
  const router = express.Router();
  const locks = new WormholeLockRegistry();
  options.runtime.onRevoke(() => locks.clear());
  router.use(async (request, response) => {
    if (request.get("sec-fetch-site") === "cross-site") {
      response.status(403).end();
      return;
    }
    const credential = readBasicCredential(request.get("authorization"));
    if (
      !credential ||
      !options.runtime.authenticate(
        credential.username,
        credential.password,
        request.ip ?? request.socket.remoteAddress ?? "unknown",
      )
    ) {
      challenge(response);
      return;
    }
    const lease = options.runtime.registerRequest();
    try {
      if (lease.signal.aborted) {
        response.status(401).end();
        return;
      }
      await dispatch(request, response, options.files, locks, lease.signal);
    } catch (error) {
      sendWebDavError(response, error);
    } finally {
      lease.release();
    }
  });
  return router;
}

async function dispatch(
  request: Request,
  response: Response,
  files: WormholeFileService,
  locks: WormholeLockRegistry,
  signal: AbortSignal,
): Promise<void> {
  const path = parseWebDavPath(`/wormhole/webdav${request.url}`);
  const lockPath = `/${path.segments.join("/")}`;
  if (request.method === "OPTIONS") {
    response.status(200).set({
      Allow: "OPTIONS, PROPFIND, HEAD, GET, PUT, MKCOL, DELETE, MOVE, COPY, PROPPATCH, LOCK, UNLOCK",
      DAV: "1, 2",
      "MS-Author-Via": "DAV",
      "Cache-Control": "no-store",
    }).end();
    return;
  }
  if (request.method === "PROPFIND") {
    await discardSmallBody(request, 64 * 1024);
    const depth = request.get("depth") ?? "1";
    if (depth !== "0" && depth !== "1") {
      throw new WebDavHttpError(403, "Depth is not supported.");
    }
    const listing = await files.list(path.segments, depth === "1");
    const resources = [listing.resource, ...listing.children];
    response.status(207).set({
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "no-store",
    }).send(multistatus(resources));
    return;
  }
  if (request.method === "HEAD" || request.method === "GET") {
    const listing = await files.list(path.segments, false);
    if (listing.resource.kind !== "file") {
      throw new WebDavHttpError(405, "Collections cannot be downloaded.");
    }
    const range = parseRange(request.get("range"), listing.resource.size);
    const read = range
      ? await files.readRange(path.segments, range.start, range.endInclusive)
      : await files.read(path.segments);
    const length = range
      ? range.endInclusive - range.start + 1
      : read.resource.size;
    response.status(range ? 206 : 200).set({
      "Accept-Ranges": "bytes",
      "Content-Type": read.resource.contentType!,
      "Content-Length": String(length),
      ETag: read.resource.etag,
      "Last-Modified": new Date(read.resource.mtimeMs).toUTCString(),
      "Cache-Control": "no-store",
      ...(range
        ? {
            "Content-Range":
              `bytes ${range.start}-${range.endInclusive}/${read.resource.size}`,
          }
        : {}),
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    for await (const chunk of read.chunks) {
      if (signal.aborted || response.destroyed) return;
      if (!response.write(chunk)) await waitForDrain(response);
    }
    response.end();
    return;
  }
  if (request.method === "PUT") {
    locks.assertAllowed(lockPath, submittedLocks(request));
    const contentLength = Number(request.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > 4 * 1024 ** 3) {
      throw new WebDavHttpError(413, "File is too large.");
    }
    const result = await files.put(path.segments, request, readMtime(request), {
      ifMatch: request.get("if-match"),
      ifNoneMatch: request.get("if-none-match"),
    });
    response.status(result.created ? 201 : 204).set({
      ETag: result.etag,
      "Cache-Control": "no-store",
    }).end();
    return;
  }
  if (request.method === "MKCOL") {
    locks.assertAllowed(lockPath, submittedLocks(request));
    if (request.get("content-length") && request.get("content-length") !== "0") {
      throw new WebDavHttpError(415, "MKCOL request body is not supported.");
    }
    await files.createDirectory(path.segments, readMtime(request));
    response.status(201).end();
    return;
  }
  if (request.method === "DELETE") {
    locks.assertAllowed(lockPath, submittedLocks(request));
    await files.remove(path.segments);
    response.status(204).end();
    return;
  }
  if (request.method === "MOVE" || request.method === "COPY") {
    const destination = parseDestination(request.get("destination"));
    locks.assertAllowed(lockPath, submittedLocks(request));
    locks.assertAllowed(`/${destination.segments.join("/")}`, submittedLocks(request));
    const overwrite = (request.get("overwrite") ?? "T").toUpperCase() !== "F";
    if (request.method === "MOVE") {
      await files.move(path.segments, destination.segments, overwrite);
    } else {
      const depth = request.get("depth") ?? "infinity";
      if (depth !== "infinity") {
        throw new WebDavHttpError(403, "Only recursive COPY is supported.");
      }
      await files.copy(path.segments, destination.segments, overwrite);
    }
    response.status(201).end();
    return;
  }
  if (request.method === "LOCK") {
    const body = await readSmallBody(request, 64 * 1024);
    const owner =
      body.match(/<(?:[^:>]+:)?owner[^>]*>([\s\S]*?)<\/(?:[^:>]+:)?owner>/i)?.[1]
        ?.replace(/<[^>]+>/g, "")
        .trim() ?? "";
    const existingToken = submittedLocks(request).match(/opaquelocktoken:[0-9a-f-]+/i)?.[0];
    const timeout = readLockTimeout(request.get("timeout"));
    const lock = existingToken
      ? locks.refresh(lockPath, existingToken, timeout)
      : locks.lock(lockPath, owner, timeout);
    response.status(existingToken ? 200 : 201).set({
      "Lock-Token": `<${lock.token}>`,
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "no-store",
    }).send(lockResponse(lock));
    return;
  }
  if (request.method === "UNLOCK") {
    const token = unwrapToken(request.get("lock-token"));
    if (!token) throw new WebDavHttpError(400, "Lock token is required.");
    locks.unlock(lockPath, token);
    response.status(204).end();
    return;
  }
  if (request.method === "PROPPATCH") {
    locks.assertAllowed(lockPath, submittedLocks(request));
    const body = await readSmallBody(request, 64 * 1024);
    const mtime = parsePropertyMtime(body);
    if (mtime === undefined) {
      throw new WebDavHttpError(403, "Property is not writable.");
    }
    await files.setMtime(path.segments, mtime);
    const listing = await files.list(path.segments, false);
    response.status(207).set({
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "no-store",
    }).send(multistatus([listing.resource]));
    return;
  }
  response
    .status(405)
    .set("Allow", "OPTIONS, PROPFIND, HEAD, GET, PUT, MKCOL, DELETE, MOVE, COPY, PROPPATCH, LOCK, UNLOCK")
    .end();
}

function readBasicCredential(
  authorization: string | undefined,
): { username: string; password: string } | undefined {
  const match = authorization?.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return undefined;
  let decoded: string;
  try {
    const encoded = match[1];
    const bytes = Buffer.from(encoded, "base64");
    if (
      bytes.toString("base64").replace(/=+$/, "") !==
      encoded.replace(/=+$/, "")
    ) {
      return undefined;
    }
    decoded = bytes.toString("utf8");
  } catch {
    return undefined;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return undefined;
  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  };
}

function challenge(response: Response): void {
  response.status(401).set({
    "WWW-Authenticate": 'Basic realm="Biunivers Wormhole", charset="UTF-8"',
    "Cache-Control": "no-store",
  }).end();
}

function multistatus(resources: readonly WebDavResource[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<D:multistatus xmlns:D="DAV:">${resources.map(resourceXml).join("")}` +
    `</D:multistatus>`;
}

function resourceXml(resource: WebDavResource): string {
  const directory = resource.kind === "directory";
  return `<D:response>` +
    `<D:href>${xml(webDavHref(resource.segments, directory))}</D:href>` +
    `<D:propstat><D:prop>` +
    `<D:displayname>${xml(resource.name || "/")}</D:displayname>` +
    `<D:resourcetype>${directory ? "<D:collection/>" : ""}</D:resourcetype>` +
    `${directory ? "" : `<D:getcontentlength>${resource.size}</D:getcontentlength>`}` +
    `${directory ? "" : `<D:getcontenttype>${xml(resource.contentType!)}</D:getcontenttype>`}` +
    `<D:getlastmodified>${new Date(resource.mtimeMs).toUTCString()}</D:getlastmodified>` +
    `<D:creationdate>${new Date(resource.createdAtMs).toISOString()}</D:creationdate>` +
    `<D:getetag>${xml(resource.etag)}</D:getetag>` +
    `<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>` +
    `<D:lockdiscovery/>` +
    `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>` +
    `</D:response>`;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function parseRange(
  header: string | undefined,
  size: number,
): { start: number; endInclusive: number } | undefined {
  if (!header) return undefined;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || size === 0) throw new WebDavHttpError(416, "Invalid range.");
  const startText = match[1];
  const endText = match[2];
  let start: number;
  let endInclusive: number;
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      throw new WebDavHttpError(416, "Invalid range.");
    }
    start = Math.max(0, size - suffix);
    endInclusive = size - 1;
  } else {
    start = Number(startText);
    endInclusive = endText ? Number(endText) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(endInclusive) ||
    start < 0 ||
    start >= size ||
    endInclusive < start
  ) {
    throw new WebDavHttpError(416, "Invalid range.");
  }
  return { start, endInclusive: Math.min(endInclusive, size - 1) };
}

function parseDestination(header: string | undefined) {
  if (!header) throw new WebDavHttpError(400, "Destination is required.");
  let rawPath: string;
  try {
    rawPath = header.startsWith("/")
      ? header
      : new URL(header).pathname;
  } catch {
    throw new WebDavHttpError(400, "Destination is invalid.");
  }
  return parseWebDavPath(rawPath);
}

function readMtime(request: Request): number | undefined {
  const value = request.get("x-oc-mtime");
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new WebDavHttpError(400, "Modification time is invalid.");
  }
  return seconds * 1000;
}

function parsePropertyMtime(body: string): number | undefined {
  const numeric = body.match(/<(?:[^:>]+:)?mtime[^>]*>(\d+)<\//i)?.[1];
  if (numeric) {
    const seconds = Number(numeric);
    if (Number.isSafeInteger(seconds)) return seconds * 1000;
  }
  const date = body.match(
    /<(?:[^:>]+:)?getlastmodified[^>]*>([^<]+)<\//i,
  )?.[1];
  if (date) {
    const value = Date.parse(date);
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
  return undefined;
}

async function discardSmallBody(request: Request, maximum: number) {
  await readSmallBody(request, maximum);
}

async function readSmallBody(request: Request, maximum: number) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > maximum) throw new WebDavHttpError(413, "XML body is too large.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function submittedLocks(request: Request): string {
  return `${request.get("if") ?? ""} ${request.get("lock-token") ?? ""}`;
}

function unwrapToken(value: string | undefined) {
  return value?.match(/<?(opaquelocktoken:[0-9a-f-]+)>?/i)?.[1];
}

function readLockTimeout(value: string | undefined) {
  const seconds = value?.match(/Second-(\d+)/i)?.[1];
  return seconds ? Math.max(1, Number(seconds)) : 600;
}

function lockResponse(lock: { token: string; owner: string; expiresAtMs: number }) {
  const remaining = Math.max(1, Math.ceil((lock.expiresAtMs - Date.now()) / 1000));
  return `<?xml version="1.0" encoding="utf-8"?><D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>infinity</D:depth><D:owner>${xml(lock.owner)}</D:owner><D:timeout>Second-${remaining}</D:timeout><D:locktoken><D:href>${xml(lock.token)}</D:href></D:locktoken></D:activelock></D:lockdiscovery></D:prop>`;
}

function sendWebDavError(response: Response, error: unknown): void {
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined);
    return;
  }
  if (error instanceof WebDavPathError) {
    response.status(400).end();
    return;
  }
  if (error instanceof WormholeFileError) {
    const status = {
      NOT_FOUND: 404,
      IS_DIRECTORY: 405,
      ALREADY_EXISTS: 405,
      ROOT_FORBIDDEN: 403,
      PRECONDITION: 412,
      DIRECTORY_NOT_EMPTY: 409,
      CONFLICT: 409,
    }[error.code];
    response.status(status).end();
    return;
  }
  if (error instanceof WebDavHttpError) {
    response.status(error.status).end();
    return;
  }
  if (error instanceof WormholeLockError) {
    response.status(error.code === "LOCKED" ? 423 : error.code === "LIMIT" ? 507 : 409).end();
    return;
  }
  if (error instanceof ObjectStoreError && error.code === "OBJECT_TOO_LARGE") {
    response.status(413).end();
    return;
  }
  if (error instanceof RefStoreError && error.code === "REF_CONFLICT") {
    response.status(409).end();
    return;
  }
  response.status(500).end();
}

class WebDavHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function waitForDrain(response: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off("drain", drained);
      response.off("close", closed);
      response.off("error", failed);
    };
    const drained = () => {
      cleanup();
      resolve();
    };
    const closed = () => {
      cleanup();
      reject(new Error("Wormhole response closed."));
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    response.once("drain", drained);
    response.once("close", closed);
    response.once("error", failed);
  });
}
