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
import type { FileServiceBackupResult } from "../files/fileServiceBackup.js";
import type { FileServiceGcReport } from "../files/fileServiceGcScanner.js";
import type { InternalFileManagerService } from "../files/internalFileManagerService.js";
import type { FileHostService } from "../files/fileHostService.js";
import type { OpenResourceResolver } from "../openResource/openResourceResolver.js";
import type { OpenResourceLaunchService } from "../openResource/openResourceLaunchService.js";
import { OpenResourceError } from "../openResource/openResourceLaunchRegistry.js";
import {
  createFileTransferRouter,
  type FileTransferExecutor,
} from "./fileTransferRouter.js";
import type { DesktopSurfaceService } from "../desktopSurface/desktopSurfaceService.js";
import { DesktopSurfaceError } from "../desktopSurface/desktopSurfaceStore.js";
import {
  ResourceSessionError,
  type PublicResourceSession,
  type ResourceSessionRegistry,
} from "../resources/resourceSessionRegistry.js";
import type { ResourceSessionService } from "../resources/resourceSessionService.js";
import {
  createResourceContentRouter,
  type ResourceContentExecutor,
} from "./resourceContentRouter.js";
import { appSpecificOrigin } from "../apps/appOrigin.js";
import type { WormholeControlService } from "../wormhole/wormholeControlService.js";
import { WormholeRuntimeError } from "../wormhole/wormholeRuntime.js";
import type { Router } from "express";

type InternalFileManagerExecutor = Pick<
  InternalFileManagerService,
  | "createDirectory"
  | "createFile"
  | "copyFile"
  | "moveEntry"
  | "removeEntry"
  | "moveEntries"
  | "copyEntries"
  | "removeEntries"
>;
type InternalZipExporter = Pick<
  InternalFileManagerService,
  "createZipExport"
>;
type WormholeControlExecutor = Pick<
  WormholeControlService,
  "status" | "enable" | "rotate" | "disable"
>;
type OpenResourceResolverExecutor = Pick<
  OpenResourceResolver,
  "resolve" | "resolveMany"
>;
type OpenResourceLaunchExecutor = Pick<
  OpenResourceLaunchService,
  | "create"
  | "createMany"
  | "claim"
  | "claimResourceSession"
  | "cancelTarget"
>;

interface DesktopServerDependencies {
  config: ServerConfig;
  appStore: AppStore;
  clientDir: string;
  inspections?: InspectionService;
  appService?: AppService;
  fileServiceStatus?: FileServiceStatus;
  getFileServiceStatus?: () => Promise<FileServiceStatus>;
  fileCapabilities?: FileCapabilityRegistry;
  fileTransfers?: FileTransferExecutor;
  resourceContent?: ResourceContentExecutor;
  resourceSessionService?: ResourceSessionService;
  resourceSessions?: ResourceSessionRegistry;
  fileHost?: FileHostService;
  fileServiceBackup?: {
    createLatest(): Promise<FileServiceBackupResult>;
  };
  fileServiceGcScanner?: {
    scan(): Promise<FileServiceGcReport>;
  };
  internalFileAppIds?: ReadonlySet<string>;
  internalFileManager?: InternalFileManagerExecutor;
  internalZipExporter?: InternalZipExporter;
  wormholeControl?: WormholeControlExecutor;
  wormholeRouter?: Router;
  openResourceResolver?: OpenResourceResolverExecutor;
  openResourceLaunchService?: OpenResourceLaunchExecutor;
  desktopSurface?: DesktopSurfaceService;
}

