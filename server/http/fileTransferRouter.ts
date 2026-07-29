import { once } from "node:events";
import express from "express";
import { appSpecificOrigin } from "../apps/appOrigin.js";
import { AppError } from "../apps/appError.js";
import type { FileCapabilityRegistry } from "../files/fileCapabilityRegistry.js";
import type {
  FileTransferService,
  FileWriteResult,
} from "../files/fileTransferService.js";

export interface FileTransferExecutor {
  read(
    instanceToken: string,
    transferId: string,
  ): ReturnType<FileTransferService["read"]>;
  write(
    instanceToken: string,
    transferId: string,
    source: AsyncIterable<Uint8Array>,
    contentLength?: number,
  ): Promise<FileWriteResult>;
}

interface FileTransferRouterOptions {
  appOrigin: string;
  desktopOrigin?: string;
  internalFileAppIds?: ReadonlySet<string>;
  capabilities: FileCapabilityRegistry;
  transfers: FileTransferExecutor;
}

export function createFileTransferRouter(
  options: FileTransferRouterOptions,
): express.Router {
  const router = express.Router();

  router.options("/:transferId", (request, response, next) => {
    try {
      const identity = options.capabilities.inspectTransfer(
        request.params.transferId,
      );
      const origin = requireTransferOrigin(request, options, identity.appId);
      const requestedMethod = request
        .get("access-control-request-method")
        ?.toUpperCase();
      if (requestedMethod !== identity.method) {
        throw new AppError(
          "METHOD_FORBIDDEN",
          "预检方法与传输凭据不匹配",
          403,
        );
      }
      response
        .status(204)
        .set(corsHeaders(origin))
        .set("Access-Control-Allow-Methods", identity.method)
        .set("Access-Control-Allow-Headers", "Authorization, Content-Type")
        .set("Access-Control-Max-Age", "0")
        .end();
    } catch (error) {
      next(error);
    }
  });

  router.get("/:transferId", async (request, response, next) => {
    const instanceToken = readInstanceToken(request);
    try {
      const identity = options.capabilities.inspectTransfer(
        request.params.transferId,
      );
      const origin = requireTransferOrigin(request, options, identity.appId);
      if (identity.method !== "GET") {
        throw new AppError(
          "METHOD_FORBIDDEN",
          "传输凭据不允许 GET",
          405,
        );
      }
      response.set(corsHeaders(origin));
      const transfer = await options.transfers.read(
        instanceToken,
        request.params.transferId,
      );
      response
        .status(200)
        .set("Cache-Control", "no-store")
        .set("Content-Type", "application/octet-stream")
        .set("Content-Length", String(transfer.size));
      for await (const chunk of transfer.chunks) {
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
      next(error);
    }
  });

  router.put("/:transferId", async (request, response, next) => {
    const instanceToken = readInstanceToken(request);
    try {
      const identity = options.capabilities.inspectTransfer(
        request.params.transferId,
      );
      const origin = requireTransferOrigin(request, options, identity.appId);
      if (identity.method !== "PUT") {
        throw new AppError(
          "METHOD_FORBIDDEN",
          "传输凭据不允许 PUT",
          405,
        );
      }
      response.set(corsHeaders(origin));
      const result = await options.transfers.write(
        instanceToken,
        request.params.transferId,
        request,
        parseContentLength(request),
      );
      response
        .set("Cache-Control", "no-store")
        .json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function requireTransferOrigin(
  request: express.Request,
  options: FileTransferRouterOptions,
  appId: string,
): string {
  const internal = options.internalFileAppIds?.has(appId) ?? false;
  const expected = internal
    ? options.desktopOrigin
    : appSpecificOrigin(options.appOrigin, appId);
  if (!expected) {
    throw new AppError(
      "ORIGIN_FORBIDDEN",
      "内部传输未配置可信桌面来源",
      403,
    );
  }
  const origin = request.get("origin");
  const sameOriginGet =
    internal &&
    request.method === "GET" &&
    origin === undefined &&
    request.get("sec-fetch-site") === "same-origin";
  if (origin !== expected && !sameOriginGet) {
    throw new AppError(
      "ORIGIN_FORBIDDEN",
      "传输请求来源与应用不匹配",
      403,
    );
  }
  return expected;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Cross-Origin-Resource-Policy": "cross-origin",
  };
}

function readInstanceToken(request: express.Request): string {
  const authorization = request.get("authorization");
  const match = authorization?.match(/^Biunivers-Instance ([A-Za-z0-9_-]+)$/);
  if (!match) {
    throw new AppError(
      "INSTANCE_TOKEN_REQUIRED",
      "需要窗口实例凭据",
      401,
    );
  }
  return match[1];
}

function parseContentLength(request: express.Request): number | undefined {
  const value = request.get("content-length");
  if (value === undefined) {
    return undefined;
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new AppError("REQUEST_INVALID", "Content-Length 无效");
  }
  return length;
}
