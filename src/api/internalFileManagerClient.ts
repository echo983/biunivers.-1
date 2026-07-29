import { FileHostClientError } from "../hostApi/fileHostClient";

export interface FileMutationResult {
  entryId: string;
  revision: number;
}

export function createDirectory(
  instanceToken: string,
  parentEntryId: string,
  name: string,
  expectedRevision: number,
): Promise<FileMutationResult> {
  return internalFetch("/api/v1/internal/files/directories", instanceToken, {
    method: "POST",
    body: JSON.stringify({ parentEntryId, name, expectedRevision }),
  });
}

export function moveEntry(
  instanceToken: string,
  entryId: string,
  newParentEntryId: string,
  newName: string,
  expectedRevision: number,
): Promise<FileMutationResult> {
  return internalFetch(
    `/api/v1/internal/files/entries/${encodeURIComponent(entryId)}`,
    instanceToken,
    {
      method: "PATCH",
      body: JSON.stringify({
        newParentEntryId,
        newName,
        expectedRevision,
      }),
    },
  );
}

export function removeEntry(
  instanceToken: string,
  entryId: string,
  recursive: boolean,
  expectedRevision: number,
): Promise<FileMutationResult> {
  return internalFetch(
    `/api/v1/internal/files/entries/${encodeURIComponent(entryId)}`,
    instanceToken,
    {
      method: "DELETE",
      body: JSON.stringify({ recursive, expectedRevision }),
    },
  );
}

async function internalFetch<T>(
  url: string,
  instanceToken: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Biunivers-Instance ${instanceToken}`,
      "Content-Type": "application/json",
    },
  });
  const value = (await response.json()) as {
    error?: { code?: string; message?: string };
  };
  if (!response.ok) {
    throw new FileHostClientError(
      value.error?.code ?? "FILE_MANAGER_FAILED",
      value.error?.message ?? `File manager request failed: HTTP ${response.status}`,
    );
  }
  return value as T;
}
