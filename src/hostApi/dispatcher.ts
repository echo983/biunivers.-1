import {
  createFileTransfer,
  createSaveHandle,
  FileHostClientError,
  getFileMetadata,
  openFileHandle,
  releaseFileHandle,
} from "./fileHostClient";
import {
  HOST_API_PROTOCOL,
  type HostRequest,
  type HostResponse,
} from "./protocol";

interface DispatcherDependencies {
  selectFile: (writable: boolean) => Promise<string | null>;
  selectSaveTarget?: (
    suggestedName: string,
  ) => Promise<{ parentEntryId: string; name: string } | null>;
  openHandle?: typeof openFileHandle;
  createSaveHandle?: typeof createSaveHandle;
  createTransfer?: typeof createFileTransfer;
  getMetadata?: typeof getFileMetadata;
  releaseHandle?: typeof releaseFileHandle;
}

export async function dispatchHostRequest(
  request: HostRequest,
  instanceToken: string,
  dependencies: DispatcherDependencies,
): Promise<HostResponse> {
  try {
    let result: unknown;
    const params = requireRecord(request.params);
    switch (request.method) {
      case "file.open": {
        const writable =
          params.writable === undefined
            ? false
            : requireBoolean(params.writable, "writable");
        const entryId = await dependencies.selectFile(writable);
        if (!entryId) {
          return failure(request, "USER_CANCELLED", "用户取消了文件选择");
        }
        result = await (dependencies.openHandle ?? openFileHandle)(
          instanceToken,
          entryId,
          writable,
        );
        break;
      }
      case "file.readTransfer":
        result = await (
          dependencies.createTransfer ?? createFileTransfer
        )(
          instanceToken,
          requireString(params.handleId, "handleId"),
          "GET",
        );
        break;
      case "file.writeTransfer":
        result = await (
          dependencies.createTransfer ?? createFileTransfer
        )(
          instanceToken,
          requireString(params.handleId, "handleId"),
          "PUT",
        );
        break;
      case "file.getMetadata":
        result = await (dependencies.getMetadata ?? getFileMetadata)(
          instanceToken,
          requireString(params.handleId, "handleId"),
        );
        break;
      case "file.release":
        result = await (dependencies.releaseHandle ?? releaseFileHandle)(
          instanceToken,
          requireString(params.handleId, "handleId"),
        );
        break;
      case "file.saveAs":
        if (!dependencies.selectSaveTarget) {
          return failure(
            request,
            "HOST_API_UNSUPPORTED",
            "另存为尚未启用",
          );
        }
        {
          const suggestedName =
            params.suggestedName === undefined
              ? "未命名.txt"
              : requireString(params.suggestedName, "suggestedName");
          const target =
            await dependencies.selectSaveTarget(suggestedName);
          if (!target) {
            return failure(
              request,
              "USER_CANCELLED",
              "用户取消了保存",
            );
          }
          result = await (
            dependencies.createSaveHandle ?? createSaveHandle
          )(
            instanceToken,
            target.parentEntryId,
            target.name,
          );
        }
        break;
      default:
        return failure(request, "REQUEST_INVALID", "Host API 方法无效");
    }
    return {
      protocol: HOST_API_PROTOCOL,
      requestId: request.requestId,
      ok: true,
      result,
    };
  } catch (error) {
    if (error instanceof FileHostClientError) {
      return failure(request, error.code, error.message);
    }
    return failure(
      request,
      "REQUEST_INVALID",
      error instanceof Error ? error.message : "Host API 请求无效",
    );
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("params 必须是对象");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error(`${label} 必须是非空字符串`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} 必须是布尔值`);
  }
  return value;
}

function failure(
  request: HostRequest,
  code: string,
  message: string,
): HostResponse {
  return {
    protocol: HOST_API_PROTOCOL,
    requestId: request.requestId,
    ok: false,
    error: { code, message },
  };
}
