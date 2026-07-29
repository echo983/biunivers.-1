import { parsePackedEntries } from "./entryIndex.js";
import type { ImmutableObjectRepository } from "./immutableObjectRepository.js";
import { OBJECT_KINDS, type ObjectKind } from "./objectStore.js";
import { loadPvlogCore, type PvlogCore } from "./pvlogCore.js";
import type { SqliteRefStore } from "./sqliteRefStore.js";

const MAX_CANDIDATE_FIDS_PER_KIND = 1_000;

export interface GcObjectSummary {
  count: number;
  bytes: number;
}

export interface FileServiceGcReport {
  completedAt: string;
  complete: true;
  deletionAllowed: false;
  reachable: Record<ObjectKind, GcObjectSummary>;
  candidates: Record<ObjectKind, GcObjectSummary>;
  candidateFids: Partial<Record<ObjectKind, string[]>>;
  candidateFidsTruncated: boolean;
}

interface GcScannerOptions {
  repository: ImmutableObjectRepository;
  refStore: SqliteRefStore;
  now?: () => Date;
  core?: PvlogCore;
}

export class FileServiceGcScanner {
  readonly #repository: ImmutableObjectRepository;
  readonly #refStore: SqliteRefStore;
  readonly #now: () => Date;
  readonly #core: PvlogCore;
  #inFlight?: Promise<FileServiceGcReport>;

  constructor(options: GcScannerOptions) {
    this.#repository = options.repository;
    this.#refStore = options.refStore;
    this.#now = options.now ?? (() => new Date());
    this.#core = options.core ?? loadPvlogCore();
  }

  scan(): Promise<FileServiceGcReport> {
    if (!this.#inFlight) {
      this.#inFlight = this.#scan().finally(() => {
        this.#inFlight = undefined;
      });
    }
    return this.#inFlight;
  }

  async #scan(): Promise<FileServiceGcReport> {
    const reachable = createFidSets();
    const roots = new Set(this.#refStore.listProtectedHeadFids("main"));
    for (const headFid of roots) {
      await this.#markHeadHistory(headFid, reachable);
    }

    const inventory = await this.#repository.list();
    const reachableSummary = createSummary();
    const candidateSummary = createSummary();
    const candidateFids: Partial<Record<ObjectKind, string[]>> = {};
    let candidateFidsTruncated = false;
    for (const item of inventory) {
      const target = reachable[item.kind].has(item.fidHex)
        ? reachableSummary
        : candidateSummary;
      target[item.kind].count += 1;
      target[item.kind].bytes += item.size;
      if (!reachable[item.kind].has(item.fidHex)) {
        const details = (candidateFids[item.kind] ??= []);
        if (details.length < MAX_CANDIDATE_FIDS_PER_KIND) {
          details.push(item.fidHex);
        } else {
          candidateFidsTruncated = true;
        }
      }
    }
    return {
      completedAt: this.#now().toISOString(),
      complete: true,
      deletionAllowed: false,
      reachable: reachableSummary,
      candidates: candidateSummary,
      candidateFids,
      candidateFidsTruncated,
    };
  }

  async #markHeadHistory(
    initialHeadFid: string,
    reachable: Record<ObjectKind, Set<string>>,
  ): Promise<void> {
    let headFid = initialHeadFid;
    while (headFid && !reachable.heads.has(headFid)) {
      reachable.heads.add(headFid);
      const head = await this.#repository.get("heads", headFid);
      this.#core.validateHead(head);

      const segmentFid = toOptionalHex(this.#core.headLastSegmentFid(head));
      if (segmentFid) {
        reachable.segments.add(segmentFid);
        this.#core.validateSegment(
          await this.#repository.get("segments", segmentFid),
        );
      }

      const checkpointFid = Buffer.from(
        this.#core.headCheckpointFid(head),
      ).toString("hex");
      if (!reachable.checkpoints.has(checkpointFid)) {
        reachable.checkpoints.add(checkpointFid);
        const checkpoint = await this.#repository.get(
          "checkpoints",
          checkpointFid,
        );
        this.#core.validateCheckpoint(checkpoint);
        for (const entry of parsePackedEntries(
          this.#core.checkpointEntriesPacked(checkpoint),
        )) {
          if (!entry.content) continue;
          reachable[entry.content.kind === "chunk" ? "chunks" : "manifests"]
            .add(entry.content.fidHex);
          if (entry.content.kind === "manifest") {
            const manifest = await this.#repository.get(
              "manifests",
              entry.content.fidHex,
            );
            this.#core.validateManifest(manifest);
            const fids = this.#core.manifestChunkFids(manifest);
            for (let offset = 0; offset < fids.byteLength; offset += 16) {
              reachable.chunks.add(
                Buffer.from(fids.subarray(offset, offset + 16)).toString("hex"),
              );
            }
          }
        }
      }
      headFid = toOptionalHex(this.#core.headParentFid(head));
    }
  }
}

function createFidSets(): Record<ObjectKind, Set<string>> {
  return Object.fromEntries(
    OBJECT_KINDS.map((kind) => [kind, new Set<string>()]),
  ) as Record<ObjectKind, Set<string>>;
}

function createSummary(): Record<ObjectKind, GcObjectSummary> {
  return Object.fromEntries(
    OBJECT_KINDS.map((kind) => [kind, { count: 0, bytes: 0 }]),
  ) as Record<ObjectKind, GcObjectSummary>;
}

function toOptionalHex(bytes: Uint8Array): string {
  return bytes.byteLength === 0 ? "" : Buffer.from(bytes).toString("hex");
}
