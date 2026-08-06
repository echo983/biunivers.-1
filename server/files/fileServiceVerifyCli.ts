import { loadServerConfig } from "../config.js";
import { startFileService } from "./fileServiceRuntime.js";

const config = loadServerConfig({
  ...process.env,
  BIUNIVERS_FILE_ENABLED: "true",
  BIUNIVERS_FILE_INITIALIZE: "false",
  BIUNIVERS_BWA_ENABLED: "false",
});

const runtime = await startFileService(config.fileService);
try {
  const status = await runtime.currentStatus();
  if (
    status.mode !== "ready" ||
    !status.writable ||
    !runtime.repository ||
    !runtime.refStore
  ) {
    throw new Error(
      `File Service verification failed: ${
        status.mode === "offline"
          ? `${status.code}: ${status.message}`
          : "File Service is disabled"
      }`,
    );
  }

  // Reasserting the current immutable HEAD with If-None-Match proves that the
  // configured credential can issue PutObject without creating probe garbage.
  const currentRef = runtime.refStore.getRef("main");
  const headBytes = await runtime.repository.get("heads", currentRef.headFidHex);
  const persisted = await runtime.repository.put("heads", headBytes);
  if (persisted.key.fidHex !== currentRef.headFidHex) {
    throw new Error("File Service verification returned an inconsistent HEAD.");
  }
  console.log(`Biunivers File Service verified at revision ${status.revision}.`);
} finally {
  runtime.close();
}
