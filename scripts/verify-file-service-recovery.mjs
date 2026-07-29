import { loadServerConfig } from "/app/dist/server/config.js";
import { loadCurrentEntryIndex } from "/app/dist/server/files/entryIndex.js";
import { FileContentStore } from "/app/dist/server/files/fileContentStore.js";
import { startFileService } from "/app/dist/server/files/fileServiceRuntime.js";

const config = loadServerConfig();
const runtime = await startFileService(config.fileService);

try {
  if (runtime.status.mode !== "ready") {
    throw new Error(`File Service is not ready: ${JSON.stringify(runtime.status)}`);
  }

  const index = await loadCurrentEntryIndex(
    runtime.repository,
    runtime.refStore,
  );
  const contentStore = new FileContentStore(runtime.repository);
  const pendingDirectories = [index.rootEntryIdHex];
  const files = [];

  while (pendingDirectories.length > 0) {
    const directoryId = pendingDirectories.pop();
    for (const entry of index.listChildren(directoryId)) {
      if (entry.kind === "directory") {
        pendingDirectories.push(entry.entryIdHex);
        continue;
      }

      let bytesRead = 0;
      let chunksRead = 0;
      for await (const chunk of contentStore.readChunks(entry.content)) {
        bytesRead += chunk.byteLength;
        chunksRead += 1;
      }
      files.push({
        name: entry.name,
        kind: entry.content.kind,
        bytesRead,
        chunksRead,
        verified: bytesRead === entry.content.size,
      });
    }
  }

  const result = {
    revision: index.revision,
    rootEntryIdHex: index.rootEntryIdHex,
    files,
    allVerified: files.every((file) => file.verified),
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.allVerified) {
    process.exitCode = 1;
  }
} finally {
  runtime.close();
}
