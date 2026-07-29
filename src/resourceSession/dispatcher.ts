import {
  createResourceSaveTarget,
  claimResourceSessionLaunch,
  getResourceSessionMetadata,
  openResourceSession,
  releaseResourceSessions,
  renewResourceSessions,
  ResourceSessionClientError,
} from "./resourceSessionClient";
import {
  failureResourceSessionResponse,
  RESOURCE_SESSION_PROTOCOL,
  type ResourceSessionRequest,
  type ResourceSessionResponse,
} from "./protocol";

interface DispatcherDependencies {
  selectFile: (writable: boolean) => Promise<string | null>;
  selectSaveTarget: (
    suggestedName: string,
  ) => Promise<{ parentEntryId: string; name: string } | null>;
  open?: typeof openResourceSession;
  createSaveTarget?: typeof createResourceSaveTarget;
  metadata?: typeof getResourceSessionMetadata;
  renew?: typeof renewResourceSessions;
  release?: typeof releaseResourceSessions;
  claimLaunch?: (
    instanceToken: string,
  ) => ReturnType<typeof claimResourceSessionLaunch>;
}

export async function dispatchResourceSessionRequest(
  request: ResourceSessionRequest,
  instanceToken: string,
  dependencies: DispatcherDependencies,
): Promise<ResourceSessionResponse> {
  try {
    const params = requireRecord(request.params);
    let result: unknown;
    switch (request.method) {
      case "resource.getCapabilities":
        requireNoParams(params);
        result = {
          protocol: RESOURCE_SESSION_PROTOCOL,
          renewAfterSeconds: 60,
          expiresAfterSeconds: 300,
          fullRead: true,
          singleRangeRead: true,
          fullWrite: true,
        };
        break;
      case "resource.claimLaunch":
        requireNoParams(params);
        if (!dependencies.claimLaunch) {
          return failureResourceSessionResponse(
            request,
            "NO_LAUNCH_CONTEXT",
            "当前窗口没有待领取的资源",
          );
        }
        result = await dependencies.claimLaunch(instanceToken);
        break;
      case "resource.open": {
        const access =
          params.access === undefined
            ? "read"
            : requireAccess(params.access);
        const entryId = await dependencies.selectFile(access === "edit");
        if (!entryId) return cancelled(request, "文件选择");
        result = await (dependencies.open ?? openResourceSession)(
          instanceToken,
          entryId,
          access,
        );
        break;
      }
      case "resource.saveAs": {
        const suggestedName =
          params.suggestedName === undefined
            ? "未命名.txt"
            : requireString(params.suggestedName, "suggestedName");
        const target =
          await dependencies.selectSaveTarget(suggestedName);
        if (!target) return cancelled(request, "保存");
        result = await (
          dependencies.createSaveTarget ?? createResourceSaveTarget
        )(instanceToken, target.parentEntryId, target.name);
        break;
      }
      case "resource.getMetadata":
        result = await (
          dependencies.metadata ?? getResourceSessionMetadata
        )(
          instanceToken,
          requireSessionId(params.sessionId),
        );
        break;
      case "resource.renew":
        result = await (dependencies.renew ?? renewResourceSessions)(
          instanceToken,
          requireSessionIds(params.sessionIds),
        );
        break;
      case "resource.release":
        result = await (dependencies.release ?? releaseResourceSessions)(
          instanceToken,
          requireSessionIds(params.sessionIds),
        );
        break;
      default:
        return failureResourceSessionResponse(
          request,
          "REQUEST_INVALID",
          "资源会话方法无效",
        );
    }
    return {
      protocol: RESOURCE_SESSION_PROTOCOL,
      requestId: request.requestId,
      ok: true,
      result,
    };
  } catch (error) {
    return failureResourceSessionResponse(
      request,
      error instanceof ResourceSessionClientError
        ? error.code
        : "REQUEST_INVALID",
      error instanceof Error ? error.message : "资源会话请求无效",
    );
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("params 必须是对象");
  }
  return value as Record<string, unknown>;
}

function requireNoParams(value: Record<string, unknown>): void {
  if (Object.keys(value).length !== 0) {
    throw new Error("params 必须为空对象");
  }
}

function requireAccess(value: unknown): "read" | "edit" {
  if (value !== "read" && value !== "edit") {
    throw new Error("access 必须是 read 或 edit");
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error(`${label} 必须是非空字符串`);
  }
  return value;
}

function requireSessionId(value: unknown): string {
  const result = requireString(value, "sessionId");
  if (!/^[A-Za-z0-9_-]{43}$/.test(result)) {
    throw new Error("sessionId 格式无效");
  }
  return result;
}

function requireSessionIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 4096) {
    throw new Error("sessionIds 必须是字符串数组");
  }
  return value.map(requireSessionId);
}

function cancelled(
  request: ResourceSessionRequest,
  operation: string,
): ResourceSessionResponse {
  return failureResourceSessionResponse(
    request,
    "USER_CANCELLED",
    `用户取消了${operation}`,
  );
}
