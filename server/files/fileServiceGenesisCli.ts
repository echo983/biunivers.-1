import { loadServerConfig } from "../config.js";
import { startFileService } from "./fileServiceRuntime.js";

const config = loadServerConfig({
  ...process.env,
  BIUNIVERS_FILE_ENABLED: "true",
  BIUNIVERS_FILE_INITIALIZE: "true",
  BIUNIVERS_BWA_ENABLED: "false",
});

const runtime = await startFileService(config.fileService);
try {
  if (runtime.status.mode !== "ready") {
    throw new Error(
      `File Service genesis failed: ${
        runtime.status.mode === "offline"
          ? `${runtime.status.code}: ${runtime.status.message}`
          : "File Service is disabled"
      }`,
    );
  }
  console.log(
    `Biunivers File Service initialized at revision ${runtime.status.revision}.`,
  );
} finally {
  runtime.close();
}
