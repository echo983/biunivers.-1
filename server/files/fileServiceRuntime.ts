import { S3Client } from "@aws-sdk/client-s3";
import type { FileServiceConfig } from "../config.js";
import { loadCurrentEntryIndex, type EntryIndex } from "./entryIndex.js";
import { initializeGenesisFileSystem } from "./genesisFileSystem.js";
import { ImmutableObjectRepository } from "./immutableObjectRepository.js";
import type { ImmutableObjectStore } from "./objectStore.js";
import { S3WormObjectStore } from "./s3WormObjectStore.js";
import { SqliteRefStore } from "./sqliteRefStore.js";

export type FileServiceStatus =
  | { mode: "disabled"; writable: false }
  | {
      mode: "ready";
      writable: true;
      revision: number;
      rootEntryIdHex: string;
    }
  | {
      mode: "offline";
      writable: false;
      code: string;
      message: string;
    };

export interface FileServiceObjectStoreHandle {
  store: ImmutableObjectStore;
  close(): void;
}

interface RuntimeDependencies {
  createObjectStore?: (
    config: FileServiceConfig,
  ) => FileServiceObjectStoreHandle;
}

export class FileServiceRuntime {
  constructor(
    public readonly status: FileServiceStatus,
    public readonly repository?: ImmutableObjectRepository,
    public readonly refStore?: SqliteRefStore,
    public readonly entryIndex?: EntryIndex,
    private readonly objectStoreHandle?: FileServiceObjectStoreHandle,
  ) {}

  close(): void {
    this.refStore?.close();
    this.objectStoreHandle?.close();
  }

  async currentStatus(): Promise<FileServiceStatus> {
    if (
      this.status.mode !== "ready" ||
      !this.repository ||
      !this.refStore
    ) {
      return this.status;
    }
    try {
      const index = await loadCurrentEntryIndex(
        this.repository,
        this.refStore,
      );
      return {
        mode: "ready",
        writable: true,
        revision: index.revision,
        rootEntryIdHex: index.rootEntryIdHex,
      };
    } catch (error) {
      return {
        mode: "offline",
        writable: false,
        code: errorCode(error),
        message: safeMessage(error),
      };
    }
  }
}

export async function startFileService(
  config: FileServiceConfig | undefined,
  dependencies: RuntimeDependencies = {},
): Promise<FileServiceRuntime> {
  if (!config) {
    return new FileServiceRuntime({ mode: "disabled", writable: false });
  }

  let objectStoreHandle: FileServiceObjectStoreHandle | undefined;
  let refStore: SqliteRefStore | undefined;
  try {
    objectStoreHandle = (
      dependencies.createObjectStore ?? createS3ObjectStore
    )(config);
    const repository = new ImmutableObjectRepository(
      objectStoreHandle.store,
      config.namespace,
    );
    if (config.initialize) {
      const genesis = await initializeGenesisFileSystem({
        databasePath: config.databasePath,
        repository,
        writerId: config.writerId,
      });
      refStore = genesis.store;
    } else {
      refStore = await SqliteRefStore.openExisting(config.databasePath);
    }
    const entryIndex = await loadCurrentEntryIndex(repository, refStore);
    return new FileServiceRuntime(
      {
        mode: "ready",
        writable: true,
        revision: entryIndex.revision,
        rootEntryIdHex: entryIndex.rootEntryIdHex,
      },
      repository,
      refStore,
      entryIndex,
      objectStoreHandle,
    );
  } catch (error) {
    refStore?.close();
    objectStoreHandle?.close();
    return new FileServiceRuntime({
      mode: "offline",
      writable: false,
      code: errorCode(error),
      message: safeMessage(error),
    });
  }
}

function createS3ObjectStore(
  config: FileServiceConfig,
): FileServiceObjectStoreHandle {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  return {
    store: new S3WormObjectStore({
      bucket: config.bucket,
      client,
      keyPrefix: config.keyPrefix,
    }),
    close: () => client.destroy(),
  };
}

function errorCode(error: unknown): string {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "FILE_SERVICE_START_FAILED";
}

function safeMessage(error: unknown): string {
  const code = errorCode(error);
  if (
    error instanceof Error &&
    ["REFSTORE_MISSING", "REFSTORE_CORRUPT", "REF_ALREADY_EXISTS"].includes(
      code,
    )
  ) {
    return error.message;
  }
  return "File Service storage validation failed.";
}
