import { FileContentStore, type FileContentRef } from "../files/fileContentStore.js";
import {
  loadEntryIndexAtHead,
  type EntryIndex,
  type IndexedEntry,
} from "../files/entryIndex.js";
import type { ImmutableObjectRepository } from "../files/immutableObjectRepository.js";
import { loadPvlogCore, type PvlogCore } from "../files/pvlogCore.js";
import {
  RefStoreError,
  type FilesystemRef,
  type SqliteRefStore,
} from "../files/sqliteRefStore.js";

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_LINES = 1_000;

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

export class WorkspaceTextDiffService {
  readonly #repository: ImmutableObjectRepository;
  readonly #refStore: SqliteRefStore;
  readonly #core: PvlogCore;
  readonly #content: FileContentStore;
  readonly #maxBytes: number;
  readonly #maxLines: number;
  readonly #beforeFinalRefRead?: () => void | Promise<void>;

  constructor(options: {
    repository: ImmutableObjectRepository;
    refStore: SqliteRefStore;
    core?: PvlogCore;
    maxBytes?: number;
    maxLines?: number;
    beforeFinalRefRead?: () => void | Promise<void>;
  }) {
    this.#repository = options.repository;
    this.#refStore = options.refStore;
    this.#core = options.core ?? loadPvlogCore();
    this.#content = new FileContentStore(this.#repository, this.#core);
    this.#maxBytes = positive(options.maxBytes ?? DEFAULT_MAX_BYTES);
    this.#maxLines = positive(options.maxLines ?? DEFAULT_MAX_LINES);
    this.#beforeFinalRefRead = options.beforeFinalRefRead;
  }

