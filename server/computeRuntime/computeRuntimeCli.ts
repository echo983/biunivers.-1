import { loadServerConfig } from "../config.js";
import { loadComputeRuntimeConfig } from "./computeRuntimeConfig.js";
import { startComputeRuntimeDaemon } from "./computeRuntimeDaemon.js";

const daemon = await startComputeRuntimeDaemon({
  serverConfig: loadServerConfig(),
  runtimeConfig: loadComputeRuntimeConfig(),
});

console.log(
  `Biunivers Compute Runtime listening on ${daemon.socketPath}` +
    (daemon.quarantinedPaths > 0
      ? `; quarantined ${daemon.quarantinedPaths} unknown path(s)`
      : ""),
);

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await daemon.close();
};

process.once("SIGINT", () =>
  void close().then(() => process.exit(0), reportFatal),
);
process.once("SIGTERM", () =>
  void close().then(() => process.exit(0), reportFatal),
);

function reportFatal(error: unknown): never {
  console.error(
    error instanceof Error ? error.message : "Compute Runtime shutdown failed.",
  );
  process.exit(1);
}
