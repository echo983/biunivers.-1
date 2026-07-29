import { fileURLToPath } from "node:url";
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
  const source = new GitHubSource({
    token: config.githubToken,
    maxArchiveBytes: config.maxAppBytes,
    maxAppBytes: config.maxAppBytes,
    maxAppFiles: config.maxAppFiles,
  });
  const inspections = new InspectionService({
    source,
    validator,
    appStore,
    dataDir: config.dataDir,
    maxAppBytes: config.maxAppBytes,
    maxAppFiles: config.maxAppFiles,
    reservedAppIds: new Set(["system.settings", "system.about"]),
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
    fileCapabilities,
    fileTransfers,
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
