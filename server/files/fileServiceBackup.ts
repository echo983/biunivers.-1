import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { loadCurrentEntryIndex } from "./entryIndex.js";
import type { ImmutableObjectRepository } from "./immutableObjectRepository.js";
import { SqliteRefStore } from "./sqliteRefStore.js";

export interface FileServiceBackupResult {
  createdAt: string;
  revision: number;
  rootEntryIdHex: string;
  size: number;
  fileName: string;
}

interface FileServiceBackupOptions {
  repository: ImmutableObjectRepository;
  refStore: SqliteRefStore;
  backupPath: string;
  now?: () => Date;
}

export class FileServiceBackup {
  readonly #repository: ImmutableObjectRepository;
  readonly #refStore: SqliteRefStore;
  readonly #backupPath: string;
  readonly #now: () => Date;
  #inFlight?: Promise<FileServiceBackupResult>;

  constructor(options: FileServiceBackupOptions) {
    this.#repository = options.repository;
    this.#refStore = options.refStore;
    this.#backupPath = options.backupPath;
    this.#now = options.now ?? (() => new Date());
  }

  createLatest(): Promise<FileServiceBackupResult> {
    if (!this.#inFlight) {
      this.#inFlight = this.#createLatest().finally(() => {
        this.#inFlight = undefined;
      });
    }
    return this.#inFlight;
  }

  async #createLatest(): Promise<FileServiceBackupResult> {
    await this.#refStore.backupTo(this.#backupPath);

    const backup = await SqliteRefStore.openExisting(this.#backupPath);
    try {
      const index = await loadCurrentEntryIndex(this.#repository, backup, "main");
      const metadata = await stat(this.#backupPath);
      return {
        createdAt: this.#now().toISOString(),
        revision: index.revision,
        rootEntryIdHex: index.rootEntryIdHex,
        size: metadata.size,
        fileName: basename(this.#backupPath),
      };
    } finally {
      backup.close();
    }
  }
}
