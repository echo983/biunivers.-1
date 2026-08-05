import type { DirectoryListing } from "../hostApi/fileHostClient";

export interface WorkspaceSummary {
  workspaceIdHex: string;
  refId: string;
  name: string;
  sourceRefId: string;
  sourceHeadFidHex: string;
  baselineHeadFidHex: string;
  state: "READY" | "DELETING";
  retention: "TEMPORARY" | "KEPT";
  activeWriteRunIdHex: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  revision: number;
}

export interface WorkspaceDiffEntryMetadata {
  entryIdHex: string;
  kind: "directory" | "file";
  size: number;
  mtimeMs: number;
  contentFidHex: string | null;
}

export interface WorkspaceDiff {
  workspaceIdHex: string;
  baselineHeadFidHex: string;
  currentHeadFidHex: string;
  baselineRevision: number;
  currentRevision: number;
  changes: Array<{
    path: string;
    change: "added" | "modified" | "deleted";
    before: WorkspaceDiffEntryMetadata | null;
    after: WorkspaceDiffEntryMetadata | null;
  }>;
  summary: { added: number; modified: number; deleted: number };
}

export type WorkspaceTextDiff =
  | {
      available: true;
      path: string;
      baselineHeadFidHex: string;
      currentHeadFidHex: string;
      unifiedDiff: string;
    }
  | {
      available: false;
      path: string;
      reason: "NOT_MODIFIED" | "NOT_TEXT" | "TOO_LARGE";
    };

export function createWorkspace(
  instanceToken: string,
  input: {
    name: string;
    selectedEntryIds: string[];
    retention?: "TEMPORARY" | "KEPT";
  },
): Promise<{ workspace: WorkspaceSummary; entryCount: number }> {
  return request("/api/v1/internal/workspaces", instanceToken, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listWorkspaces(
  instanceToken: string,
): Promise<WorkspaceSummary[]> {
  const result = await request<{ workspaces: WorkspaceSummary[] }>(
    "/api/v1/internal/workspaces",
    instanceToken,
  );
  return result.workspaces;
}

export function setWorkspaceRetention(
  instanceToken: string,
  workspaceIdHex: string,
  retention: "TEMPORARY" | "KEPT",
): Promise<WorkspaceSummary> {
  return request(
    `/api/v1/internal/workspaces/${workspaceIdHex}`,
    instanceToken,
    {
      method: "PATCH",
      body: JSON.stringify({ retention }),
    },
  );
}

export async function deleteWorkspace(
  instanceToken: string,
  workspaceIdHex: string,
): Promise<void> {
  await request(
    `/api/v1/internal/workspaces/${workspaceIdHex}`,
    instanceToken,
    { method: "DELETE" },
  );
}

export function listWorkspaceFiles(
  instanceToken: string,
  workspaceIdHex: string,
  parentEntryId?: string,
): Promise<DirectoryListing> {
  const query = parentEntryId
    ? `?parent=${encodeURIComponent(parentEntryId)}`
    : "";
  return request(
    `/api/v1/internal/workspaces/${workspaceIdHex}/files${query}`,
    instanceToken,
  );
}

export function getWorkspaceDiff(
  instanceToken: string,
  workspaceIdHex: string,
): Promise<WorkspaceDiff> {
  return request(
    `/api/v1/internal/workspaces/${workspaceIdHex}/diff`,
    instanceToken,
  );
}

export function getWorkspaceTextDiff(
  instanceToken: string,
  workspaceIdHex: string,
  path: string,
): Promise<WorkspaceTextDiff> {
  return request(
    `/api/v1/internal/workspaces/${workspaceIdHex}/diff/text?path=${encodeURIComponent(path)}`,
    instanceToken,
  );
}

export function importWorkspaceEntries(
  instanceToken: string,
  workspaceIdHex: string,
  input: {
    selectedEntryIds: string[];
    destinationEntryId: string;
    workspaceRevision: number;
    mainRevision: number;
    conflictPolicy: "cancel" | "rename";
  },
): Promise<{
  revision: number;
  roots: Array<{
    sourceEntryIdHex: string;
    newEntryIdHex: string;
    name: string;
  }>;
}> {
  return request(
    `/api/v1/internal/workspaces/${workspaceIdHex}/import`,
    instanceToken,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function addMainEntriesToWorkspace(
  instanceToken: string,
  workspaceIdHex: string,
  input: {
    selectedEntryIds: string[];
    destinationEntryId: string;
    mainRevision: number;
    workspaceRevision: number;
  },
): Promise<{
  revision: number;
  roots: Array<{ sourceEntryIdHex: string; newEntryIdHex: string; name: string }>;
}> {
  return request(
    `/api/v1/internal/workspaces/${workspaceIdHex}/add-from-main`,
    instanceToken,
    { method: "POST", body: JSON.stringify(input) },
  );
}

async function request<T>(
  path: string,
  instanceToken: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Biunivers-Instance ${instanceToken}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (response.status === 204) return undefined as T;
  const value = await response.json();
  if (!response.ok) {
    throw new Error(
      value?.error?.message ?? `Workspace request failed: HTTP ${response.status}`,
    );
  }
  return value as T;
}