  async compare(workspaceIdHex: string, path: string): Promise<WorkspaceTextDiff> {
    validatePath(path);
    const workspace = this.#refStore.getWorkspace(workspaceIdHex);
    const beforeRef = this.#refStore.getRef(workspace.refId);
    const baselineRevision = await headRevision(
      this.#repository,
      this.#core,
      workspace.baselineHeadFidHex,
      beforeRef.lineageIdHex,
    );
    const [baseline, current] = await Promise.all([
      loadEntryIndexAtHead(
        this.#repository,
        workspace.baselineHeadFidHex,
        baselineRevision,
        beforeRef.lineageIdHex,
        this.#core,
      ),
      loadEntryIndexAtHead(
        this.#repository,
        beforeRef.headFidHex,
        beforeRef.revision,
        beforeRef.lineageIdHex,
        this.#core,
      ),
    ]);
    const oldEntry = findPath(baseline, path);
    const newEntry = findPath(current, path);
    if (
      oldEntry?.kind !== "file" ||
      newEntry?.kind !== "file" ||
      !oldEntry.content ||
      !newEntry.content ||
      (oldEntry.content.fidHex === newEntry.content.fidHex &&
        oldEntry.content.size === newEntry.content.size)
    ) {
      await this.#assertRefStable(workspace.refId, beforeRef);
      return { available: false, path, reason: "NOT_MODIFIED" };
    }
    if (
      oldEntry.content.size > this.#maxBytes ||
      newEntry.content.size > this.#maxBytes
    ) {
      await this.#assertRefStable(workspace.refId, beforeRef);
      return { available: false, path, reason: "TOO_LARGE" };
    }
    const [beforeBytes, afterBytes] = await Promise.all([
      readAll(this.#content, oldEntry.content),
      readAll(this.#content, newEntry.content),
    ]);
    const rendered = renderTextDiff(
      path,
      beforeBytes,
      afterBytes,
      this.#maxBytes,
      this.#maxLines,
    );
    if (!rendered.available) {
      await this.#assertRefStable(workspace.refId, beforeRef);
      return rendered;
    }
    const afterRef = await this.#assertRefStable(workspace.refId, beforeRef);
    return {
      available: true,
      path,
      baselineHeadFidHex: workspace.baselineHeadFidHex,
      currentHeadFidHex: afterRef.headFidHex,
      unifiedDiff: rendered.unifiedDiff,
    };
  }

  async #assertRefStable(
    refId: string,
    beforeRef: FilesystemRef,
  ): Promise<FilesystemRef> {
    await this.#beforeFinalRefRead?.();
    const afterRef = this.#refStore.getRef(refId);
    if (
      beforeRef.headFidHex !== afterRef.headFidHex ||
      beforeRef.revision !== afterRef.revision ||
      beforeRef.lineageIdHex !== afterRef.lineageIdHex
    ) {
      throw new RefStoreError(
        "REF_CONFLICT",
        "Workspace Ref changed while its text Diff was loading.",
      );
    }
    return afterRef;
  }
}

export function renderTextDiff(
  path: string,
  beforeBytes: Uint8Array,
  afterBytes: Uint8Array,
  maxBytes = DEFAULT_MAX_BYTES,
  maxLines = DEFAULT_MAX_LINES,
):
  | { available: true; path: string; unifiedDiff: string }
  | {
      available: false;
      path: string;
      reason: "NOT_TEXT" | "TOO_LARGE";
    } {
  if (beforeBytes.byteLength > maxBytes || afterBytes.byteLength > maxBytes) {
    return { available: false, path, reason: "TOO_LARGE" };
  }
  const beforeText = decodeText(beforeBytes);
  const afterText = decodeText(afterBytes);
  if (beforeText === null || afterText === null) {
    return { available: false, path, reason: "NOT_TEXT" };
  }
  const beforeLines = splitLines(beforeText);
  const afterLines = splitLines(afterText);
  if (beforeLines.length > maxLines || afterLines.length > maxLines) {
    return { available: false, path, reason: "TOO_LARGE" };
  }
  return {
    available: true,
    path,
    unifiedDiff: createUnifiedDiff(path, beforeLines, afterLines),
  };
}

export function createUnifiedDiff(
  path: string,
  before: readonly string[],
  after: readonly string[],
): string {
  const columns = after.length + 1;
  const matrix = new Uint32Array((before.length + 1) * columns);
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      matrix[left * columns + right] =
        before[left] === after[right]
          ? matrix[(left + 1) * columns + right + 1] + 1
          : Math.max(
              matrix[(left + 1) * columns + right],
              matrix[left * columns + right + 1],
            );
    }
  }
  const lines = [
    `--- baseline/${path}`,
    `+++ current/${path}`,
    `@@ -1,${before.length} +1,${after.length} @@`,
  ];
  let left = 0;
  let right = 0;
  while (left < before.length && right < after.length) {
    if (before[left] === after[right]) {
      lines.push(` ${before[left]}`);
      left += 1;
      right += 1;
    } else if (
      matrix[(left + 1) * columns + right] >=
      matrix[left * columns + right + 1]
    ) {
      lines.push(`-${before[left++]}`);
    } else {
      lines.push(`+${after[right++]}`);
    }
  }
  while (left < before.length) lines.push(`-${before[left++]}`);
  while (right < after.length) lines.push(`+${after[right++]}`);
  return `${lines.join("\n")}\n`;
}

async function headRevision(
  repository: ImmutableObjectRepository,
  core: PvlogCore,
  headFidHex: string,
  lineageIdHex: string,
): Promise<number> {
  const head = await repository.get("heads", headFidHex);
  core.validateHead(head);
  if (Buffer.from(core.headLineageId(head)).toString("hex") !== lineageIdHex) {
    throw new Error("Workspace text Diff baseline lineage is invalid.");
  }
  const revision = Number(core.headRevision(head));
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Workspace text Diff baseline revision is invalid.");
  }
  return revision;
}

function findPath(index: EntryIndex, path: string): IndexedEntry | undefined {
  let current = index.get(index.rootEntryIdHex);
  for (const name of path.split("/")) {
    if (!current || current.kind !== "directory") return undefined;
    current = index
      .listChildren(current.entryIdHex)
      .find((entry) => entry.name === name);
  }
  return current;
}

async function readAll(
  contentStore: FileContentStore,
  content: FileContentRef,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const bytes of contentStore.readChunks(content)) parts.push(bytes);
  return Buffer.concat(parts.map((part) => Buffer.from(part)), content.size);
}

function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function splitLines(value: string): string[] {
  if (value === "") return [];
  const normalized = value.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function validatePath(value: string): void {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("Workspace text Diff path is invalid.");
  }
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Workspace text Diff limit is invalid.");
  }
  return value;
}
