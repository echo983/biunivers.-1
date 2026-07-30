export const RESOURCE_SESSION_PROTOCOL = "biunivers.resource-session/1";
export const RESOURCE_SESSION_MAX_MESSAGE_BYTES = 64 * 1024;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const METHODS = new Set([
  "resource.getCapabilities",
  "resource.claimLaunch",
  "resource.open",
  "resource.openMany",
  "resource.saveAs",
  "resource.getMetadata",
  "resource.renew",
  "resource.release",
]);

export interface ResourceSessionRequest {
  protocol: typeof RESOURCE_SESSION_PROTOCOL;
  requestId: string;
  method: string;
  params: unknown;
}

export interface ResourceSessionResponse {
  protocol: typeof RESOURCE_SESSION_PROTOCOL;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export function parseResourceSessionRequest(
  value: unknown,
): ResourceSessionRequest | null {
  if (!isRecord(value)) return null;
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return null;
  }
  if (
    new TextEncoder().encode(encoded).byteLength >
      RESOURCE_SESSION_MAX_MESSAGE_BYTES ||
    value.protocol !== RESOURCE_SESSION_PROTOCOL ||
    typeof value.requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(value.requestId) ||
    typeof value.method !== "string" ||
    !METHODS.has(value.method) ||
    !Object.hasOwn(value, "params")
  ) {
    return null;
  }
  return value as unknown as ResourceSessionRequest;
}

export function unsupportedResourceSessionResponse(
  request: ResourceSessionRequest,
): ResourceSessionResponse {
  return failureResourceSessionResponse(
    request,
    "RESOURCE_SESSION_UNSUPPORTED",
    "当前宿主尚未启用资源会话能力",
  );
}

export function failureResourceSessionResponse(
  request: ResourceSessionRequest,
  code: string,
  message: string,
): ResourceSessionResponse {
  return {
    protocol: RESOURCE_SESSION_PROTOCOL,
    requestId: request.requestId,
    ok: false,
    error: { code, message },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
