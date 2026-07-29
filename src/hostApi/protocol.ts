export const HOST_API_PROTOCOL = "biunivers.host-api/1";
export const HOST_API_MAX_MESSAGE_BYTES = 64 * 1024;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const METHODS = new Set([
  "file.open",
  "file.saveAs",
  "file.readTransfer",
  "file.writeTransfer",
  "file.getMetadata",
  "file.release",
]);

export interface HostRequest {
  protocol: typeof HOST_API_PROTOCOL;
  requestId: string;
  method: string;
  params: unknown;
}

export interface HostResponse {
  protocol: typeof HOST_API_PROTOCOL;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export function isTrustedHostMessage(
  event: Pick<MessageEvent<unknown>, "origin" | "source">,
  expectedOrigin: string,
  iframeWindow: Window | null,
): boolean {
  return (
    iframeWindow !== null &&
    event.origin === expectedOrigin &&
    event.source === iframeWindow
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseHostRequest(value: unknown): HostRequest | null {
  if (!isRecord(value)) {
    return null;
  }

  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return null;
  }

  if (
    new TextEncoder().encode(encoded).byteLength >
      HOST_API_MAX_MESSAGE_BYTES ||
    value.protocol !== HOST_API_PROTOCOL ||
    typeof value.requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(value.requestId) ||
    typeof value.method !== "string" ||
    !METHODS.has(value.method) ||
    !Object.hasOwn(value, "params")
  ) {
    return null;
  }

  return value as unknown as HostRequest;
}

export function unsupportedResponse(request: HostRequest): HostResponse {
  return {
    protocol: HOST_API_PROTOCOL,
    requestId: request.requestId,
    ok: false,
    error: {
      code: "HOST_API_UNSUPPORTED",
      message: "当前宿主尚未启用文件能力",
    },
  };
}
