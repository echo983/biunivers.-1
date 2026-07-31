import { createHash } from "node:crypto";

const INSTANCE_ID_PATTERN = /^[0-9a-f]{32}$/;

export function bwaOriginLabel(instanceIdHex: string): string {
  validateInstanceId(instanceIdHex);
  const digest = createHash("sha256")
    .update(`bwa:${instanceIdHex}`, "utf8")
    .digest("hex")
    .slice(0, 40);
  return `bwa-${digest}`;
}

export function bwaInstanceOrigin(baseOrigin: string, instanceIdHex: string): string {
  const url = new URL(baseOrigin);
  url.hostname = `${bwaOriginLabel(instanceIdHex)}.${url.hostname}`;
  return url.origin;
}

export function requestHostMatchesBwaInstance(
  requestHost: string | undefined,
  baseOrigin: string,
  instanceIdHex: string,
): boolean {
  if (!requestHost) return false;
  return requestHost.toLowerCase() ===
    new URL(bwaInstanceOrigin(baseOrigin, instanceIdHex)).host.toLowerCase();
}

function validateInstanceId(value: string): void {
  if (!INSTANCE_ID_PATTERN.test(value) || value === "0".repeat(32)) {
    throw new Error("BWA Instance ID is invalid for browser origin routing.");
  }
}
