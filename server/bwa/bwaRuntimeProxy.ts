import http from "node:http";
import net, { type Socket } from "node:net";
import type { RequestHandler } from "express";
import type { SqliteRefStore } from "../files/sqliteRefStore.js";
import {
  BwaBrowserSessionError,
  BwaBrowserSessionRegistry,
  bwaSessionCookieName,
} from "./bwaBrowserSessionRegistry.js";
import { requestHostMatchesBwaInstance } from "./bwaOrigin.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const RESERVED_COOKIE_PREFIX = "__Host-biunivers-";

interface EndpointClient {
  resolveBwaEndpoint(runIdHex: string): Promise<unknown>;
}

interface RuntimeProxyOptions {
  appOrigin: string;
  refStore: SqliteRefStore;
  sessions: BwaBrowserSessionRegistry;
  runtime: EndpointClient;
}

export function createBwaRuntimeProxy(options: RuntimeProxyOptions): RequestHandler {
  const cookieName = bwaSessionCookieName(options.appOrigin);

  return (request, response, next) => {
    const target = resolveHostTarget(request.get("host"), options.appOrigin, options.refStore);
    if (!target) {
      next();
      return;
    }
    void (async () => {
      response.set("Cache-Control", "no-store");
      response.set("Referrer-Policy", "no-referrer");
      if (!target.enabled) {
        sendFailure(request, response, 404, "BWA_NOT_FOUND", "应用不可用");
        return;
      }
      if (request.path === "/__biunivers/bootstrap") {
        if (request.method !== "GET" || typeof request.query.t !== "string") {
          sendFailure(request, response, 400, "BWA_BOOTSTRAP_INVALID", "打开凭据无效");
          return;
        }
        try {
          const issued = options.sessions.consumeBootstrap(
            target.instanceIdHex,
            request.query.t,
          );
          response.setHeader(
            "Set-Cookie",
            serializeSessionCookie(cookieName, issued.session),
          );
          response.redirect(303, "/");
        } catch (error) {
          if (error instanceof BwaBrowserSessionError) {
            sendFailure(request, response, 401, "BWA_BOOTSTRAP_INVALID", "打开凭据已失效");
            return;
          }
          throw error;
        }
        return;
      }

      const cookies = parseCookies(request.headers.cookie);
      try {
        options.sessions.authorize(target.instanceIdHex, cookies.get(cookieName) ?? "");
      } catch (error) {
        if (error instanceof BwaBrowserSessionError) {
          sendFailure(request, response, 401, "BWA_SESSION_INVALID", "请从桌面重新打开应用");
          return;
        }
        throw error;
      }

      const run = uniqueRunningRun(options.refStore, target.instanceIdHex);
      if (!run) {
        sendFailure(request, response, 503, "BWA_STOPPED", "应用当前未运行");
        return;
      }
      const endpoint = validateEndpoint(await options.runtime.resolveBwaEndpoint(run.runIdHex));
      proxyHttp(request, response, endpoint, cookieName);
    })().catch((error) => {
      if (!response.headersSent) {
        sendFailure(request, response, 502, "BWA_PROXY_FAILED", "无法连接应用");
      } else {
        response.destroy(error instanceof Error ? error : undefined);
      }
    });
  };
}

