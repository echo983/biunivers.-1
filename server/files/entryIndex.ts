import type { FileContentRef } from "./fileContentStore.js";
import type { ImmutableObjectRepository } from "./immutableObjectRepository.js";
import { ObjectStoreError } from "./objectStore.js";
import { loadPvlogCore, type PvlogCore } from "./pvlogCore.js";
import type { SqliteRefStore } from "./sqliteRefStore.js";

export interface IndexedEntry {
  entryIdHex: string;
  parentEntryIdHex: string | null;
  name: string;
  kind: "directory" | "file";
  createdAtMs: number;
  mtimeMs: number;
  content?: FileContentRef;
}

export class EntryIndex {
  readonly revision: number;
  readonly rootEntryIdHex: string;
  readonly #entries: Map<string, IndexedEntry>;
  readonly #children: Map<string, IndexedEntry[]>;

  constructor(revision: number, entries: IndexedEntry[]) {
    this.revision = revision;
    this.#entries = new Map(entries.map((entry) => [entry.entryIdHex, entry]));
    const roots = entries.filter((entry) => entry.parentEntryIdHex === null);
    if (roots.length !== 1) {
      throw integrityFailure("Entry projection does not contain exactly one root.");
    }
    this.rootEntryIdHex = roots[0].entryIdHex;
    this.#children = new Map();
    for (const entry of entries) {
      if (entry.parentEntryIdHex === null) {
        continue;
      }
      const siblings = this.#children.get(entry.parentEntryIdHex) ?? [];
      siblings.push(entry);
      this.#children.set(entry.parentEntryIdHex, siblings);
    }
    for (const siblings of this.#children.values()) {
      siblings.sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );
    }
  }

  get(entryIdHex: string): IndexedEntry | undefined {
    return this.#entries.get(entryIdHex);
  }

  listChildren(parentEntryIdHex: string): readonly IndexedEntry[] {
    return this.#children.get(parentEntryIdHex) ?? [];
  }

  has(entryIdHex: string): boolean {
    return this.#entries.has(entryIdHex);
  }
}

export async function loadCurrentEntryIndex(
  repository: ImmutableObjectRepository,
  refStore: SqliteRefStore,
  core: PvlogCore = loadPvlogCore(),
): Promise<EntryIndex> {
  const ref = refStore.getRef("main");
  const head = await repository.get("heads", ref.headFidHex);
  core.validateHead(head);
  const revision = Number(core.headRevision(head));
  const lineageIdHex = Buffer.from(core.headLineageId(head)).toString("hex");
  if (revision !== ref.revision || lineageIdHex !== ref.lineageIdHex) {
    throw integrityFailure("Ref metadata does not match its Head.");
  }
  const checkpointFidHex = Buffer.from(core.headCheckpointFid(head)).toString(
    "hex",
  );
  const checkpoint = await repository.get("checkpoints", checkpointFidHex);
  core.validateCheckpoint(checkpoint);
  return new EntryIndex(
    revision,
    parsePackedEntries(core.checkpointEntriesPacked(checkpoint)),
  );
}

export function parsePackedEntries(packed: Uint8Array): IndexedEntry[] {
  const reader = new PackedReader(packed);
  const count = reader.u32();
  if (count > 1_000_000) {
    throw integrityFailure("Entry projection count exceeds its limit.");
  }
  const entries: IndexedEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const entryIdHex = reader.hex(16);
    const hasParent = reader.u8();
    if (hasParent !== 0 && hasParent !== 1) {
      throw integrityFailure("Entry projection parent flag is invalid.");
    }
    const parentBytes = reader.bytes(16);
    const parentEntryIdHex =
      hasParent === 1 ? Buffer.from(parentBytes).toString("hex") : null;
    if (hasParent === 0 && parentBytes.some((byte) => byte !== 0)) {
      throw integrityFailure("Root projection contains a non-zero parent.");
    }
    const kindValue = reader.u8();
    const createdAtMs = reader.safeU64();
    const mtimeMs = reader.safeU64();
    const size = reader.safeU64();
    const contentKind = reader.u8();
    const contentFidBytes = reader.bytes(16);
    const nameLength = reader.u32();
    const name = reader.text(nameLength);

    if (kindValue === 1) {
      if (
        size !== 0 ||
        contentKind !== 0 ||
        contentFidBytes.some((byte) => byte !== 0)
      ) {
        throw integrityFailure("Directory projection contains file content.");
      }
      entries.push({
        entryIdHex,
        parentEntryIdHex,
        name,
        kind: "directory",
        createdAtMs,
        mtimeMs,
      });
    } else if (kindValue === 2 && (contentKind === 1 || contentKind === 2)) {
      entries.push({
        entryIdHex,
        parentEntryIdHex,
        name,
        kind: "file",
        createdAtMs,
        mtimeMs,
        content: {
          kind: contentKind === 1 ? "chunk" : "manifest",
          fidHex: Buffer.from(contentFidBytes).toString("hex"),
          size,
        },
      });
    } else {
      throw integrityFailure("Entry projection kind is invalid.");
    }
  }
  reader.finish();
  return entries;
}

class PackedReader {
  #offset = 0;
  readonly #view: DataView;

  constructor(private readonly data: Uint8Array) {
    this.#view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  u8(): number {
    this.require(1);
    return this.data[this.#offset++];
  }

  u32(): number {
    this.require(4);
    const value = this.#view.getUint32(this.#offset);
    this.#offset += 4;
    return value;
  }

  safeU64(): number {
    this.require(8);
    const value = this.#view.getBigUint64(this.#offset);
    this.#offset += 8;
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric)) {
      throw integrityFailure("Entry projection integer exceeds the safe range.");
    }
    return numeric;
  }

  bytes(length: number): Uint8Array {
    this.require(length);
    const value = this.data.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }

  hex(length: number): string {
    return Buffer.from(this.bytes(length)).toString("hex");
  }

  text(length: number): string {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      return decoder.decode(this.bytes(length));
    } catch (error) {
      throw new ObjectStoreError(
        "OBJECT_INTEGRITY_FAILURE",
        "Entry projection name is not valid UTF-8.",
        { cause: error },
      );
    }
  }

  finish(): void {
    if (this.#offset !== this.data.byteLength) {
      throw integrityFailure("Entry projection contains trailing bytes.");
    }
  }

  require(length: number): void {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      this.#offset + length > this.data.byteLength
    ) {
      throw integrityFailure("Entry projection is truncated.");
    }
  }
}

function integrityFailure(message: string): ObjectStoreError {
  return new ObjectStoreError("OBJECT_INTEGRITY_FAILURE", message);
}
