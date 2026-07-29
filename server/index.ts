import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AppService } from "./apps/appService.js";
import { AppStore } from "./apps/appStore.js";
import { InspectionService } from "./apps/inspectionService.js";
import { OperationLock } from "./apps/operationLock.js";
import { loadServerConfig } from "./config.js";
import { GitHubSource } from "./github/githubSource.js";
import { createAppServer } from "./http/appServer.js";
import { createDesktopServer } from "./http/desktopServer.js";
import { ManifestValidator } from "./manifests/manifestValidator.js";
import { startFileService } from "./files/fileServiceRuntime.js";
import { FileCapabilityRegistry } from "./files/fileCapabilityRegistry.js";
import { FileTransferService } from "./files/fileTransferService.js";
import { FileHostService } from "./files/fileHostService.js";
import { FileServiceBackup } from "./files/fileServiceBackup.js";
import { FileServiceGcScanner } from "./files/fileServiceGcScanner.js";
import { InternalFileManagerService } from "./files/internalFileManagerService.js";
import { OpenResourceValidator } from "./openResource/openResourceValidator.js";
import { OpenResourceResolver } from "./openResource/openResourceResolver.js";
import { OpenResourceLaunchRegistry } from "./openResource/openResourceLaunchRegistry.js";
import { OpenResourceLaunchService } from "./openResource/openResourceLaunchService.js";
import { loadCurrentEntryIndex } from "./files/entryIndex.js";
import { DesktopSurfaceStore } from "./desktopSurface/desktopSurfaceStore.js";
import { DesktopSurfaceService } from "./desktopSurface/desktopSurfaceService.js";
import { ResourceSessionRegistry } from "./resources/resourceSessionRegistry.js";
import { ResourceContentService } from "./resources/resourceContentService.js";
import { ResourceSessionService } from "./resources/resourceSessionService.js";

