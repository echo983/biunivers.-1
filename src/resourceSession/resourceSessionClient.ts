export class ResourceSessionClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly terminal = false,
  ) {
    super(message);
  }
}

export function claimResourceSessionLaunch(
  instanceToken: string,
  launchId: string,
): Promise<{
  action: "open" | "edit";
  resource: ResourceSessionCapability;
}> {
  return request(
    "/api/v1/host/resource-sessions/launches/claim",
    instanceToken,
    { launchId },
  );
}

export interface ResourceSessionCapability {
  sessionId: string;
  access: "read" | "edit";
  expiresAt: string;
  metadata: {
    name: string;
    size: number;
    mtimeMs: number;
    mediaType: string;
    contentVersion: string;
  };
  content: {
    url: string;
    sessionHeader: "Biunivers-Resource-Session";
    authorization: "Biunivers-Instance";
    instanceToken: string;
  };
}

export function openResourceSession(
  instanceToken: string,
  entryId: string,
  access: "read" | "edit",
): Promise<ResourceSessionCapability> {
  return request("/api/v1/host/resource-sessions", instanceToken, {
    entryId,
    access,
  });
}

export function createResourceSaveTarget(
  instanceToken: string,
  parentEntryId: string,
  name: string,
): Promise<ResourceSessionCapability> {
  return request(
    "/api/v1/host/resource-sessions/save-targets",
    instanceToken,
    { parentEntryId, name },
  );
}

export function getResourceSessionMetadata(
  instanceToken: string,
  sessionId: string,
): Promise<ResourceSessionCapability> {
  return request(
    "/api/v1/host/resource-sessions/metadata",
    instanceToken,
    { sessionId },
  );
}

export function renewResourceSessions(
  instanceToken: string,
  sessionIds: string[],
): Promise<{
  renewed: Array<{ sessionId: string; expiresAt: string }>;
  rejected: Array<{ sessionId: string; code: string }>;
}> {
  return request("/api/v1/host/resource-sessions/renew", instanceToken, {
    sessionIds,
  });
}

export async function releaseResourceSessions(
  instanceToken: string,
  sessionIds: string[],
): Promise<{ released: true }> {
  await request(
    "/api/v1/host/resource-sessions/release",
    instanceToken,
    { sessionIds },
    true,
  );
  return { released: true };
}

async function request<T>(
  url: string,
  instanceToken: string,
  body: object,
  allowEmpty = false,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Biunivers-Instance ${instanceToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ResourceSessionClientError(
      "NETWORK_ERROR",
      "无法连接资源会话服务",
    );
  }
  if (allowEmpty && response.ok && response.status === 204) {
    return undefined as T;
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ResourceSessionClientError(
      "INVALID_RESPONSE",
      "资源会话服务返回了无效响应",
    );
  }
  if (!response.ok) {
    const error = isRecord(value) && isRecord(value.error) ? value.error : {};
    throw new ResourceSessionClientError(
      typeof error.code === "string"
        ? error.code
        : "RESOURCE_SESSION_FAILED",
      typeof error.message === "string"
        ? error.message
        : `资源会话请求失败：HTTP ${response.status}`,
      response.status < 500,
    );
  }
  return value as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
