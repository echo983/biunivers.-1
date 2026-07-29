import { resolve } from "node:path";
import express from "express";
import type { AppStore } from "../apps/appStore.js";
import { AppError } from "../apps/appError.js";
import type { AppService } from "../apps/appService.js";
import type { InspectionService } from "../apps/inspectionService.js";
import { projectInstalledApp } from "../apps/projection.js";
import { createAdminAuth } from "../auth/adminAuth.js";
import type { ServerConfig } from "../config.js";
import {
  FileCapabilityRegistry,
  FileCapabilityError,
} from "../files/fileCapabilityRegistry.js";
import type { FileServiceStatus } from "../files/fileServiceRuntime.js";
import {
  createFileTransferRouter,
  type FileTransferExecutor,
} from "./fileTransferRouter.js";

interface DesktopServerDependencies {
  config: ServerConfig;
  appStore: AppStore;
  clientDir: string;
  inspections?: InspectionService;
  appService?: AppService;
  fileServiceStatus?: FileServiceStatus;
  fileCapabilities?: FileCapabilityRegistry;
  fileTransfers?: FileTransferExecutor;
}

export function createDesktopServer({
  config,
  appStore,
  clientDir,
  inspections,
  appService,
  fileServiceStatus,
  fileCapabilities,
  fileTransfers,
}: DesktopServerDependencies) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  app.get("/health", (_request, response) => {
    response.set("Cache-Control", "no-store").json({ status: "ok" });
  });

  app.get("/api/v1/apps", async (_request, response, next) => {
    try {
      const state = await appStore.read();
      response.set("Cache-Control", "no-store").json({
        apps: state.apps
          .filter((installed) => installed.status === "active")
          .map((installed) =>
            projectInstalledApp(installed, config.appOrigin),
          ),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/host/instances", async (request, response, next) => {
    try {
      requireDesktopOrigin(request, config.desktopOrigin);
      if (!fileCapabilities || fileServiceStatus?.mode !== "ready") {
        throw new AppError(
          "HOST_API_UNSUPPORTED",
          "当前宿主尚未启用文件能力",
          503,
        );
      }
      const { appId, windowInstanceId } = request.body as Record<
        string,
        unknown
      >;
      if (typeof appId !== "string" || typeof windowInstanceId !== "string") {
        throw new AppError(
          "REQUEST_INVALID",
          "appId 和 windowInstanceId 必须是字符串",
        );
      }
      const state = await appStore.read();
      if (
        !state.apps.some(
          (installed) =>
            installed.appId === appId && installed.status === "active",
        )
      ) {
        throw new AppError("APP_NOT_FOUND", "应用不存在或未启用", 404);
      }
      response
        .status(201)
        .set("Cache-Control", "no-store")
        .json(fileCapabilities.createInstance(appId, windowInstanceId));
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/v1/host/instances/current", (request, response, next) => {
    try {
      requireDesktopOrigin(request, config.desktopOrigin);
      if (!fileCapabilities) {
        throw new AppError(
          "HOST_API_UNSUPPORTED",
          "当前宿主尚未启用文件能力",
          503,
        );
      }
      const instanceToken = readInstanceToken(request);
      fileCapabilities.closeInstance(instanceToken);
      response.set("Cache-Control", "no-store").status(204).end();
    } catch (error) {
      next(error);
    }
  });

  if (fileCapabilities && fileTransfers) {
    app.use(
      "/api/v1/files/transfers",
      createFileTransferRouter({
        appOrigin: config.appOrigin,
        capabilities: fileCapabilities,
        transfers: fileTransfers,
      }),
    );
  }

  app.use("/api/v1/admin", createAdminAuth(config.adminToken));

  app.get("/api/v1/admin/apps", async (_request, response, next) => {
    try {
      response.set("Cache-Control", "no-store").json(await appStore.read());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/admin/file-service", (_request, response) => {
    response.set("Cache-Control", "no-store").json(
      fileServiceStatus ?? {
        mode: "disabled",
        writable: false,
      },
    );
  });

  if (inspections && appService) {
    app.post("/api/v1/admin/inspections", async (request, response, next) => {
      try {
        const { repository, ref } = request.body as Record<string, unknown>;
        if (typeof repository !== "string" || typeof ref !== "string") {
          throw new AppError(
            "REQUEST_INVALID",
            "repository 和 ref 必须是字符串",
          );
        }
        response.status(201).json(
          await inspections.create(repository, ref),
        );
      } catch (error) {
        next(error);
      }
    });

    app.post("/api/v1/admin/apps", async (request, response, next) => {
      try {
        const { inspectionId, configuration } = request.body as Record<
          string,
          unknown
        >;
        if (typeof inspectionId !== "string") {
          throw new AppError(
            "REQUEST_INVALID",
            "inspectionId 必须是字符串",
          );
        }
        response.status(201).json(
          await appService.install(inspectionId, configuration ?? {}),
        );
      } catch (error) {
        next(error);
      }
    });

    app.put(
      "/api/v1/admin/apps/:appId/version",
      async (request, response, next) => {
        try {
          const { inspectionId, configuration } = request.body as Record<
            string,
            unknown
          >;
          if (typeof inspectionId !== "string") {
            throw new AppError(
              "REQUEST_INVALID",
              "inspectionId 必须是字符串",
            );
          }
          response.json(
            await appService.update(
              request.params.appId,
              inspectionId,
              configuration ?? {},
            ),
          );
        } catch (error) {
          next(error);
        }
      },
    );

    app.patch(
      "/api/v1/admin/apps/:appId",
      async (request, response, next) => {
        try {
          if (
            typeof request.body !== "object" ||
            request.body === null ||
            Array.isArray(request.body)
          ) {
            throw new AppError("REQUEST_INVALID", "请求体必须是对象");
          }
          const body = request.body as Record<string, unknown>;
          const unknownKeys = Object.keys(body).filter(
            (key) => key !== "configuration" && key !== "status",
          );
          if (unknownKeys.length > 0) {
            throw new AppError(
              "REQUEST_INVALID",
              `不支持的字段：${unknownKeys.join("、")}`,
            );
          }
          response.json(
            await appService.patch(request.params.appId, {
              ...(Object.hasOwn(body, "configuration")
                ? { configuration: body.configuration }
                : {}),
              ...(Object.hasOwn(body, "status")
                ? { status: body.status }
                : {}),
            }),
          );
        } catch (error) {
          next(error);
        }
      },
    );

    app.delete(
      "/api/v1/admin/apps/:appId",
      async (request, response, next) => {
        try {
          await appService.uninstall(request.params.appId);
          response.status(204).end();
        } catch (error) {
          next(error);
        }
      },
    );
  }

  app.use(express.static(clientDir, { index: false }));
  app.use((request, response, next) => {
    if (request.method !== "GET" || request.path.startsWith("/api/")) {
      next();
      return;
    }
    response.set("Cache-Control", "no-cache");
    response.sendFile(resolve(clientDir, "index.html"));
  });

  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      void _next;
      if (error instanceof AppError) {
        response.status(error.status).json({
          error: {
            code: error.code,
            message: error.message,
            ...(error.details === undefined
              ? {}
              : { details: error.details }),
          },
        });
        return;
      }
      if (error instanceof FileCapabilityError) {
        const status = {
          HANDLE_NOT_FOUND: 404,
          HANDLE_EXPIRED: 410,
          TRANSFER_NOT_FOUND: 404,
          TRANSFER_EXPIRED: 410,
          TRANSFER_TOO_LARGE: 413,
          PERMISSION_DENIED: 403,
          CAPABILITY_LIMIT_REACHED: 429,
          REQUEST_INVALID: 400,
        }[error.code];
        response.status(status)
          .json({
            error: {
              code: error.code,
              message: error.message,
            },
          });
        return;
      }
      console.error("Desktop server request failed", error);
      response.status(500).json({
        error: {
          code: "INTERNAL_ERROR",
          message: "服务器内部错误",
        },
      });
    },
  );

  return app;
}

function requireDesktopOrigin(
  request: express.Request,
  desktopOrigin: string,
): void {
  if (
    request.get("origin") !== desktopOrigin ||
    !["same-origin", "none", undefined].includes(
      request.get("sec-fetch-site"),
    )
  ) {
    throw new AppError(
      "ORIGIN_FORBIDDEN",
      "窗口实例只能由可信桌面页面创建",
      403,
    );
  }
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
