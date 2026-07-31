import { readFile, writeFile } from "node:fs/promises";
import { loadServerConfig } from "../dist/server/config.js";
import { BlankBwaInstanceCreator } from "../dist/server/bwa/blankBwaInstanceCreator.js";
import { BwaSecretStore } from "../dist/server/bwa/bwaSecretStore.js";
import { startFileService } from "../dist/server/files/fileServiceRuntime.js";

const [operation, fixturePath, secretPath, imageReference] = process.argv.slice(2);
if (!fixturePath || !secretPath || !["prepare", "verify"].includes(operation)) {
  throw new Error(
    "usage: bwa-lifecycle-fixture.mjs <prepare|verify> <fixture> <secret-path> [image-reference]",
  );
}

const config = loadServerConfig();
if (!config.fileService) throw new Error("File Service is disabled.");
config.fileService.initialize = false;
const runtime = await startFileService(config.fileService);
if (runtime.status.mode !== "ready" || !runtime.refStore || !runtime.repository) {
  const status = JSON.stringify(runtime.status);
  runtime.close();
  throw new Error(`File Service is not ready: ${status}`);
}

try {
  if (operation === "prepare") {
    const parsed = parseImageReference(imageReference);
    const createdAtMs = Date.now();
    runtime.refStore.createBwaApplication({
      applicationId: parsed.repository,
      installedDigest: parsed.digest,
      previousDigest: null,
      protocolVersion: 1,
      title: "Biunivers BWA Diagnostic",
      description: "Lifecycle integration fixture",
      sourceUrl: "https://github.com/echo983/biunivers-bwa-diagnostic",
      imageVersion: "0.1.0",
      imageRevision: null,
      imageLicenses: "MIT",
      enabled: true,
      defaultInstanceIdHex: null,
      createdAtMs,
      updatedAtMs: createdAtMs,
    });
    const created = await new BlankBwaInstanceCreator({
      repository: runtime.repository,
      refStore: runtime.refStore,
      writerId: "bwa-lifecycle-test",
    }).create({
      applicationId: parsed.repository,
      workspaceName: "BWA lifecycle test",
      instanceName: "BWA lifecycle test",
    });
    const secrets = new BwaSecretStore(secretPath);
    await secrets.initialize();
    await secrets.replace(created.instance.instanceIdHex, {
      DIAGNOSTIC_SECRET: "bwa-runtime-secret-probe",
    });
    runtime.refStore.replaceBwaEnvironment(created.instance.instanceIdHex, [
      { name: "DIAGNOSTIC_MODE", value: "lifecycle-test", sensitive: false },
      { name: "DIAGNOSTIC_SECRET", value: null, sensitive: true },
    ]);
    const fixture = {
      applicationId: parsed.repository,
      imageReference,
      instanceIdHex: created.instance.instanceIdHex,
      workspaceIdHex: created.workspace.workspaceIdHex,
      workspaceRefId: created.workspace.refId,
      initialHeadFidHex: created.workspace.baselineHeadFidHex,
    };
    await writeFile(fixturePath, `${JSON.stringify(fixture)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    console.log(JSON.stringify(fixture));
  } else {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    const instance = runtime.refStore.getBwaInstance(fixture.instanceIdHex);
    const ref = runtime.refStore.getRef(fixture.workspaceRefId);
    const runs = runtime.refStore.listBwaRunBindings(fixture.instanceIdHex);
    if (
      instance.desiredState !== "STOPPED" ||
      ref.revision !== 2 ||
      runs.length !== 5 ||
      runs.filter(({ run }) => run.state === "COMMITTED").length !== 4 ||
      runs.filter(({ run }) => run.state === "FAILED").length !== 1
    ) {
      throw new Error("BWA lifecycle committed state is invalid.");
    }
    console.log(
      JSON.stringify({
        revision: ref.revision,
        headFidHex: ref.headFidHex,
        runIds: runs.map(({ run }) => run.runIdHex),
        states: runs.map(({ run }) => run.state),
        desiredState: instance.desiredState,
      }),
    );
  }
} finally {
  runtime.close();
}

function parseImageReference(value) {
  const match = /^(ghcr\.io\/[a-z0-9._/-]+)@(sha256:[0-9a-f]{64})$/.exec(value ?? "");
  if (!match) throw new Error("BWA fixture image must be digest-pinned.");
  return { repository: match[1], digest: match[2] };
}
