import {
  createFileTransfer,
  createSaveHandle,
  openFileHandle,
  releaseFileHandle,
  FileHostClientError,
  type FileEntry,
} from "../hostApi/fileHostClient";

export interface FileTransferProgress {
  loaded: number;
  total: number;
}

export interface FileTransferOptions {
  signal?: AbortSignal;
  onProgress?: (progress: FileTransferProgress) => void;
}

export async function uploadLocalFile(
  instanceToken: string,
  parentEntryId: string,
  file: File,
  options: FileTransferOptions = {},
): Promise<void> {
  const handle = await createSaveHandle(
    instanceToken,
    parentEntryId,
    file.name,
  );
  try {
    const transfer = await createFileTransfer(
      instanceToken,
      handle.handleId,
      "PUT",
    );
    if (file.size > transfer.maxBytes) {
      throw new FileHostClientError(
        "TRANSFER_TOO_LARGE",
        `文件“${file.name}”超过上传大小限制`,
      );
    }
    await uploadFileWithProgress(
      transfer.url,
      transfer.instanceToken,
      file,
      options,
    );
  } finally {
    await releaseFileHandle(instanceToken, handle.handleId).catch(() => {});
  }
}

export async function downloadFile(
  instanceToken: string,
  entry: FileEntry,
  options: FileTransferOptions = {},
): Promise<void> {
  if (entry.kind !== "file") {
    throw new FileHostClientError(
      "REQUEST_INVALID",
      "只有文件可以下载",
    );
  }
  const handle = await openFileHandle(instanceToken, entry.entryId, false);
  try {
    const transfer = await createFileTransfer(
      instanceToken,
      handle.handleId,
      "GET",
    );
    const response = await fetch(transfer.url, {
      headers: {
        Authorization: `Biunivers-Instance ${transfer.instanceToken}`,
      },
      signal: options.signal,
    });
    if (!response.ok) {
      await requireTransferSuccess(response);
    }
    const blob = await readDownload(response, entry.size ?? 0, options);
    saveBlob(blob, entry.name);
  } finally {
    await releaseFileHandle(instanceToken, handle.handleId).catch(() => {});
  }
}

export async function downloadZip(
  instanceToken: string,
  entries: readonly FileEntry[],
  expectedRevision: number,
  options: FileTransferOptions = {},
): Promise<string> {
  if (entries.length === 0) {
    throw new FileHostClientError(
      "REQUEST_INVALID",
      "请先选择要下载的项目",
    );
  }
  const fileName =
    entries.length === 1 && entries[0].kind === "directory"
      ? `${entries[0].name}.zip`
      : "biunivers-download.zip";
  const response = await fetch("/api/v1/internal/files/exports/zip", {
    method: "POST",
    headers: {
      Authorization: `Biunivers-Instance ${instanceToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      entryIds: entries.map((entry) => entry.entryId),
      expectedRevision,
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    await requireTransferSuccess(response);
  }
  const blob = await readDownload(response, 0, options);
  saveBlob(blob, fileName);
  return fileName;
}

function uploadFileWithProgress(
  url: string,
  instanceToken: string,
  file: File,
  options: FileTransferOptions,
): Promise<void> {
  if (options.signal?.aborted) {
    return Promise.reject(new DOMException("文件上传已取消", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    const cleanup = () => options.signal?.removeEventListener("abort", abort);
    request.open("PUT", url);
    request.setRequestHeader(
      "Authorization",
      `Biunivers-Instance ${instanceToken}`,
    );
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.upload.addEventListener("progress", (event) => {
      options.onProgress?.({
        loaded: event.loaded,
        total: event.lengthComputable ? event.total : file.size,
      });
    });
    request.addEventListener("load", () => {
      cleanup();
      if (request.status >= 200 && request.status < 300) {
        options.onProgress?.({ loaded: file.size, total: file.size });
        resolve();
        return;
      }
      reject(transferRequestError(request));
    });
    request.addEventListener("error", () => {
      cleanup();
      reject(new FileHostClientError("FILE_TRANSFER_FAILED", "文件上传失败"));
    });
    request.addEventListener("abort", () => {
      cleanup();
      reject(new DOMException("文件上传已取消", "AbortError"));
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    options.onProgress?.({ loaded: 0, total: file.size });
    request.send(file);
  });
}

async function readDownload(
  response: Response,
  expectedSize: number,
  options: FileTransferOptions,
): Promise<Blob> {
  const contentLength = response.headers.get("content-length");
  const totalHeader = contentLength === null ? Number.NaN : Number(contentLength);
  const total =
    Number.isSafeInteger(totalHeader) && totalHeader >= 0
      ? totalHeader
      : expectedSize;
  if (!response.body) {
    const blob = await response.blob();
    options.onProgress?.({ loaded: blob.size, total });
    return blob;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  options.onProgress?.({ loaded, total });
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      loaded += next.value.byteLength;
      options.onProgress?.({ loaded, total });
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks.map((chunk) => Uint8Array.from(chunk).buffer));
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

function transferRequestError(request: XMLHttpRequest): FileHostClientError {
  let value: { error?: { code?: string; message?: string } } = {};
  try {
    value = JSON.parse(request.responseText) as typeof value;
  } catch {
    // Use the HTTP fallback below.
  }
  return new FileHostClientError(
    value.error?.code ?? "FILE_TRANSFER_FAILED",
    value.error?.message ?? `文件传输失败：HTTP ${request.status}`,
  );
}

async function requireTransferSuccess(response: Response): Promise<void> {
  if (response.ok) return;
  const value = await response.json().catch(() => ({})) as {
    error?: { code?: string; message?: string };
  };
  throw new FileHostClientError(
    value.error?.code ?? "FILE_TRANSFER_FAILED",
    value.error?.message ?? `文件传输失败：HTTP ${response.status}`,
  );
}
