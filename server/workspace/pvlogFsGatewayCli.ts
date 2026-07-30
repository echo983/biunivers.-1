import { writeFile } from "node:fs/promises";
import { loadServerConfig } from "../config.js";
import { startFileService } from "../files/fileServiceRuntime.js";
import { PvlogFsGateway } from "./pvlogFsGateway.js";
import { VerifiedChunkCache } from "./verifiedChunkCache.js";
import { WorkspaceContentReader } from "./workspaceContentReader.js";
import { WorkspaceSnapshotProvider } from "./workspaceSnapshotProvider.js";

const [workspaceSelector, socketPath, snapshotPath, sessionPath, cachePath] =
  process.argv.slice(2);
if (
  !workspaceSelector ||
  !socketPath ||
  !snapshotPath ||
  !sessionPath ||
  !cachePath
) {
  throw new Error(
    "usage: pvlogFsGatewayCli <workspace-id|latest> <socket> <snapshot> <session> <cache>",
  );
}

const config = loadServerConfig();
if (!config.fileService) throw new Error("File Service is disabled.");
config.fileService.initialize = false;
const runtime = await startFileService(config.fileService);
if (
  runtime.status.mode !== "ready" ||
  !runtime.repository ||
  !runtime.refStore
) {
  runtime.close();
  throw new Error("File Service is not ready.");
}
const workspaceIdHex =
  workspaceSelector === "latest"
    ? runtime.refStore.listWorkspaces().at(-1)?.workspaceIdHex
    : workspaceSelector;
if (!workspaceIdHex) {
  runtime.close();
  throw new Error("No Workspace exists for the PVLogFS mount.");
}
const cache = new VerifiedChunkCache({
  directory: cachePath,
  repository: runtime.repository,
});
const gateway = await PvlogFsGateway.create({
  workspaceIdHex,
  socketPath,
  snapshotPath,
  snapshotProvider: new WorkspaceSnapshotProvider({
    repository: runtime.repository,
    refStore: runtime.refStore,
  }),
  contentReader: new WorkspaceContentReader({
    repository: runtime.repository,
    cache,
  }),
});
await gateway.listen();
await writeFile(
  sessionPath,
  `${JSON.stringify({
    workspaceIdHex,
    capabilityHex: gateway.capabilityHex,
  })}\n`,
  { encoding: "utf8", mode: 0o600, flag: "wx" },
);
console.log(
  `PVLogFS Gateway fixed Workspace ${workspaceIdHex} HEAD ${gateway.snapshot.headFidHex}`,
);

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  console.log(
    JSON.stringify({
      gateway: gateway.metrics(),
      cache: cache.metrics(),
    }),
  );
  await gateway.close();
  runtime.close();
};

process.once("SIGINT", () => void close().then(() => process.exit(0)));
process.once("SIGTERM", () => void close().then(() => process.exit(0)));
