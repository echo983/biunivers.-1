import { once } from "node:events";
import express from "express";
import { AppError } from "../apps/appError.js";
import { appSpecificOrigin } from "../apps/appOrigin.js";
import type { FileCapabilityRegistry } from "../files/fileCapabilityRegistry.js";
import { ByteRangeError } from "../resources/byteRange.js";
import type {
  ResourceContentService,
  ResourceWriteResult,
} from "../resources/resourceContentService.js";

export interface ResourceContentExecutor {
  read(
    appId: string,
    sessionId: string,
    rangeHeader?: string,
  ): ReturnType<ResourceContentService["read"]>;
  write(
    appId: string,
    sessionId: string,
    source: AsyncIterable<Uint8Array>,
    contentLength?: number,
  ): Promise<ResourceWriteResult>;
}

interface ResourceContentRouterOptions {
  appOrigin: string;
  capabilities: FileCapabilityRegistry;
  resources: ResourceContentExecutor;
  isAppActive: (appId: string) => Promise<boolean>;
  resolveAppIdForOrigin: (origin: string) => Promise<string | undefined>;
}

const SESSION_HEADER = "biunivers-resource-session";

export function createResourceContentRouter(
  options: ResourceContentRouterOptions,
): express.Router {
  const router = express.Router();

  router.options("/", async (request, response, next) => {
    try {
      const origin = request.get("origin");
      const requestedMethod = request
        .get("access-control-request-method")
        ?.toUpperCase();
      if (
        !origin ||
        (requestedMethod !== "GET" && requestedMethod !== "PUT")
      ) {
        throw forbidden();
      }
      const appId = await options.resolveAppIdForOrigin(origin);
      if (
        !appId ||
        appSpecificOrigin(options.appOrigin, appId) !== origin ||
        !(await options.isAppActive(appId))
      ) {
        throw forbidden();
      }
      response
        .status(204)
        .set(corsHeaders(origin))
        .set("Access-Control-Allow-Methods", "GET, PUT")
        .set(
          "Access-Control-Allow-Headers",
          "Authorization, Biunivers-Resource-Session, Range, Content-Type",
        )
        .set("Access-Control-Max-Age", "0")
        .end();
    } catch (error) {
      next(error);
    }
  });

  router.get("/", async (request, response, next) => {
    let origin: string | undefined;
    try {
      const identity = authorizeRequest(request, options);
      origin = requireOrigin(request, options.appOrigin, identity.appId);
      if (!(await options.isAppActive(identity.appId))) {
        throw new AppError(
          "RESOURCE_SESSION_REVOKED",
          "应用已停用或卸载",
          403,
        );
      }
      response.set(corsHeaders(origin));
      const result = await options.resources.read(
        identity.appId,
        readSessionId(request),
        request.get("range"),
      );
      response
        .status(result.status)
        .set("Cache-Control", "no-store")
        .set("Accept-Ranges", "bytes")
        .set("Content-Type", result.mediaType)
        .set("Content-Length", String(result.contentLength));
      if (result.range) {
        response.set(
          "Content-Range",
          `bytes ${result.range.start}-${result.range.endInclusive}/${result.size}`,
        );
      }
      for await (const chunk of result.chunks) {
        if (!response.write(chunk)) {
          await once(response, "drain");
        }
      }
      response.end();
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      if (error instanceof ByteRangeError) {
        if (origin) response.set(corsHeaders(origin));
        response
          .status(416)
          .set("Cache-Control", "no-store")
          .set("Accept-Ranges", "bytes");
        if (error.resourceSize !== undefined) {
          response.set("Content-Range", `bytes */${error.resourceSize}`);
        }
        response.json({
          error: { code: error.code, message: error.message },
        });
        return;
      }
      next(error);
    }
  });

  router.put("/", async (request, response, next) => {
    try {
      const identity = authorizeRequest(request, options);
      const origin = requireOrigin(
        request,
        options.appOrigin,
        identity.appId,
      );
      if (!(await options.isAppActive(identity.appId))) {
        throw new AppError(
          "RESOURCE_SESSION_REVOKED",
          "应用已停用或卸载",
          403,
        );
      }
      response.set(corsHeaders(origin));
      const result = await options.resources.write(
        identity.appId,
        readSessionId(request),
        request,
        parseContentLength(request),
      );
      response.set("Cache-Control", "no-store").json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function authorizeRequest(
  request: express.Request,
  options: ResourceContentRouterOptions,
) {
  return options.capabilities.authorizeInstance(readInstanceToken(request));
}

function requireOrigin(
  request: express.Request,
  appOrigin: string,
  appId: string,
): string {
  const expected = appSpecificOrigin(appOrigin, appId);
  if (request.get("origin") !== expected) {
    throw forbidden();
  }
  return expected;
}

function readInstanceToken(request: express.Request): string {
  const authorization = request.get("authorization");
  const match = authorization?.match(/^Biunivers-Instance ([A-Za-z0-9_-]+)$/);
  if (!match) {
    throw new AppError(
      "INSTANCE_TOKEN_REQUIRED",
      "需要应用运行凭据",
      401,
    );
  }
  return match[1];
}

function readSessionId(request: express.Request): string {
  const sessionId = request.get(SESSION_HEADER);
  if (!sessionId) {
    throw new AppError(
      "RESOURCE_SESSION_REQUIRED",
      "需要资源会话",
      401,
    );
  }
  return sessionId;
}

function parseContentLength(request: express.Request): number | undefined {
  const value = request.get("content-length");
  if (value === undefined) return undefined;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new AppError("REQUEST_INVALID", "Content-Length 无效");
  }
  return result;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers":
      "Accept-Ranges, Content-Range, Content-Length",
    Vary: "Origin",
    "Cross-Origin-Resource-Policy": "cross-origin",
  };
}

function forbidden(): AppError {
  return new AppError(
    "ORIGIN_FORBIDDEN",
    "资源请求来源与应用不匹配",
    403,
  );
}
