export const OPEN_RESOURCE_PROTOCOL = "biunivers.open-resource/1";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface OpenResourceRequest {
  protocol: typeof OPEN_RESOURCE_PROTOCOL;
  requestId: string;
  method: "launch.getContext";
  params: Record<string, never>;
}

export interface OpenResourceResponse {
  protocol: typeof OPEN_RESOURCE_PROTOCOL;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseOpenResourceRequest(
  value: unknown,
): OpenResourceRequest | null {
  if (
    !isRecord(value) ||
    value.protocol !== OPEN_RESOURCE_PROTOCOL ||
    typeof value.requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(value.requestId) ||
    value.method !== "launch.getContext" ||
    !isRecord(value.params) ||
    Object.keys(value.params).length !== 0
  ) {
    return null;
  }
  return value as unknown as OpenResourceRequest;
}

export function noLaunchContextResponse(
  request: OpenResourceRequest,
): OpenResourceResponse {
  return {
    protocol: OPEN_RESOURCE_PROTOCOL,
    requestId: request.requestId,
    ok: false,
    error: {
      code: "NO_LAUNCH_CONTEXT",
      message: "当前窗口没有待领取的资源",
    },
  };
}
