import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { BwaLifecycleService } from "../dist/server/bwa/bwaLifecycleService.js";
import { BwaRegistryService } from "../dist/server/bwa/bwaRegistryService.js";
import { BwaSecretStore } from "../dist/server/bwa/bwaSecretStore.js";
import { ComputeRuntimeImageClient } from "../dist/server/bwa/computeRuntimeImageClient.js";
import { ComputeRuntimeLifecycleClient } from "../dist/server/bwa/computeRuntimeLifecycleClient.js";
import { loadServerConfig } from "../dist/server/config.js";
import { startFileService } from "../dist/server/files/fileServiceRuntime.js";

const execFileAsync = promisify(execFile);
const [socketPath, tokenHex, fixturePath, secretPath, runRoot] = process.argv.slice(2);
if (!socketPath || !tokenHex || !fixturePath || !secretPath || !runRoot) {
  throw new Error(
    "usage: verify-bwa-lifecycle.mjs <socket> <token> <fixture> <secret-path> <run-root>",
  );
}

const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const config = loadServerConfig();
if (!config.fileService) throw new Error("File Service is disabled.");
config.fileService.initialize = false;
const fileRuntime = await startFileService(config.fileService);
if (fileRuntime.status.mode !== "ready" || !fileRuntime.refStore) {
  throw new Error(`File Service is not ready: ${JSON.stringify(fileRuntime.status)}`);
}

try {
  const secrets = new BwaSecretStore(secretPath);
  await secrets.initialize();
  const imageClient = new ComputeRuntimeImageClient({
    socketPath,
    authenticationTokenHex: tokenHex,
  });
  const registry = new BwaRegistryService({
    refStore: fileRuntime.refStore,
    secrets,
    images: imageClient,
  });
  const lifecycle = new BwaLifecycleService({
    refStore: fileRuntime.refStore,
    environment: registry,
    runtime: new ComputeRuntimeLifecycleClient({
      socketPath,
      authenticationTokenHex: tokenHex,
    }),
  });

  const first = await lifecycle.start(fixture.instanceIdHex);
  await assertManifestHasNoSecret(runRoot, first.runIdHex);
  const incremented = await containerFetch(first.runIdHex, "/api/increment", "POST");
  if (incremented.count !== 1) throw new Error("Diagnostic BWA did not write count=1.");
  const firstCommitted = await lifecycle.stop(fixture.instanceIdHex);
  if (firstCommitted.state !== "COMMITTED") throw new Error("First BWA Run was not committed.");

  const second = await lifecycle.start(fixture.instanceIdHex);
  if (second.runIdHex === first.runIdHex) throw new Error("BWA Run ID was reused.");
  const restored = await containerFetch(second.runIdHex, "/api/state", "GET");
  if (restored.count !== 1) throw new Error("Committed BWA state was not restored.");
  const secondCommitted = await lifecycle.stop(fixture.instanceIdHex);
  if (secondCommitted.state !== "COMMITTED") throw new Error("Second BWA Run was not committed.");

  const third = await lifecycle.start(fixture.instanceIdHex);
  const incrementedAgain = await containerFetch(third.runIdHex, "/api/increment", "POST");
  if (incrementedAgain.count !== 2) throw new Error("Diagnostic BWA did not write count=2.");
  await execFileAsync("docker", ["kill", `biunivers-run-${third.runIdHex}`]);
  const failed = await lifecycle.finalizeExited(fixture.instanceIdHex);
  if (failed.state !== "FAILED") throw new Error("Abnormal BWA exit was not preserved.");
  const beforeRecovery = fileRuntime.refStore.getRef(fixture.workspaceRefId);
  if (beforeRecovery.revision !== 1) throw new Error("Abnormal exit advanced the Workspace Ref.");
  const recovered = await lifecycle.publishFailedUpper(fixture.instanceIdHex, third.runIdHex);
  if (recovered.state !== "COMMITTED") throw new Error("Failed BWA Upper was not committed.");

  const fourth = await lifecycle.start(fixture.instanceIdHex);
  const restoredAfterFailure = await containerFetch(fourth.runIdHex, "/api/state", "GET");
  if (restoredAfterFailure.count !== 2) {
    throw new Error("Explicitly committed failed Upper was not restored.");
  }
  const fourthCommitted = await lifecycle.stop(fixture.instanceIdHex);
  if (fourthCommitted.state !== "COMMITTED") throw new Error("Fourth BWA Run was not committed.");

  console.log(
    JSON.stringify({
      instanceIdHex: fixture.instanceIdHex,
      firstRunIdHex: first.runIdHex,
      secondRunIdHex: second.runIdHex,
      restoredCount: restored.count,
      restoredAfterFailureCount: restoredAfterFailure.count,
      firstState: firstCommitted.state,
      secondState: secondCommitted.state,
      thirdState: recovered.state,
      fourthState: fourthCommitted.state,
    }),
  );
} finally {
  fileRuntime.close();
}

async function containerFetch(runIdHex, path, method) {
  const name = `biunivers-run-${runIdHex}`;
  const script = `fetch("http://127.0.0.1:8080${path}",{method:"${method}"}).then(async r=>{if(!r.ok)process.exit(2);console.log(await r.text())}).catch(()=>process.exit(3))`;
  const deadline = Date.now() + 15_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await execFileAsync("docker", ["exec", name, "node", "-e", script], {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 64 * 1024,
      });
      return JSON.parse(result.stdout);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Diagnostic BWA HTTP service did not become ready.", { cause: lastError });
}

async function assertManifestHasNoSecret(root, runIdHex) {
  const manifest = await readFile(join(root, runIdHex, "runtime.json"), "utf8");
  if (manifest.includes("bwa-runtime-secret-probe")) {
    throw new Error("Runtime manifest contains a sensitive environment value.");
  }
}
