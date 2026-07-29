export interface FileEntry {
  entryId: string;
  name: string;
  kind: "directory" | "file";
  size?: number;
  mtimeMs: number;
}

export interface DirectoryListing {
  revision: number;
  rootEntryId: string;
  parent: FileEntry;
  breadcrumbs?: FileEntry[];
  entries: FileEntry[];
}

export interface FileHandleGrant {
  handleId: string;
  writable: boolean;
  expiresAt: string;
  metadata: Omit<FileEntry, "entryId"> & {
    entryId?: string;
    revision: number;
  };
}

export interface FileTransfer {
  transferId: string;
  url: string;
  method: "GET" | "PUT";
  authorization: "Biunivers-Instance";
  instanceToken: string;
  expiresAt: string;
  maxBytes: number;
}

export class FileHostClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FileHostClientError";
  }
}

export async function listFiles(
  instanceToken: string,
  parentEntryId?: string,
): Promise<DirectoryListing> {
  const query = parentEntryId
    ? `?parent=${encodeURIComponent(parentEntryId)}`
    : "";
  return hostFetch(`/api/v1/host/files${query}`, instanceToken);
}

export async function openFileHandle(
  instanceToken: string,
  entryId: string,
  writable: boolean,
): Promise<FileHandleGrant> {
  return hostFetch("/api/v1/host/handles", instanceToken, {
    method: "POST",
    body: JSON.stringify({ entryId, writable }),
  });
}

export async function createSaveHandle(
  instanceToken: string,
  parentEntryId: string,
  name: string,
): Promise<FileHandleGrant> {
  return hostFetch("/api/v1/host/save-handles", instanceToken, {
    method: "POST",
    body: JSON.stringify({ parentEntryId, name }),
  });
}

export async function getFileMetadata(
  instanceToken: string,
  handleId: string,
): Promise<unknown> {
  return hostFetch(
    `/api/v1/host/handles/${encodeURIComponent(handleId)}`,
    instanceToken,
  );
}

export async function releaseFileHandle(
  instanceToken: string,
  handleId: string,
): Promise<null> {
  await hostFetch(
    `/api/v1/host/handles/${encodeURIComponent(handleId)}`,
    instanceToken,
    { method: "DELETE" },
  );
  return null;
}

export async function createFileTransfer(
  instanceToken: string,
  handleId: string,
  method: "GET" | "PUT",
): Promise<FileTransfer> {
  return hostFetch("/api/v1/host/transfers", instanceToken, {
    method: "POST",
    body: JSON.stringify({ handleId, method }),
  });
}

async function hostFetch<T>(
  url: string,
  instanceToken: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Biunivers-Instance ${instanceToken}`);
  if (init.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(url, { ...init, headers });
  if (response.status === 204) {
    return null as T;
  }
  const value = (await response.json()) as {
    error?: { code?: string; message?: string };
  };
  if (!response.ok) {
    throw new FileHostClientError(
      value.error?.code ?? "HOST_API_FAILED",
      value.error?.message ?? `Host API failed: HTTP ${response.status}`,
    );
  }
  return value as T;
}