export function createBwaWebSocketProxy(
  options: RuntimeProxyOptions & {
    connect?: (endpoint: { host: string; port: number }) => Socket;
  },
): (request: http.IncomingMessage, socket: Socket, head: Buffer) => void {
  const cookieName = bwaSessionCookieName(options.appOrigin);
  const connect = options.connect ?? ((endpoint) => net.createConnection(endpoint));
  return (request, socket, head) => {
    void (async () => {
      const target = resolveHostTarget(request.headers.host, options.appOrigin, options.refStore);
      if (!target || !target.enabled) {
        rejectUpgrade(socket, 404, "Not Found");
        return;
      }
      try {
        options.sessions.authorize(
          target.instanceIdHex,
          parseCookies(request.headers.cookie).get(cookieName) ?? "",
        );
      } catch (error) {
        if (error instanceof BwaBrowserSessionError) {
          rejectUpgrade(socket, 401, "Unauthorized");
          return;
        }
        throw error;
      }
      const run = uniqueRunningRun(options.refStore, target.instanceIdHex);
      if (!run) {
        rejectUpgrade(socket, 503, "Service Unavailable");
        return;
      }
      const endpoint = validateEndpoint(await options.runtime.resolveBwaEndpoint(run.runIdHex));
      const upstream = connect({ host: endpoint.address, port: endpoint.port });
      let connected = false;
      upstream.once("connect", () => {
        connected = true;
        upstream.write(
          serializeUpgradeRequest(
            request,
            endpoint,
            cookieName,
            new URL(options.appOrigin).protocol.slice(0, -1),
          ),
        );
        if (head.byteLength > 0) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      upstream.once("error", () => {
        if (!connected) rejectUpgrade(socket, 502, "Bad Gateway");
        else socket.destroy();
      });
      socket.once("error", () => upstream.destroy());
      socket.once("close", () => upstream.destroy());
    })().catch(() => rejectUpgrade(socket, 502, "Bad Gateway"));
  };
}

function resolveHostTarget(
  host: string | undefined,
  appOrigin: string,
  refStore: SqliteRefStore,
): { instanceIdHex: string; enabled: boolean } | undefined {
  const matches = refStore.listBwaApplications().flatMap((application) =>
    refStore
      .listBwaInstances(application.applicationId)
      .filter((instance) =>
        requestHostMatchesBwaInstance(host, appOrigin, instance.instanceIdHex),
      )
      .map((instance) => ({
        instanceIdHex: instance.instanceIdHex,
        enabled: application.enabled,
      })),
  );
  if (matches.length > 1) throw new Error("BWA origin maps to multiple Instances.");
  return matches[0];
}

function uniqueRunningRun(refStore: SqliteRefStore, instanceIdHex: string) {
  const runs = refStore
    .listBwaRunBindings(instanceIdHex)
    .map(({ run }) => run)
    .filter((run) => run.state === "RUNNING");
  if (runs.length > 1) throw new Error("BWA Instance has multiple running Runs.");
  return runs[0];
}

function validateEndpoint(value: unknown): { address: string; port: 8080 } {
  if (!value || typeof value !== "object") throw new Error("BWA endpoint is invalid.");
  const endpoint = value as Record<string, unknown>;
  if (typeof endpoint.address !== "string" || endpoint.port !== 8080) {
    throw new Error("BWA endpoint is invalid.");
  }
  return { address: endpoint.address, port: 8080 };
}

function proxyHttp(
  request: Parameters<RequestHandler>[0],
  response: Parameters<RequestHandler>[1],
  endpoint: { address: string; port: 8080 },
  sessionCookieName: string,
): void {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "host" || lower === "cookie") continue;
    headers[name] = value;
  }
  const applicationCookies = [...parseCookies(request.headers.cookie)]
    .filter(([name]) => name !== sessionCookieName)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  if (applicationCookies) headers.cookie = applicationCookies;
  headers.host = `${endpoint.address}:8080`;
  headers["x-forwarded-proto"] = request.protocol;
  headers["x-forwarded-host"] = request.get("host") ?? "";
  headers["x-forwarded-prefix"] = "/";

  const upstream = http.request({
    host: endpoint.address,
    port: endpoint.port,
    method: request.method,
    path: request.originalUrl,
    headers,
  });
  upstream.on("response", (upstreamResponse) => {
    response.status(upstreamResponse.statusCode ?? 502);
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower) || value === undefined) continue;
      if (lower === "set-cookie") {
        const cookies = Array.isArray(value) ? value : [value];
        const filtered = cookies.filter((cookie) => {
          const normalized = cookie.trimStart();
          return (
            !normalized.startsWith(RESERVED_COOKIE_PREFIX) &&
            !normalized.startsWith(`${sessionCookieName}=`)
          );
        });
        if (filtered.length > 0) response.setHeader(name, filtered);
      } else {
        response.setHeader(name, value);
      }
    }
    upstreamResponse.on("error", (error) => response.destroy(error));
    upstreamResponse.pipe(response);
  });
  upstream.on("error", (error) => {
    if (!response.headersSent) {
      sendFailure(request, response, 502, "BWA_UPSTREAM_FAILED", "应用连接失败");
    } else {
      response.destroy(error);
    }
  });
  request.on("aborted", () => upstream.destroy());
  request.pipe(upstream);
}

function parseCookies(value: string | undefined): Map<string, string> {
  const output = new Map<string, string>();
  for (const part of value?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const item = part.slice(separator + 1).trim();
    if (name) output.set(name, item);
  }
  return output;
}

function serializeSessionCookie(name: string, value: string): string {
  // A BWA has an isolated subdomain and runs inside the Desktop iframe. CHIPS
  // keeps its host-only session available in that cross-site iframe while
  // binding it to the current top-level Biunivers site. Secure is mandatory
  // for both SameSite=None and Partitioned; browsers permit it on localhost.
  return `${name}=${value}; Path=/; HttpOnly; SameSite=None; Secure; Partitioned`;
}

function serializeUpgradeRequest(
  request: http.IncomingMessage,
  endpoint: { address: string; port: 8080 },
  sessionCookieName: string,
  forwardedProtocol: string,
): string {
  const lines = [`${request.method ?? "GET"} ${request.url ?? "/"} HTTP/1.1`];
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (lower === "host" || lower === "cookie" || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      lines.push(`${name}: ${item}`);
    }
  }
  const applicationCookies = [...parseCookies(request.headers.cookie)]
    .filter(([name]) => name !== sessionCookieName)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  lines.push(`host: ${endpoint.address}:8080`);
  if (applicationCookies) lines.push(`cookie: ${applicationCookies}`);
  lines.push(`x-forwarded-host: ${request.headers.host ?? ""}`);
  lines.push(`x-forwarded-proto: ${forwardedProtocol}`);
  lines.push("x-forwarded-prefix: /");
  lines.push("", "");
  return lines.join("\r\n");
}

function rejectUpgrade(socket: Socket, status: number, reason: string): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      "Connection: close\r\n" +
      "Cache-Control: no-store\r\n" +
      "Content-Length: 0\r\n\r\n",
  );
}

function sendFailure(
  request: Parameters<RequestHandler>[0],
  response: Parameters<RequestHandler>[1],
  status: number,
  code: string,
  message: string,
): void {
  const navigation =
    request.get("sec-fetch-dest") === "iframe" ||
    request.get("sec-fetch-dest") === "document" ||
    request.accepts(["html", "json"]) === "html";
  response.status(status);
  if (navigation) {
    response.type("html").send(
      `<!doctype html><meta charset="utf-8"><title>Biunivers</title>` +
        `<main><h1>${escapeHtml(message)}</h1><p>请返回桌面控制界面重试。</p></main>`,
    );
  } else {
    response.json({ error: { code, message } });
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}
