import type { OpenResourceResponse } from "./protocol";
import { OPEN_RESOURCE_PROTOCOL } from "./protocol";

export class OpenResourceClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly terminal: boolean,
  ) {
    super(message);
  }
}

export interface OpenResourceLaunchContext {
  action: "open" | "edit";
  resource: {
    handleId: string;
    name: string;
    mediaType?: string;
    permissions: ["read"] | ["read", "write"];
  };
}

export async function claimResourceLaunch(
  instanceToken: string,
  launchId: string,
): Promise<OpenResourceLaunchContext> {
  let response: Response;
  try {
    response = await fetch("/api/v1/host/open-resources/claim", {
      method: "POST",
      headers: {
        Authorization: `Biunivers-Instance ${instanceToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ launchId }),
    });
  } catch {
    throw new OpenResourceClientError(
      "NETWORK_ERROR",
      "无法连接资源打开服务",
      false,
    );
  }
  const value = (await response.json()) as {
    action?: unknown;
    resource?: unknown;
    error?: { code?: unknown; message?: unknown };
  };
  if (!response.ok) {
    const code =
      typeof value.error?.code === "string"
        ? value.error.code
        : "OPEN_RESOURCE_FAILED";
    throw new OpenResourceClientError(
      code,
      typeof value.error?.message === "string"
        ? value.error.message
        : `资源领取失败：HTTP ${response.status}`,
      response.status < 500,
    );
  }
  if (
    (value.action !== "open" && value.action !== "edit") ||
    typeof value.resource !== "object" ||
    value.resource === null ||
    Array.isArray(value.resource)
  ) {
    throw new OpenResourceClientError(
      "INVALID_RESPONSE",
      "资源打开服务返回了无效上下文",
      false,
    );
  }
  const resource = value.resource as Record<string, unknown>;
  const permissions = resource.permissions;
  if (
    typeof resource.handleId !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(resource.handleId) ||
    typeof resource.name !== "string" ||
    (resource.mediaType !== undefined &&
      typeof resource.mediaType !== "string") ||
    !Array.isArray(permissions) ||
    !(
      (permissions.length === 1 && permissions[0] === "read") ||
      (permissions.length === 2 &&
        permissions[0] === "read" &&
        permissions[1] === "write")
    )
  ) {
    throw new OpenResourceClientError(
      "INVALID_RESPONSE",
      "资源打开服务返回了无效文件能力",
      false,
    );
  }
  return value as OpenResourceLaunchContext;
}

export function successResponse(
  requestId: string,
  result: unknown,
): OpenResourceResponse {
  return {
    protocol: OPEN_RESOURCE_PROTOCOL,
    requestId,
    ok: true,
    result,
  };
}

export function errorResponse(
  requestId: string,
  error: unknown,
): OpenResourceResponse {
  return {
    protocol: OPEN_RESOURCE_PROTOCOL,
    requestId,
    ok: false,
    error: {
      code:
        error instanceof OpenResourceClientError
          ? error.code
          : "OPEN_RESOURCE_FAILED",
      message:
        error instanceof Error ? error.message : "无法领取启动资源",
    },
  };
}
