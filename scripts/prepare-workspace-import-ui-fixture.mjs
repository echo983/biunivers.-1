import { loadServerConfig } from "./dist/server/config.js";
import { FileContentStore } from "./dist/server/files/fileContentStore.js";
import { loadCurrentEntryIndex } from "./dist/server/files/entryIndex.js";
import { FileSystemTransactions } from "./dist/server/files/fileSystemTransactions.js";
import { startFileService } from "./dist/server/files/fileServiceRuntime.js";

const config = loadServerConfig();
if (!config.fileService) throw new Error("File Service is disabled.");
config.fileService.initialize = false;
const runtime = await startFileService(config.fileService);
if (
  runtime.status.mode !== "ready" ||
  !runtime.refStore ||
  !runtime.repository
) {
  const status = JSON.stringify(runtime.status);
  runtime.close();
  throw new Error(`File Service is not ready: ${status}`);
}

try {
  const workspace = runtime.refStore.listWorkspaces().at(-1);
  if (!workspace) throw new Error("No Workspace exists.");
  if (workspace.activeWriteRunIdHex !== null) {
    throw new Error("The latest Workspace has an active write Run.");
  }
  const shortId = workspace.workspaceIdHex.slice(0, 8);
  const fixtureDirectoryName = `Import Fixture ${shortId}`;
  const targetDirectoryName = `Workspace Import Target ${shortId}`;
  const collisionName = `collision-${shortId}.txt`;
  const writerId = `${config.fileService.writerId}-ui-fixture`;
  const contentStore = new FileContentStore(runtime.repository);

  const mainTransactions = new FileSystemTransactions({
    repository: runtime.repository,
    refStore: runtime.refStore,
    refId: "main",
    writerId,
  });
  let main = await loadCurrentEntryIndex(
    runtime.repository,
    runtime.refStore,
    "main",
  );
  let target = main
    .listChildren(main.rootEntryIdHex)
    .find(
      (entry) =>
        entry.kind === "directory" && entry.name === targetDirectoryName,
    );
  if (!target) {
    const created = await mainTransactions.createDirectory({
      parentEntryIdHex: main.rootEntryIdHex,
      name: targetDirectoryName,
      expectedRevision: main.revision,
    });
    main = await loadCurrentEntryIndex(
      runtime.repository,
      runtime.refStore,
      "main",
    );
    target = main.get(created.entryIdHex);
  }
  if (!target || target.kind !== "directory") {
    throw new Error("Could not prepare the main import target.");
  }
  if (
    !main
      .listChildren(target.entryIdHex)
      .some((entry) => entry.name === collisionName)
  ) {
    const content = await contentStore.putBytes(
      Buffer.from("existing main collision fixture\n"),
    );
    await mainTransactions.createFile({
      parentEntryIdHex: target.entryIdHex,
      name: collisionName,
      content,
      expectedRevision: main.revision,
    });
  }

  const workspaceTransactions = new FileSystemTransactions({
    repository: runtime.repository,
    refStore: runtime.refStore,
    refId: workspace.refId,
    writerId,
  });
  let workspaceIndex = await loadCurrentEntryIndex(
    runtime.repository,
    runtime.refStore,
    workspace.refId,
  );
  let fixtureDirectory = workspaceIndex
    .listChildren(workspaceIndex.rootEntryIdHex)
    .find(
      (entry) =>
        entry.kind === "directory" && entry.name === fixtureDirectoryName,
    );
  if (!fixtureDirectory) {
    const created = await workspaceTransactions.createDirectory({
      parentEntryIdHex: workspaceIndex.rootEntryIdHex,
      name: fixtureDirectoryName,
      expectedRevision: workspaceIndex.revision,
    });
    workspaceIndex = await loadCurrentEntryIndex(
      runtime.repository,
      runtime.refStore,
      workspace.refId,
    );
    fixtureDirectory = workspaceIndex.get(created.entryIdHex);
  }
  if (!fixtureDirectory || fixtureDirectory.kind !== "directory") {
    throw new Error("Could not prepare the Workspace fixture directory.");
  }

  const fixtureEntries = workspaceIndex.listChildren(
    fixtureDirectory.entryIdHex,
  );
  if (!fixtureEntries.some((entry) => entry.name === "result.txt")) {
    const content = await contentStore.putBytes(
      Buffer.from("Workspace import UI fixture result\n"),
    );
    await workspaceTransactions.createFile({
      parentEntryIdHex: fixtureDirectory.entryIdHex,
      name: "result.txt",
      content,
      expectedRevision: workspaceIndex.revision,
    });
    workspaceIndex = await loadCurrentEntryIndex(
      runtime.repository,
      runtime.refStore,
      workspace.refId,
    );
  }
  if (
    !workspaceIndex
      .listChildren(workspaceIndex.rootEntryIdHex)
      .some((entry) => entry.name === collisionName)
  ) {
    const content = await contentStore.putBytes(
      Buffer.from("Workspace collision fixture result\n"),
    );
    await workspaceTransactions.createFile({
      parentEntryIdHex: workspaceIndex.rootEntryIdHex,
      name: collisionName,
      content,
      expectedRevision: workspaceIndex.revision,
    });
  }

  const finalWorkspaceRef = runtime.refStore.getRef(workspace.refId);
  const finalMainRef = runtime.refStore.getRef("main");
  console.log(
    JSON.stringify(
      {
        workspace: {
          id: workspace.workspaceIdHex,
          name: workspace.name,
          revision: finalWorkspaceRef.revision,
        },
        changes: [fixtureDirectoryName, collisionName],
        mainTarget: {
          name: targetDirectoryName,
          entryIdHex: target.entryIdHex,
          revision: finalMainRef.revision,
        },
        expectedImportedNames: [
          fixtureDirectoryName,
          `collision-${shortId} (Workspace).txt`,
        ],
      },
      null,
      2,
    ),
  );
} finally {
  runtime.close();
}
