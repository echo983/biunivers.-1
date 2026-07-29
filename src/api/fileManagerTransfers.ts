import {
  createFileTransfer,
  createSaveHandle,
  openFileHandle,
  releaseFileHandle,
  FileHostClientError,
  type FileEntry,
} from "../hostApi/fileHostClient";

export async function uploadLocalFile(
  instanceToken: string,
  parentEntryId: string,
  file: File,
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
    const response = await fetch(transfer.url, {
      method: "PUT",
      headers: {
        Authorization: `Biunivers-Instance ${transfer.instanceToken}`,
        "Content-Type": "application/octet-stream",
      },
      body: file,
    });
    await requireTransferSuccess(response);
  } finally {
    await releaseFileHandle(instanceToken, handle.handleId).catch(() => {});
  }
}

export async function downloadFile(
  instanceToken: string,
  entry: FileEntry,
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
    });
    if (!response.ok) {
      await requireTransferSuccess(response);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement("a");
      link.href = url;
      link.download = entry.name;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
    } finally {
      URL.revokeObjectURL(url);
    }
  } finally {
    await releaseFileHandle(instanceToken, handle.handleId).catch(() => {});
  }
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