export function createDesktopServer({
  config,
  appStore,
  clientDir,
  inspections,
  appService,
  fileServiceStatus,
  getFileServiceStatus,
  fileCapabilities,
  fileTransfers,
  resourceContent,
  resourceSessionService,
  resourceSessions,
  fileHost,
  fileServiceBackup,
  fileServiceGcScanner,
  internalFileAppIds = new Set(),
  internalFileManager,
  internalZipExporter,
  wormholeControl,
  wormholeRouter,
  openResourceResolver,
  openResourceLaunchService,
  desktopSurface,
}: DesktopServerDependencies) {
  const app = express();
  app.disable("x-powered-by");
  if (wormholeRouter) {
    app.use("/wormhole/webdav", wormholeRouter);
  }
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

  app.get("/api/v1/internal/wormhole", (request, response, next) => {
    try {
      const { service, instanceToken } = requireWormholeControl(
        request,
        config,
        wormholeControl,
      );
      response
        .set("Cache-Control", "no-store")
        .json(service.status(instanceToken));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/internal/wormhole/enable", (request, response, next) => {
    try {
      const { service, instanceToken } = requireWormholeControl(
        request,
        config,
        wormholeControl,
      );
      response
        .set("Cache-Control", "no-store")
        .json(service.enable(instanceToken));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/internal/wormhole/rotate", (request, response, next) => {
    try {
      const { service, instanceToken } = requireWormholeControl(
        request,
        config,
        wormholeControl,
      );
      response
        .set("Cache-Control", "no-store")
        .json(service.rotate(instanceToken));
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/v1/internal/wormhole", (request, response, next) => {
    try {
      const { service, instanceToken } = requireWormholeControl(
        request,
        config,
        wormholeControl,
      );
      response
        .set("Cache-Control", "no-store")
        .json(service.disable(instanceToken));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/desktop-surface", async (request, response, next) => {
    try {
      requireDesktopOrigin(request, config.desktopOrigin);
      if (!desktopSurface) {
        throw new AppError(
          "DESKTOP_SURFACE_UNSUPPORTED",
          "当前宿主尚未启用桌面项目管理",
          503,
        );
      }
      response
        .set("Cache-Control", "no-store")
        .json(desktopSurface.read());
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/v1/desktop-surface/resolve",
    async (request, response, next) => {
      try {
        requireDesktopOrigin(request, config.desktopOrigin);
        if (!desktopSurface) {
          throw new AppError(
            "DESKTOP_SURFACE_UNSUPPORTED",
            "当前宿主尚未启用桌面项目管理",
            503,
          );
        }
        response
          .set("Cache-Control", "no-store")
          .json(await desktopSurface.resolve());
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/v1/desktop-surface/items",
    async (request, response, next) => {
      try {
        requireDesktopOrigin(request, config.desktopOrigin);
        if (!desktopSurface) {
          throw new AppError(
            "DESKTOP_SURFACE_UNSUPPORTED",
            "当前宿主尚未启用桌面项目管理",
            503,
          );
        }
        const { target, position, expectedRevision } =
          request.body as Record<string, unknown>;
        response
          .status(201)
          .set("Cache-Control", "no-store")
          .json(
            await desktopSurface.add(
              target as never,
              position as never,
              expectedRevision as number,
            ),
          );
      } catch (error) {
        next(error);
      }
    },
  );

  app.patch(
    "/api/v1/desktop-surface/layout",
    (request, response, next) => {
      try {
        requireDesktopOrigin(request, config.desktopOrigin);
        if (!desktopSurface) {
          throw new AppError(
            "DESKTOP_SURFACE_UNSUPPORTED",
            "当前宿主尚未启用桌面项目管理",
            503,
          );
        }
        const { moves, expectedRevision } =
          request.body as Record<string, unknown>;
        response
          .set("Cache-Control", "no-store")
          .json(
            desktopSurface.move(
              moves as never,
              expectedRevision as number,
            ),
          );
      } catch (error) {
        next(error);
      }
    },
  );

  app.delete(
    "/api/v1/desktop-surface/items",
    (request, response, next) => {
      try {
        requireDesktopOrigin(request, config.desktopOrigin);
        if (!desktopSurface) {
          throw new AppError(
            "DESKTOP_SURFACE_UNSUPPORTED",
            "当前宿主尚未启用桌面项目管理",
            503,
          );
        }
        const { itemIds, expectedRevision } =
          request.body as Record<string, unknown>;
        response
          .set("Cache-Control", "no-store")
          .json(
            desktopSurface.remove(
              itemIds as never,
              expectedRevision as number,
            ),
          );
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/v1/desktop-surface/reset",
    async (request, response, next) => {
      try {
        requireDesktopOrigin(request, config.desktopOrigin);
        if (!desktopSurface) {
          throw new AppError(
            "DESKTOP_SURFACE_UNSUPPORTED",
            "当前宿主尚未启用桌面项目管理",
            503,
          );
        }
        const { expectedRevision } =
          request.body as Record<string, unknown>;
        response
          .set("Cache-Control", "no-store")
          .json(
            await desktopSurface.reset(expectedRevision as number),
          );
      } catch (error) {
        next(error);
      }
    },
  );

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
      const activeManagedApp = state.apps.some(
        (installed) =>
          installed.appId === appId && installed.status === "active",
      );
      if (!activeManagedApp && !internalFileAppIds.has(appId)) {
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
      const identity = fileCapabilities.authorizeInstance(instanceToken);
      openResourceLaunchService?.cancelTarget(identity.appId);
      fileCapabilities.closeInstance(instanceToken);
      response.set("Cache-Control", "no-store").status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/host/files", async (request, response, next) => {
    try {
      const { service, instanceToken } = requireFileHost(
        request,
        config,
        fileHost,
      );
      const parent = request.query.parent;
      if (parent !== undefined && typeof parent !== "string") {
        throw new AppError("REQUEST_INVALID", "parent 必须是字符串");
      }
      response
        .set("Cache-Control", "no-store")
        .json(await service.listDirectory(instanceToken, parent));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/host/handles", async (request, response, next) => {
    try {
      const { service, instanceToken } = requireFileHost(
        request,
        config,
        fileHost,
      );
      const { entryId, writable } = request.body as Record<string, unknown>;
      if (typeof entryId !== "string" || typeof writable !== "boolean") {
        throw new AppError(
          "REQUEST_INVALID",
          "entryId 必须是字符串且 writable 必须是布尔值",
        );
      }
      response
        .status(201)
        .set("Cache-Control", "no-store")
        .json(await service.issueHandle(instanceToken, entryId, writable));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/host/save-handles", async (request, response, next) => {
    try {
      const { service, instanceToken } = requireFileHost(
        request,
        config,
        fileHost,
      );
      const { parentEntryId, name } = request.body as Record<string, unknown>;
      if (
        typeof parentEntryId !== "string" ||
        typeof name !== "string"
      ) {
        throw new AppError(
          "REQUEST_INVALID",
          "parentEntryId 和 name 必须是字符串",
        );
      }
      response
        .status(201)
        .set("Cache-Control", "no-store")
        .json(
          await service.issueSaveHandle(
            instanceToken,
            parentEntryId,
            name,
          ),
        );
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/host/handles/:handleId", async (request, response, next) => {
    try {
      const { service, instanceToken } = requireFileHost(
        request,
        config,
        fileHost,
      );
      response
        .set("Cache-Control", "no-store")
        .json(
          await service.getMetadata(
            instanceToken,
            request.params.handleId,
          ),
        );
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/v1/host/handles/:handleId", (request, response, next) => {
    try {
      const { service, instanceToken } = requireFileHost(
        request,
        config,
        fileHost,
      );
      service.releaseHandle(instanceToken, request.params.handleId);
      response.set("Cache-Control", "no-store").status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/host/transfers", (request, response, next) => {
    try {
      const { service, instanceToken } = requireFileHost(
        request,
        config,
        fileHost,
      );
      const { handleId, method } = request.body as Record<string, unknown>;
      if (
        typeof handleId !== "string" ||
        (method !== "GET" && method !== "PUT")
      ) {
        throw new AppError(
          "REQUEST_INVALID",
          "handleId 和 GET/PUT method 必填",
        );
      }
      const transfer = service.issueTransfer(
        instanceToken,
        handleId,
        method,
      );
      response
        .status(201)
        .set("Cache-Control", "no-store")
        .json({
          ...transfer,
          url: `${config.desktopOrigin}/api/v1/files/transfers/${transfer.transferId}`,
          authorization: "Biunivers-Instance",
          instanceToken,
        });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/v1/host/resource-sessions",
    async (request, response, next) => {
      try {
        requireDesktopOrigin(request, config.desktopOrigin);
        if (!resourceSessionService) throw resourceUnsupported();
        const instanceToken = readInstanceToken(request);
        const { entryId, access } = request.body as Record<string, unknown>;
        if (
          typeof entryId !== "string" ||
          (access !== "read" && access !== "edit")
        ) {
          throw new AppError(
            "REQUEST_INVALID",
            "entryId 和 read/edit access 必填",
          );
        }
        response
          .status(201)
          .set("Cache-Control", "no-store")
          .json(
            presentResourceSession(
              await resourceSessionService.issueFile(
                instanceToken,
                entryId,
                access,
              ),
              instanceToken,
              config.desktopOrigin,
            ),
          );
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/v1/host/resource-sessions/save-targets",
    async (request, response, next) => {
      try {
        requireDesktopOrigin(request, config.desktopOrigin);
        if (!resourceSessionService) throw resourceUnsupported();
        const instanceToken = readInstanceToken(request);
        const { parentEntryId, name } = request.body as Record<
          string,
          unknown
        >;
        if (
          typeof parentEntryId !== "string" ||
          typeof name !== "string"
        ) {
          throw new AppError(
            "REQUEST_INVALID",
            "parentEntryId 和 name 必填",
          );
        }
        response
          .status(201)
          .set("Cache-Control", "no-store")
          .json(
            presentResourceSession(
              await resourceSessionService.issueSaveTarget(
                instanceToken,
                parentEntryId,
                name,
              ),
              instanceToken,
              config.desktopOrigin,
            ),
          );
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/v1/host/resource-sessions/batches",
    async (request, response, next) => {
      try {
        requireDesktopOrigin(request, config.desktopOrigin);
        if (!resourceSessionService) throw resourceUnsupported();
        const instanceToken = readInstanceToken(request);
        const { entryIds, access } = request.body as Record<
          string,
          unknown
        >;
        if (!Array.isArray(entryIds) || access !== "read") {
          throw new AppError(
            "REQUEST_INVALID",
            "entryIds 和 read access 必填",
          );
        }
        const resources = await resourceSessionService.issueFiles(
          instanceToken,
          entryIds as string[],
        );
        response
          .status(201)
          .set("Cache-Control", "no-store")
          .json({
            resources: resources.map((resource) =>
              presentResourceSession(
                resource,
                instanceToken,
                config.desktopOrigin,
              ),
            ),
          });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/v1/host/resource-sessions/metadata",
    async (request, response, next) => {
      try {
        requireDesktopOrigin(request, config.desktopOrigin);
        if (!resourceSessionService) throw resourceUnsupported();
        const instanceToken = readInstanceToken(request);
        const { sessionId } = request.body as Record<string, unknown>;
        if (typeof sessionId !== "string") {
          throw new AppError("REQUEST_INVALID", "sessionId 必填");
        }
        response
          .set("Cache-Control", "no-store")
          .json(
            presentResourceSession(
              await resourceSessionService.metadata(
                instanceToken,
                sessionId,
              ),
              instanceToken,
              config.desktopOrigin,
            ),
          );
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/v1/host/resource-sessions/renew",
    async (request, response, next) => {
      try {
        requireDesktopOrigin(request, config.desktopOrigin);
        if (!resourceSessionService) throw resourceUnsupported();
        const instanceToken = readInstanceToken(request);
        const { sessionIds } = request.body as Record<string, unknown>;
        if (
          !Array.isArray(sessionIds) ||
          sessionIds.some((value) => typeof value !== "string")
        ) {
          throw new AppError("REQUEST_INVALID", "sessionIds 必须是字符串数组");
        }
        response
          .set("Cache-Control", "no-store")
          .json(
            await resourceSessionService.renew(
              instanceToken,
              sessionIds as string[],
            ),
          );
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/v1/host/resource-sessions/release",
    async (request, response, next) => {
      try {
        requireDesktopOrigin(request, config.desktopOrigin);
        if (!resourceSessionService) throw resourceUnsupported();
        const instanceToken = readInstanceToken(request);
        const { sessionIds } = request.body as Record<string, unknown>;
        if (
          !Array.isArray(sessionIds) ||
          sessionIds.some((value) => typeof value !== "string")
        ) {
          throw new AppError("REQUEST_INVALID", "sessionIds 必须是字符串数组");
        }
        await resourceSessionService.release(
          instanceToken,
          sessionIds as string[],
        );
        response.set("Cache-Control", "no-store").status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/v1/host/resource-sessions/launches/claim",
    async (request, response, next) => {
      try {
        requireDesktopOrigin(request, config.desktopOrigin);
        if (!openResourceLaunchService || !resourceSessionService) {
          throw resourceUnsupported();
        }
        const instanceToken = readInstanceToken(request);
        const { launchId } = request.body as Record<string, unknown>;
        if (typeof launchId !== "string") {
          throw new AppError("REQUEST_INVALID", "launchId 必填");
        }
        const result =
          await openResourceLaunchService.claimResourceSession(
            instanceToken,
            launchId,
          );
        response.set("Cache-Control", "no-store");
        if ("resources" in result) {
          response.json({
            action: result.action,
            resources: result.resources.map((resource) =>
              presentResourceSession(
                resource,
                instanceToken,
                config.desktopOrigin,
              ),
            ),
          });
        } else {
          response.json({
            action: result.action,
            resource: presentResourceSession(
              result.resource,
              instanceToken,
              config.desktopOrigin,
            ),
          });
        }
      } catch (error) {
        next(error);
      }
    },
  );

  if (fileCapabilities && fileTransfers) {
    app.use(
      "/api/v1/files/transfers",
      createFileTransferRouter({
        appOrigin: config.appOrigin,
        desktopOrigin: config.desktopOrigin,
        internalFileAppIds,
        capabilities: fileCapabilities,
        transfers: fileTransfers,
      }),
    );
  }

  if (fileCapabilities && resourceContent) {
    app.use(
      "/api/v1/resource-content",
      createResourceContentRouter({
        appOrigin: config.appOrigin,
        capabilities: fileCapabilities,
        resources: resourceContent,
        isAppActive: async (appId) =>
          (await appStore.read()).apps.some(
            (app) => app.appId === appId && app.status === "active",
          ),
        resolveAppIdForOrigin: async (origin) =>
          (await appStore.read()).apps.find(
            (app) =>
              app.status === "active" &&
              appSpecificOrigin(config.appOrigin, app.appId) === origin,
          )?.appId,
      }),
    );
  }

  app.post(
    "/api/v1/internal/files/exports/zip",
    async (request, response, next) => {
      try {
        const { service, instanceToken } = requireInternalZipExporter(
          request,
          config,
          internalZipExporter,
        );
        const { entryIds, expectedRevision } =
          request.body as Record<string, unknown>;
        if (
          !Array.isArray(entryIds) ||
          entryIds.some((entryId) => typeof entryId !== "string") ||
          !isRevision(expectedRevision)
        ) {
          throw new AppError(
            "REQUEST_INVALID",
            "entryIds 和 expectedRevision 必填",
          );
        }
        const exported = await service.createZipExport(instanceToken, {
          entryIds: entryIds as string[],
          expectedRevision,
        });
        response.status(200).set({
          "Cache-Control": "no-store",
          "Content-Type": "application/zip",
          "Content-Disposition": contentDisposition(exported.fileName),
          "Content-Length": String(exported.archive.size),
          "X-Biunivers-Export-Entries": String(exported.entryCount),
          "X-Biunivers-Export-Revision": String(exported.revision),
        });
        for await (const chunk of exported.archive.stream) {
          if (request.aborted || response.destroyed) return;
          if (!response.write(chunk)) {
            await waitForDrain(response);
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
    },
  );

  app.post(
    "/api/v1/internal/files/files",
    async (request, response, next) => {
      try {
        const { service, instanceToken } = requireInternalFileManager(
          request,
          config,
          internalFileManager,
        );
        const { parentEntryId, name, expectedRevision } =
          request.body as Record<string, unknown>;
        if (
          typeof parentEntryId !== "string" ||
          typeof name !== "string" ||
          !isRevision(expectedRevision)
        ) {
          throw new AppError(
            "REQUEST_INVALID",
            "parentEntryId、name 和 expectedRevision 必填",
          );
        }
        response
          .status(201)
          .set("Cache-Control", "no-store")
          .json(
            await service.createFile(instanceToken, {
              parentEntryId,
              name,
              expectedRevision,
            }),
          );
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/v1/internal/files/entries/:entryId/copies",
    async (request, response, next) => {
      try {
        const { service, instanceToken } = requireInternalFileManager(
          request,
          config,
          internalFileManager,
        );
        const { newParentEntryId, newName, expectedRevision } =
          request.body as Record<string, unknown>;
        if (
          typeof newParentEntryId !== "string" ||
          typeof newName !== "string" ||
          !isRevision(expectedRevision)
        ) {
          throw new AppError(
            "REQUEST_INVALID",
            "newParentEntryId、newName 和 expectedRevision 必填",
          );
        }
        response
          .status(201)
          .set("Cache-Control", "no-store")
          .json(
            await service.copyFile(
              instanceToken,
              request.params.entryId,
              { newParentEntryId, newName, expectedRevision },
            ),
          );
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/v1/internal/files/directories",
    async (request, response, next) => {
      try {
        const { service, instanceToken } = requireInternalFileManager(
          request,
          config,
          internalFileManager,
        );
        const { parentEntryId, name, expectedRevision } =
          request.body as Record<string, unknown>;
        if (
          typeof parentEntryId !== "string" ||
          typeof name !== "string" ||
          !isRevision(expectedRevision)
        ) {
          throw new AppError(
            "REQUEST_INVALID",
            "parentEntryId、name 和 expectedRevision 必填",
          );
        }
        response
          .status(201)
          .set("Cache-Control", "no-store")
          .json(
            await service.createDirectory(instanceToken, {
              parentEntryId,
              name,
              expectedRevision,
            }),
          );
      } catch (error) {
        next(error);
      }
    },
  );

  app.patch(
    "/api/v1/internal/files/entries/:entryId",
    async (request, response, next) => {
      try {
        const { service, instanceToken } = requireInternalFileManager(
          request,
          config,
          internalFileManager,
        );
        const { newParentEntryId, newName, expectedRevision } =
          request.body as Record<string, unknown>;
        if (
          typeof newParentEntryId !== "string" ||
          typeof newName !== "string" ||
          !isRevision(expectedRevision)
        ) {
          throw new AppError(
            "REQUEST_INVALID",
            "newParentEntryId、newName 和 expectedRevision 必填",
          );
        }
        response
          .set("Cache-Control", "no-store")
          .json(
            await service.moveEntry(
              instanceToken,
              request.params.entryId,
              { newParentEntryId, newName, expectedRevision },
            ),
          );
      } catch (error) {
        next(error);
      }
    },
  );

  app.delete(
    "/api/v1/internal/files/entries/:entryId",
    async (request, response, next) => {
      try {
        const { service, instanceToken } = requireInternalFileManager(
          request,
          config,
          internalFileManager,
        );
        const { recursive, expectedRevision } =
          request.body as Record<string, unknown>;
        if (
          typeof recursive !== "boolean" ||
          !isRevision(expectedRevision)
        ) {
          throw new AppError(
            "REQUEST_INVALID",
            "recursive 和 expectedRevision 必填",
          );
        }
        response
          .set("Cache-Control", "no-store")
          .json(
            await service.removeEntry(
              instanceToken,
              request.params.entryId,
              { recursive, expectedRevision },
            ),
          );
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/v1/internal/files/batch/move",
    async (request, response, next) => {
      try {
        const { service, instanceToken } = requireInternalFileManager(
          request,
          config,
          internalFileManager,
        );
        const { entryIds, newParentEntryId, expectedRevision } =
          request.body as Record<string, unknown>;
        if (
          !Array.isArray(entryIds) ||
          typeof newParentEntryId !== "string" ||
          !isRevision(expectedRevision)
        ) {
          throw new AppError(
            "REQUEST_INVALID",
            "entryIds、newParentEntryId 和 expectedRevision 必填",
          );
        }
        response
          .set("Cache-Control", "no-store")
          .json(
            await service.moveEntries(instanceToken, {
              entryIds: entryIds as string[],
              newParentEntryId,
              expectedRevision,
            }),
          );
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/v1/internal/files/batch/copy",
    async (request, response, next) => {
      try {
        const { service, instanceToken } = requireInternalFileManager(
          request,
          config,
          internalFileManager,
        );
        const { entryIds, newParentEntryId, expectedRevision } =
          request.body as Record<string, unknown>;
        if (
          !Array.isArray(entryIds) ||
          typeof newParentEntryId !== "string" ||
          !isRevision(expectedRevision)
        ) {
          throw new AppError(
            "REQUEST_INVALID",
            "entryIds、newParentEntryId 和 expectedRevision 必填",
          );
        }
        response
          .status(201)
          .set("Cache-Control", "no-store")
          .json(
            await service.copyEntries(instanceToken, {
              entryIds: entryIds as string[],
              newParentEntryId,
              expectedRevision,
            }),
          );
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/v1/internal/files/batch/remove",
    async (request, response, next) => {
      try {
        const { service, instanceToken } = requireInternalFileManager(
          request,
          config,
          internalFileManager,
        );
        const { entryIds, expectedRevision } =
          request.body as Record<string, unknown>;
        if (!Array.isArray(entryIds) || !isRevision(expectedRevision)) {
          throw new AppError(
            "REQUEST_INVALID",
            "entryIds 和 expectedRevision 必填",
          );
        }
        response
          .set("Cache-Control", "no-store")
          .json(
            await service.removeEntries(instanceToken, {
              entryIds: entryIds as string[],
              expectedRevision,
            }),
          );
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/v1/internal/open-resources/resolve",
    async (request, response, next) => {
      try {
        requireDesktopOrigin(request, config.desktopOrigin);
        if (!openResourceResolver) {
          throw new AppError(
            "HOST_API_UNSUPPORTED",
            "当前宿主尚未启用资源打开能力",
            503,
          );
        }
        const instanceToken = readInstanceToken(request);
        const { entryId, expectedRevision, requestedAction } =
          request.body as Record<string, unknown>;
        if (
          typeof entryId !== "string" ||
          !isRevision(expectedRevision) ||
          (requestedAction !== "open" && requestedAction !== "edit")
        ) {
          throw new AppError(
            "REQUEST_INVALID",
            "entryId、expectedRevision 和 requestedAction 必填",
          );
        }
        response
          .set("Cache-Control", "no-store")
          .json(
            await openResourceResolver.resolve(instanceToken, {
              entryId,
              expectedRevision,
              requestedAction,
            }),
          );
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/v1/internal/open-resources/resolve-many",
    async (request, response, next) => {
      try {
        requireDesktopOrigin(request, config.desktopOrigin);
        if (!openResourceResolver) {
          throw new AppError(
            "HOST_API_UNSUPPORTED",
            "当前宿主尚未启用资源打开能力",
            503,
          );
        }
        const instanceToken = readInstanceToken(request);
        const { entryIds, expectedRevision, requestedAction } =
          request.body as Record<string, unknown>;
        if (
          !Array.isArray(entryIds) ||
          !isRevision(expectedRevision) ||
          requestedAction !== "open"
        ) {
          throw new AppError(
            "REQUEST_INVALID",
            "entryIds、expectedRevision 和 open requestedAction 必填",
          );
        }
        response
          .set("Cache-Control", "no-store")
          .json(
            await openResourceResolver.resolveMany(instanceToken, {
              entryIds: entryIds as string[],
              expectedRevision,
              requestedAction,
            }),
          );
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/v1/internal/open-resources",
    async (request, response, next) => {
      try {
        requireDesktopOrigin(request, config.desktopOrigin);
        if (!openResourceLaunchService) {
          throw new AppError(
            "HOST_API_UNSUPPORTED",
            "当前宿主尚未启用资源打开能力",
            503,
          );
        }
        const instanceToken = readInstanceToken(request);
        const {
          entryId,
          expectedRevision,
          targetAppId,
          handlerId,
          action,
        } = request.body as Record<string, unknown>;
        if (
          typeof entryId !== "string" ||
          !isRevision(expectedRevision) ||
          typeof targetAppId !== "string" ||
          typeof handlerId !== "string" ||
          (action !== "open" && action !== "edit")
        ) {
          throw new AppError(
            "REQUEST_INVALID",
            "entryId、expectedRevision、targetAppId、handlerId 和 action 必填",
          );
        }
        response
          .status(201)
          .set("Cache-Control", "no-store")
          .json(
            await openResourceLaunchService.create(instanceToken, {
              entryId,
              expectedRevision,
              targetAppId,
              handlerId,
              action,
            }),
          );
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/v1/internal/open-resources/batches",
    async (request, response, next) => {
      try {
        requireDesktopOrigin(request, config.desktopOrigin);
        if (!openResourceLaunchService) {
          throw new AppError(
            "HOST_API_UNSUPPORTED",
            "当前宿主尚未启用资源打开能力",
            503,
          );
        }
        const instanceToken = readInstanceToken(request);
        const {
          entryIds,
          expectedRevision,
          targetAppId,
          handlerId,
          action,
        } = request.body as Record<string, unknown>;
        if (
          !Array.isArray(entryIds) ||
          !isRevision(expectedRevision) ||
          typeof targetAppId !== "string" ||
          typeof handlerId !== "string" ||
          action !== "open"
        ) {
          throw new AppError(
            "REQUEST_INVALID",
            "entryIds、expectedRevision、targetAppId、handlerId 和 open action 必填",
          );
        }
        response
          .status(201)
          .set("Cache-Control", "no-store")
          .json(
            await openResourceLaunchService.createMany(instanceToken, {
              entryIds: entryIds as string[],
              expectedRevision,
              targetAppId,
              handlerId,
              action,
            }),
          );
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/v1/host/open-resources/claim",
    async (request, response, next) => {
      try {
        requireDesktopOrigin(request, config.desktopOrigin);
        if (!openResourceLaunchService) {
          throw new AppError(
            "OPEN_RESOURCE_UNSUPPORTED",
            "当前宿主尚未启用资源打开能力",
            503,
          );
        }
        const instanceToken = readInstanceToken(request);
        const { launchId } = request.body as Record<string, unknown>;
        if (typeof launchId !== "string") {
          throw new AppError("REQUEST_INVALID", "launchId 必填");
        }
        response
          .set("Cache-Control", "no-store")
          .json(
            await openResourceLaunchService.claim(
              instanceToken,
              launchId,
            ),
          );
      } catch (error) {
        next(error);
      }
    },
  );

  app.use("/api/v1/admin", createAdminAuth(config.adminToken));

  app.get("/api/v1/admin/apps", async (_request, response, next) => {
    try {
      response.set("Cache-Control", "no-store").json(await appStore.read());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/admin/file-service", async (_request, response, next) => {
    try {
      response.set("Cache-Control", "no-store").json(
        getFileServiceStatus
          ? await getFileServiceStatus()
          : fileServiceStatus ?? {
              mode: "disabled",
              writable: false,
            },
      );
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/v1/admin/file-service/backups",
    async (_request, response, next) => {
      try {
        if (!fileServiceBackup) {
          throw new AppError(
            "HOST_API_UNSUPPORTED",
            "当前宿主尚未启用文件备份能力",
            503,
          );
        }
        response
          .status(201)
          .set("Cache-Control", "no-store")
          .json(await fileServiceBackup.createLatest());
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/v1/admin/file-service/gc-reports",
    async (_request, response, next) => {
      try {
        if (!fileServiceGcScanner) {
          throw new AppError(
            "HOST_API_UNSUPPORTED",
            "当前宿主尚未启用文件 GC 报告能力",
            503,
          );
        }
        response
          .status(201)
          .set("Cache-Control", "no-store")
          .json(await fileServiceGcScanner.scan());
      } catch (error) {
        next(error);
      }
    },
  );

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
          const updated = await appService.update(
              request.params.appId,
              inspectionId,
              configuration ?? {},
            );
          openResourceLaunchService?.cancelTarget(request.params.appId);
          resourceSessions?.revokeApp(request.params.appId);
          response.json(updated);
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
          const updated = await appService.patch(request.params.appId, {
              ...(Object.hasOwn(body, "configuration")
                ? { configuration: body.configuration }
                : {}),
              ...(Object.hasOwn(body, "status")
                ? { status: body.status }
                : {}),
            });
          if (updated.status === "disabled") {
            openResourceLaunchService?.cancelTarget(request.params.appId);
            resourceSessions?.revokeApp(request.params.appId);
          }
          response.json(updated);
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
          openResourceLaunchService?.cancelTarget(request.params.appId);
          resourceSessions?.revokeApp(request.params.appId);
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
          FILE_VERSION_CONFLICT: 409,
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
      if (error instanceof WormholeRuntimeError) {
        response.status(409).json({
          error: {
            code: error.code,
            message: error.message,
          },
        });
        return;
      }
      if (error instanceof ResourceSessionError) {
        const status = {
          REQUEST_INVALID: 400,
          RESOURCE_SESSION_NOT_FOUND: 404,
          RESOURCE_SESSION_EXPIRED: 410,
          RESOURCE_SESSION_REVOKED: 403,
          RESOURCE_ACCESS_DENIED: 403,
          RESOURCE_TRANSFER_TOO_LARGE: 413,
          FILE_VERSION_CONFLICT: 409,
          RESOURCE_SESSION_LIMIT_REACHED: 429,
        }[error.code];
        response.status(status).json({
          error: {
            code: error.code,
            message: error.message,
          },
        });
        return;
      }
      if (error instanceof OpenResourceError) {
        const status = {
          LAUNCH_CONTEXT_EXPIRED: 410,
          NO_LAUNCH_CONTEXT: 404,
          RESOURCE_OPEN_BUSY: 409,
          HANDLER_NOT_AVAILABLE: 409,
          CAPABILITY_LIMIT_REACHED: 429,
        }[error.code];
        response.status(status).json({
          error: {
            code: error.code,
            message: error.message,
          },
        });
        return;
      }
      if (error instanceof DesktopSurfaceError) {
        const status = {
          DESKTOP_SURFACE_INVALID: 400,
          DESKTOP_SURFACE_CONFLICT: 409,
          DESKTOP_ITEM_NOT_FOUND: 404,
          DESKTOP_TARGET_EXISTS: 409,
        }[error.code];
        response.status(status).json({
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
  const origin = request.get("origin");
  const fetchSite = request.get("sec-fetch-site");
  const sameOriginGet =
    request.method === "GET" &&
    origin === undefined &&
    fetchSite === "same-origin";
  if (
    !sameOriginGet &&
    (origin !== desktopOrigin ||
    !["same-origin", "none", undefined].includes(
      fetchSite,
    ))
  ) {
    throw new AppError(
      "ORIGIN_FORBIDDEN",
      "窗口实例只能由可信桌面页面创建",
      403,
    );
  }
}

function presentResourceSession(
  session: PublicResourceSession,
  instanceToken: string,
  desktopOrigin: string,
) {
  return {
    ...session,
    content: {
      url: `${desktopOrigin}/api/v1/resource-content`,
      sessionHeader: "Biunivers-Resource-Session",
      authorization: "Biunivers-Instance",
      instanceToken,
    },
  };
}

function resourceUnsupported(): AppError {
  return new AppError(
    "HOST_API_UNSUPPORTED",
    "当前宿主尚未启用资源会话能力",
    503,
  );
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

function requireFileHost(
  request: express.Request,
  config: ServerConfig,
  fileHost: FileHostService | undefined,
): { service: FileHostService; instanceToken: string } {
  requireDesktopOrigin(request, config.desktopOrigin);
  if (!fileHost) {
    throw new AppError(
      "HOST_API_UNSUPPORTED",
      "当前宿主尚未启用文件能力",
      503,
    );
  }
  return {
    service: fileHost,
    instanceToken: readInstanceToken(request),
  };
}

function requireInternalFileManager(
  request: express.Request,
  config: ServerConfig,
  service: InternalFileManagerExecutor | undefined,
): { service: InternalFileManagerExecutor; instanceToken: string } {
  requireDesktopOrigin(request, config.desktopOrigin);
  if (!service) {
    throw new AppError(
      "HOST_API_UNSUPPORTED",
      "当前宿主尚未启用文件管理能力",
      503,
    );
  }
  return { service, instanceToken: readInstanceToken(request) };
}

function requireInternalZipExporter(
  request: express.Request,
  config: ServerConfig,
  service: InternalZipExporter | undefined,
): { service: InternalZipExporter; instanceToken: string } {
  requireDesktopOrigin(request, config.desktopOrigin);
  if (!service) {
    throw new AppError(
      "HOST_API_UNSUPPORTED",
      "当前宿主尚未启用目录导出能力",
      503,
    );
  }
  return { service, instanceToken: readInstanceToken(request) };
}

function requireWormholeControl(
  request: express.Request,
  config: ServerConfig,
  service: WormholeControlExecutor | undefined,
): { service: WormholeControlExecutor; instanceToken: string } {
  requireDesktopOrigin(request, config.desktopOrigin);
  if (!service) {
    throw new AppError(
      "WORMHOLE_UNSUPPORTED",
      "当前宿主尚未启用 Wormhole",
      503,
    );
  }
  return { service, instanceToken: readInstanceToken(request) };
}

function contentDisposition(fileName: string): string {
  const encoded = encodeURIComponent(fileName).replace(
    /[!'()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="biunivers-download.zip"; filename*=UTF-8''${encoded}`;
}

function waitForDrain(response: express.Response): Promise<void> {
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
      reject(new Error("ZIP export response closed."));
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

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
