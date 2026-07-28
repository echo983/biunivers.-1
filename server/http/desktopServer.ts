import { resolve } from "node:path";
import express from "express";
import type { AppStore } from "../apps/appStore.js";
import { AppError } from "../apps/appError.js";
import type { AppService } from "../apps/appService.js";
import type { InspectionService } from "../apps/inspectionService.js";
import { projectInstalledApp } from "../apps/projection.js";
import { createAdminAuth } from "../auth/adminAuth.js";
import type { ServerConfig } from "../config.js";

interface DesktopServerDependencies {
  config: ServerConfig;
  appStore: AppStore;
  clientDir: string;
  inspections?: InspectionService;
  appService?: AppService;
}

export function createDesktopServer({
  config,
  appStore,
  clientDir,
  inspections,
  appService,
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

  app.use("/api/v1/admin", createAdminAuth(config.adminToken));

  app.get("/api/v1/admin/apps", async (_request, response, next) => {
    try {
      response.set("Cache-Control", "no-store").json(await appStore.read());
    } catch (error) {
      next(error);
    }
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
