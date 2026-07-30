import { writeFile } from "node:fs/promises";

import { loadServerConfig } from "../config.js";
import { startFileService } from "../files/fileServiceRuntime.js";
import { PvlogMountBridge } from "./pvlogMountBridge.js";

const [socketPath, snapshotPath, metricsPath] = process.argv.slice(2);
if (!socketPath || !snapshotPath || !metricsPath) {
  throw new Error(
    "usage: pvlogMountProbeCli <socket-path> <snapshot-path> <metrics-path>",
  );
}

const config = loadServerConfig();
if (!config.fileService) throw new Error("File Service is disabled.");
config.fileService.initialize = false;
const runtime = await startFileService(config.fileService);
const bridge = await PvlogMountBridge.create({
  runtime,
  socketPath,
  snapshotPath,
});
await bridge.listen();
console.log(
  `PVLog mount bridge fixed main HEAD ${bridge.snapshot.headFidHex} at revision ${bridge.snapshot.revision}`,
);

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await writeFile(metricsPath, `${JSON.stringify(bridge.metrics(), null, 2)}\n`);
  await bridge.close();
  runtime.close();
};

process.once("SIGINT", () => void close().then(() => process.exit(0)));
process.once("SIGTERM", () => void close().then(() => process.exit(0)));