async function main() {
  const config = loadServerConfig();
  const appStore = new AppStore(config.dataDir);
  await appStore.initialize();
  const validator = await ManifestValidator.create(
    resolve(
      "docs",
      "developer-kit",
      "v1",
      "biunivers.app.schema.json",
    ),
    resolve(
      "docs",
      "developer-kit",
      "v1",
      "BIUNIVERS_APP_PROTOCOL_V1.md",
    ),
  );
  const openResourceValidator = await OpenResourceValidator.create(
    resolve(
      "docs",
      "developer-kit",
      "v1",
      "biunivers.open-resource.schema.json",
    ),
    resolve(
      "docs",
      "developer-kit",
      "v1",
      "BIUNIVERS_OPEN_RESOURCE_PROTOCOL_V1.md",
    ),
  );
  const source = new GitHubSource({
    token: config.githubToken,
    maxArchiveBytes: config.maxAppBytes,
    maxAppBytes: config.maxAppBytes,
    maxAppFiles: config.maxAppFiles,
  });
  const inspections = new InspectionService({
    source,
    validator,
    openResourceValidator,
    resourceSessionProtocolBytes: await readFile(
      resolve(
        "docs",
        "developer-kit",
        "v1",
        "BIUNIVERS_RESOURCE_SESSION_PROTOCOL_V1.md",
      ),
    ),
    appStore,
    dataDir: config.dataDir,
    maxAppBytes: config.maxAppBytes,
    maxAppFiles: config.maxAppFiles,
    reservedAppIds: new Set([
      "system.settings",
      "system.about",
      "system.files",
    ]),
  });
  const appService = new AppService({
    appStore,
    inspections,
    validator,
    operationLock: new OperationLock(),
    dataDir: config.dataDir,
  });
  const fileService = await startFileService(config.fileService);
  const fileCapabilities =
    fileService.status.mode === "ready"
      ? new FileCapabilityRegistry()
      : undefined;
  const resourceSessions =
    fileService.status.mode === "ready"
      ? new ResourceSessionRegistry()
      : undefined;
  const fileTransfers =
    fileCapabilities &&
    fileService.repository &&
    fileService.refStore &&
    config.fileService
      ? new FileTransferService({
          repository: fileService.repository,
          refStore: fileService.refStore,
          writerId: config.fileService.writerId,
          capabilities: fileCapabilities,
        })
      : undefined;
  const fileHost =
    fileCapabilities && fileService.repository && fileService.refStore
      ? new FileHostService({
          repository: fileService.repository,
          refStore: fileService.refStore,
          capabilities: fileCapabilities,
        })
      : undefined;
  const resourceContent =
    resourceSessions &&
    fileService.repository &&
    fileService.refStore &&
    config.fileService
      ? new ResourceContentService({
          repository: fileService.repository,
          refStore: fileService.refStore,
          writerId: config.fileService.writerId,
          sessions: resourceSessions,
        })
      : undefined;
  const resourceSessionService =
    resourceSessions &&
    fileCapabilities &&
    fileService.repository &&
    fileService.refStore
      ? new ResourceSessionService({
          repository: fileService.repository,
          refStore: fileService.refStore,
          capabilities: fileCapabilities,
          sessions: resourceSessions,
          appStore,
        })
      : undefined;
  const fileServiceBackup =
    fileService.repository && fileService.refStore && config.fileService
      ? new FileServiceBackup({
          repository: fileService.repository,
          refStore: fileService.refStore,
          backupPath: resolve(
            config.dataDir,
            "file-service",
            "backups",
            "latest.sqlite",
          ),
        })
      : undefined;
  const fileServiceGcScanner =
    fileService.repository && fileService.refStore
      ? new FileServiceGcScanner({
          repository: fileService.repository,
          refStore: fileService.refStore,
        })
      : undefined;
  const internalFileManager =
    fileCapabilities &&
    fileService.repository &&
    fileService.refStore &&
    config.fileService
      ? new InternalFileManagerService({
          repository: fileService.repository,
          refStore: fileService.refStore,
          capabilities: fileCapabilities,
          writerId: config.fileService.writerId,
        })
      : undefined;
  const openResourceResolver =
    fileCapabilities && fileService.repository && fileService.refStore
      ? new OpenResourceResolver({
          capabilities: fileCapabilities,
          appStore,
          loadIndex: () =>
            loadCurrentEntryIndex(
              fileService.repository!,
              fileService.refStore!,
            ),
        })
      : undefined;
  const openResourceLaunchService =
    fileCapabilities && fileService.repository && fileService.refStore
      ? new OpenResourceLaunchService({
          capabilities: fileCapabilities,
          launches: new OpenResourceLaunchRegistry(),
          appStore,
          resourceSessionService,
          loadIndex: () =>
            loadCurrentEntryIndex(
              fileService.repository!,
              fileService.refStore!,
            ),
        })
      : undefined;
  const desktopSurfaceStore = await DesktopSurfaceStore.open(
    resolve(config.dataDir, "desktop-surface.sqlite"),
  );
  const desktopSurface = new DesktopSurfaceService({
    store: desktopSurfaceStore,
    appStore,
    appOrigin: config.appOrigin,
    internalApps: [
      {
        id: "system.files",
        name: "文件",
        icon: "/icons/files.svg",
        desktop: true,
      },
      {
        id: "system.settings",
        name: "设置",
        icon: "/icons/settings.svg",
        desktop: false,
      },
      {
        id: "system.about",
        name: "关于",
        icon: "/icons/about.svg",
        desktop: true,
      },
    ],
    ...(fileService.repository && fileService.refStore
      ? {
          loadEntryIndex: () =>
            loadCurrentEntryIndex(
              fileService.repository!,
              fileService.refStore!,
            ),
        }
      : {}),
  });
  await desktopSurface.initialize();
  if (fileService.status.mode === "ready") {
    console.log(
      `Biunivers File Service ready at revision ${fileService.status.revision}`,
    );
  } else if (fileService.status.mode === "offline") {
    console.warn(
      `Biunivers File Service offline (${fileService.status.code}): ${fileService.status.message}`,
    );
  }

  const clientDir = fileURLToPath(new URL("../client/", import.meta.url));
  const desktopServer = createDesktopServer({
    config,
    appStore,
    clientDir,
    inspections,
    appService,
    fileServiceStatus: fileService.status,
    getFileServiceStatus: () => fileService.currentStatus(),
    fileCapabilities,
    fileTransfers,
    resourceContent,
    resourceSessionService,
    resourceSessions,
    fileHost,
    fileServiceBackup,
    fileServiceGcScanner,
    internalFileAppIds: new Set(["system.files"]),
    internalFileManager,
    openResourceResolver,
    openResourceLaunchService,
    desktopSurface,
  }).listen(config.desktopPort, () => {
    console.log(
      `Biunivers desktop listening on ${config.desktopOrigin} (port ${config.desktopPort})`,
    );
  });

  const appServer = createAppServer({
    appStore,
    dataDir: config.dataDir,
    appOrigin: config.appOrigin,
  }).listen(config.appPort, () => {
    console.log(
      `Biunivers apps listening on ${config.appOrigin} (port ${config.appPort})`,
    );
  });

  const shutdown = () => {
    desktopSurfaceStore.close();
    fileService.close();
    desktopServer.close();
    appServer.close();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("Biunivers server failed to start", error);
  process.exitCode = 1;
});
