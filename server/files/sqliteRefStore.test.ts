import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  RefStoreError,
  SqliteRefStore,
  type FilesystemRef,
  type CreateWorkspaceInput,
} from "./sqliteRefStore.js";

const roots: string[] = [];
const initial: FilesystemRef = {
  refId: "main",
  lineageIdHex: "10101010101010101010101010101010",
  headFidHex: "20202020202020202020202020202020",
  revision: 0,
  updatedAtMs: 1_785_320_000_000,
};
const workspaceIdHex = "30303030303030303030303030303030";

function workspaceInput(
  overrides: Partial<CreateWorkspaceInput> = {},
): CreateWorkspaceInput {
  const headFidHex = "40404040404040404040404040404040";
  return {
    workspaceIdHex,
    refId: `ws-${workspaceIdHex}`,
    name: "Probe workspace",
    sourceRefId: "main",
    sourceHeadFidHex: initial.headFidHex,
    baselineHeadFidHex: headFidHex,
    state: "READY",
    retention: "KEPT",
    activeWriteRunIdHex: null,
    createdAtMs: initial.updatedAtMs + 1,
    updatedAtMs: initial.updatedAtMs + 1,
    ref: {
      refId: `ws-${workspaceIdHex}`,
      lineageIdHex: "50505050505050505050505050505050",
      headFidHex,
      revision: 0,
      updatedAtMs: initial.updatedAtMs + 1,
    },
    ...overrides,
  };
}

async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "biunivers-refstore-"));
  roots.push(root);
  return join(root, "file-service.sqlite");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("SqliteRefStore", () => {
  it("creates schema v6 and atomically migrates existing v1 through v5 databases", async () => {
    const freshPath = await databasePath();
    const fresh = await SqliteRefStore.initialize(freshPath);
    fresh.close();
    expect(readSchema(freshPath)).toEqual({
      version: 6,
      workspaceTables: ["workspace_records", "workspace_runs"],
      bwaTables: ["bwa_application_environment", "bwa_applications", "bwa_environment", "bwa_instances", "bwa_run_bindings", "bwa_startup_failures"],
    });

    const legacyPath = await databasePath();
    createLegacySchemaV1(legacyPath);
    const migrated = await SqliteRefStore.openExisting(legacyPath);
    expect(migrated.getRef("main")).toEqual(initial);
    migrated.close();
    expect(readSchema(legacyPath)).toEqual({
      version: 6,
      workspaceTables: ["workspace_records", "workspace_runs"],
      bwaTables: ["bwa_application_environment", "bwa_applications", "bwa_environment", "bwa_instances", "bwa_run_bindings", "bwa_startup_failures"],
    });

    const v2Path = await databasePath();
    const v2 = await SqliteRefStore.initialize(v2Path);
    v2.createRef(initial);
    v2.close();
    downgradeSchemaToV2(v2Path);
    const migratedV2 = await SqliteRefStore.openExisting(v2Path);
    expect(migratedV2.getRef("main")).toEqual(initial);
    migratedV2.close();
    expect(readSchema(v2Path)).toEqual({
      version: 6,
      workspaceTables: ["workspace_records", "workspace_runs"],
      bwaTables: ["bwa_application_environment", "bwa_applications", "bwa_environment", "bwa_instances", "bwa_run_bindings", "bwa_startup_failures"],
    });

    const v3Path = await databasePath();
    const v3 = await SqliteRefStore.initialize(v3Path);
    v3.createRef(initial);
    v3.close();
    downgradeSchemaToV3(v3Path);
    const migratedV3 = await SqliteRefStore.openExisting(v3Path);
    expect(migratedV3.getRef("main")).toEqual(initial);
    migratedV3.close();
    expect(readSchema(v3Path)).toEqual({
      version: 6,
      workspaceTables: ["workspace_records", "workspace_runs"],
      bwaTables: ["bwa_application_environment", "bwa_applications", "bwa_environment", "bwa_instances", "bwa_run_bindings", "bwa_startup_failures"],
    });

    const v4Path = await databasePath();
    const v4 = await SqliteRefStore.initialize(v4Path);
    v4.close();
    downgradeSchemaToV4(v4Path);
    const migratedV4 = await SqliteRefStore.openExisting(v4Path);
    migratedV4.close();
    expect(readSchema(v4Path)).toMatchObject({ version: 6 });

    const v5Path = await databasePath();
    const v5 = await SqliteRefStore.initialize(v5Path);
    v5.createRef(initial);
    v5.close();
    downgradeSchemaToV5(v5Path);
    const migratedV5 = await SqliteRefStore.openExisting(v5Path);
    expect(migratedV5.getRef("main")).toEqual(initial);
    migratedV5.close();
    expect(readSchema(v5Path)).toMatchObject({ version: 6 });
  });

  it("rejects an unsupported future schema without changing its version", async () => {
    const path = await databasePath();
    const database = new Database(path);
    database.pragma("user_version = 99");
    database.close();

    await expect(SqliteRefStore.openExisting(path)).rejects.toMatchObject({
      code: "REFSTORE_CORRUPT",
    });
    const reopened = new Database(path, { readonly: true });
    expect(reopened.pragma("user_version", { simple: true })).toBe(99);
    reopened.close();
  });

  it("rolls back every schema change when a v1 migration fails", async () => {
    const path = await databasePath();
    createLegacySchemaV1(path);
    const damaged = new Database(path);
    damaged.exec("DROP TABLE file_service_meta");
    damaged.close();

    await expect(SqliteRefStore.openExisting(path)).rejects.toMatchObject({
      code: "REFSTORE_CORRUPT",
    });
    expect(readSchema(path)).toEqual({
      version: 1,
      workspaceTables: [],
      bwaTables: [],
    });
  });

  it("requires explicit first-time initialization and refuses reinitialization", async () => {
    const path = await databasePath();
    await expect(SqliteRefStore.openExisting(path)).rejects.toMatchObject({
      code: "REFSTORE_MISSING",
    });

    const store = await SqliteRefStore.initialize(path);
    store.close();
    await expect(SqliteRefStore.initialize(path)).rejects.toMatchObject({
      code: "REF_ALREADY_EXISTS",
    });
  });

  it("persists refs across clean close and restart", async () => {
    const path = await databasePath();
    const store = await SqliteRefStore.initialize(path);
    expect(store.createRef(initial)).toEqual(initial);
    store.close();

    const reopened = await SqliteRefStore.openExisting(path);
    expect(reopened.getRef("main")).toEqual(initial);
    reopened.close();
  });

  it("atomically creates, lists, restores, and deletes a Workspace with its Ref", async () => {
    const path = await databasePath();
    const backupPath = join(join(path, ".."), "backups", "workspace.sqlite");
    const store = await SqliteRefStore.initialize(path);
    store.createRef(initial);
    const input = workspaceInput();

    const created = store.createWorkspace(input);
    expect(created).toEqual(store.getWorkspace(workspaceIdHex));
    expect(created).not.toHaveProperty("ref");
    expect(store.listWorkspaces()).toEqual([store.getWorkspace(workspaceIdHex)]);
    expect(store.listRefs().map((ref) => ref.refId)).toEqual([
      "main",
      input.refId,
    ]);
    await store.backupTo(backupPath);

    store.deleteWorkspace(workspaceIdHex);
    expect(store.listWorkspaces()).toEqual([]);
    expect(store.listRefs()).toEqual([initial]);
    expect(() => store.getWorkspace(workspaceIdHex)).toThrowError(
      expect.objectContaining({ code: "WORKSPACE_NOT_FOUND" }) as RefStoreError,
    );
    expect(() => store.getRef(input.refId)).toThrowError(
      expect.objectContaining({ code: "REF_NOT_FOUND" }) as RefStoreError,
    );
    store.close();

    const restored = await SqliteRefStore.openExisting(backupPath);
    expect(restored.getWorkspace(workspaceIdHex).refId).toBe(input.refId);
    expect(restored.getRef(input.refId)).toEqual(input.ref);
    restored.close();
  });

  it("updates Workspace retention without changing its Ref", async () => {
    const path = await databasePath();
    const store = await SqliteRefStore.initialize(path);
    store.createRef(initial);
    const created = store.createWorkspace(workspaceInput());
    const updated = store.setWorkspaceRetention(
      workspaceIdHex,
      "KEPT",
      created.updatedAtMs + 1,
    );
    expect(updated.retention).toBe("KEPT");
    expect(updated.updatedAtMs).toBe(created.updatedAtMs + 1);
    expect(store.getRef(created.refId)).toEqual(workspaceInput().ref);
    store.close();
  });

  it("persists BWA applications, binds one Instance per Workspace, and protects bound state", async () => {
    const path = await databasePath();
    const store = await SqliteRefStore.initialize(path);
    store.createRef(initial);
    store.createWorkspace(workspaceInput());
    const application = store.createBwaApplication(bwaApplication());
    expect(application.defaultInstanceIdHex).toBeNull();

    const instance = store.createBwaInstance(bwaInstance());
    expect(store.getBwaApplication(application.applicationId).defaultInstanceIdHex).toBe(
      instance.instanceIdHex,
    );
    expect(store.listBwaInstances(application.applicationId)).toEqual([instance]);
    expect(() => store.deleteWorkspace(workspaceIdHex)).toThrowError(
      expect.objectContaining({ code: "WORKSPACE_BOUND" }) as RefStoreError,
    );
    expect(() =>
      store.createBwaInstance({
        ...bwaInstance(),
        instanceIdHex: "62626262626262626262626262626262",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "INSTANCE_ALREADY_EXISTS" }) as RefStoreError,
    );

    expect(
      store.replaceBwaEnvironment(instance.instanceIdHex, [
        { name: "MODE", value: "safe", sensitive: false },
        { name: "API_TOKEN", value: null, sensitive: true },
      ]),
    ).toEqual([
      { name: "API_TOKEN", value: null, sensitive: true },
      { name: "MODE", value: "safe", sensitive: false },
    ]);

    expect(store.deleteBwaInstancePreservingWorkspace(instance.instanceIdHex)).toMatchObject({
      workspaceIdHex,
    });
    expect(store.getBwaApplication(application.applicationId).defaultInstanceIdHex).toBeNull();
    expect(() => store.listBwaEnvironment(instance.instanceIdHex)).toThrowError(
      expect.objectContaining({ code: "INSTANCE_NOT_FOUND" }) as RefStoreError,
    );
    expect(() => store.deleteBwaApplication(application.applicationId)).not.toThrow();
    expect(() => store.getBwaApplication(application.applicationId)).toThrowError(
      expect.objectContaining({ code: "APPLICATION_NOT_FOUND" }) as RefStoreError,
    );
    expect(() => store.deleteWorkspace(workspaceIdHex)).not.toThrow();
    store.close();
  });

  it("rejects unsafe BWA metadata and environment variables before persistence", async () => {
    const path = await databasePath();
    const store = await SqliteRefStore.initialize(path);
    store.createRef(initial);
    store.createWorkspace(workspaceInput());
    expect(() =>
      store.createBwaApplication({
        ...bwaApplication(),
        sourceUrl: "http://example.test/source",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REF_VALUE" }) as RefStoreError);
    store.createBwaApplication(bwaApplication());
    store.createBwaInstance(bwaInstance());
    for (const variables of [
      [{ name: "BIUNIVERS_HTTP_PORT", value: "9", sensitive: false }],
      [{ name: "TOKEN", value: "visible", sensitive: true }],
      [
        { name: "DUP", value: "one", sensitive: false },
        { name: "DUP", value: "two", sensitive: false },
      ],
    ]) {
      expect(() => store.replaceBwaEnvironment(bwaInstance().instanceIdHex, variables)).toThrowError(
        expect.objectContaining({ code: "INVALID_REF_VALUE" }) as RefStoreError,
      );
    }
    store.close();
  });

  it("atomically binds BWA Runs to Instance and digest while unresolved state blocks another Run", async () => {
    const path = await databasePath();
    const store = await SqliteRefStore.initialize(path);
    store.createRef(initial);
    store.createWorkspace(workspaceInput());
    store.createBwaApplication(bwaApplication());
    const instance = store.createBwaInstance(bwaInstance());
    const runIdHex = "63636363636363636363636363636363";
    const created = store.createBwaWorkspaceRun({
      runIdHex,
      instanceIdHex: instance.instanceIdHex,
      createdAtMs: instance.createdAtMs + 1,
    });
    expect(created.run).toMatchObject({
      runIdHex,
      workspaceIdHex,
      executorId: "bwa.workspace-application.v1",
      state: "PREPARING",
    });
    expect(created.binding).toEqual({
      runIdHex,
      instanceIdHex: instance.instanceIdHex,
      executorDigest: bwaApplication().installedDigest,
      stopReason: null,
      createdAtMs: instance.createdAtMs + 1,
    });
    expect(store.getBwaInstance(instance.instanceIdHex).desiredState).toBe("RUNNING");
    expect(store.getWorkspace(workspaceIdHex).activeWriteRunIdHex).toBe(runIdHex);
    expect(store.setBwaRunStopReason(runIdHex, "USER_STOP").stopReason).toBe(
      "USER_STOP",
    );
    expect(() => store.setBwaRunStopReason(runIdHex, "SAVE_RESTART")).toThrowError(
      expect.objectContaining({ code: "RUN_STATE_CONFLICT" }) as RefStoreError,
    );
    expect(() =>
      store.createBwaWorkspaceRun({
        runIdHex: "64646464646464646464646464646464",
        instanceIdHex: instance.instanceIdHex,
        createdAtMs: instance.createdAtMs + 2,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "INSTANCE_RUN_BLOCKED" }) as RefStoreError,
    );
    store.transitionWorkspaceRun({
      runIdHex,
      expectedState: "PREPARING",
      newState: "FAILED",
      errorCode: "START_FAILED",
      timestampMs: instance.createdAtMs + 3,
    });
    const failure = store.setBwaStartupFailure({
      runIdHex,
      stage: "APPLICATION_START",
      exitCode: 1,
      summary: "Required configuration is missing.",
      logTail: "BWA_STARTUP_ERROR: Required configuration is missing.",
      failedAtMs: instance.createdAtMs + 3,
    });
    expect(store.getBwaStartupFailure(runIdHex)).toEqual(failure);
    expect(store.getWorkspace(workspaceIdHex).activeWriteRunIdHex).toBeNull();
    expect(() =>
      store.createBwaWorkspaceRun({
        runIdHex: "65656565656565656565656565656565",
        instanceIdHex: instance.instanceIdHex,
        createdAtMs: instance.createdAtMs + 4,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "INSTANCE_RUN_BLOCKED" }) as RefStoreError,
    );
    expect(store.listBwaRunBindings(instance.instanceIdHex)).toHaveLength(1);
    store.close();
  });

  it("rolls back the Workspace Ref when publication conflicts or insertion fails", async () => {
    const path = await databasePath();
    const store = await SqliteRefStore.initialize(path);
    store.createRef(initial);
    const input = workspaceInput();

    expect(() =>
      store.createWorkspace({
        ...input,
        sourceHeadFidHex: "60606060606060606060606060606060",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "REF_CONFLICT" }) as RefStoreError,
    );
    expect(store.listRefs()).toEqual([initial]);

    store.createWorkspace(input);
    expect(() => store.createWorkspace(input)).toThrowError(
      expect.objectContaining({ code: "REF_ALREADY_EXISTS" }) as RefStoreError,
    );
    expect(store.listWorkspaces()).toHaveLength(1);
    expect(store.listRefs()).toHaveLength(2);
    store.close();
  });

  it("validates Workspace identity, naming, baseline, and timestamps before writing", async () => {
    const path = await databasePath();
    const store = await SqliteRefStore.initialize(path);
    store.createRef(initial);
    const invalidInputs: CreateWorkspaceInput[] = [
      workspaceInput({ name: "e\u0301" }),
      workspaceInput({ name: " " }),
      workspaceInput({ refId: "ws-not-derived" }),
      workspaceInput({
        baselineHeadFidHex: "80808080808080808080808080808080",
      }),
      workspaceInput({ updatedAtMs: initial.updatedAtMs }),
    ];
    for (const input of invalidInputs) {
      expect(() => store.createWorkspace(input)).toThrowError(
        expect.objectContaining({ code: "INVALID_REF_VALUE" }) as RefStoreError,
      );
    }
    expect(store.listWorkspaces()).toEqual([]);
    expect(store.listRefs()).toEqual([initial]);
    store.close();
  });

  it("holds one write lease through RUNNING, STOPPED, and COMMITTING", async () => {
    const path = await databasePath();
    const store = await SqliteRefStore.initialize(path);
    store.createRef(initial);
    const workspace = store.createWorkspace(workspaceInput());
    const firstRunId = "90909090909090909090909090909090";
    const created = store.createWorkspaceRun({
      runIdHex: firstRunId,
      workspaceIdHex,
      executorId: "system.diagnostic",
      inputHeadFidHex: workspace.baselineHeadFidHex,
      createdAtMs: workspace.createdAtMs + 1,
    });
    expect(created.state).toBe("PREPARING");
    expect(store.getWorkspace(workspaceIdHex).activeWriteRunIdHex).toBe(
      firstRunId,
    );
    expect(() =>
      store.createWorkspaceRun({
        runIdHex: "91919191919191919191919191919191",
        workspaceIdHex,
        executorId: "system.diagnostic",
        inputHeadFidHex: workspace.baselineHeadFidHex,
        createdAtMs: workspace.createdAtMs + 2,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "WORKSPACE_ACTIVE" }) as RefStoreError,
    );
    expect(() => store.deleteWorkspace(workspaceIdHex)).toThrowError(
      expect.objectContaining({ code: "WORKSPACE_ACTIVE" }) as RefStoreError,
    );

    const running = store.transitionWorkspaceRun({
      runIdHex: firstRunId,
      expectedState: "PREPARING",
      newState: "RUNNING",
      runtimeIdentity: "container-1",
      timestampMs: workspace.createdAtMs + 3,
    });
    expect(running).toMatchObject({
      state: "RUNNING",
      runtimeIdentity: "container-1",
      startedAtMs: workspace.createdAtMs + 3,
      finishedAtMs: null,
    });
    expect(
      store.transitionWorkspaceRun({
        runIdHex: firstRunId,
        expectedState: "RUNNING",
        newState: "STOPPED",
        timestampMs: workspace.createdAtMs + 4,
      }).state,
    ).toBe("STOPPED");
    expect(
      store.transitionWorkspaceRun({
        runIdHex: firstRunId,
        expectedState: "STOPPED",
        newState: "COMMITTING",
        timestampMs: workspace.createdAtMs + 5,
      }).state,
    ).toBe("COMMITTING");
    expect(store.getWorkspace(workspaceIdHex).activeWriteRunIdHex).toBe(
      firstRunId,
    );

    const conflict = store.transitionWorkspaceRun({
      runIdHex: firstRunId,
      expectedState: "COMMITTING",
      newState: "CONFLICT",
      outputHeadFidHex: "92929292929292929292929292929292",
      errorCode: "REF_CONFLICT",
      timestampMs: workspace.createdAtMs + 6,
    });
    expect(conflict).toMatchObject({
      state: "CONFLICT",
      outputHeadFidHex: "92929292929292929292929292929292",
      errorCode: "REF_CONFLICT",
      finishedAtMs: workspace.createdAtMs + 6,
    });
    expect(store.getWorkspace(workspaceIdHex).activeWriteRunIdHex).toBeNull();
    expect(store.listWorkspaceRuns(workspaceIdHex)).toEqual([conflict]);

    const second = store.createWorkspaceRun({
      runIdHex: "93939393939393939393939393939393",
      workspaceIdHex,
      executorId: "system.diagnostic",
      inputHeadFidHex: workspace.baselineHeadFidHex,
      createdAtMs: workspace.createdAtMs + 7,
    });
    expect(second.state).toBe("PREPARING");
    store.close();
  });

  it("rejects stale, illegal, or incomplete Run transitions without releasing the lease", async () => {
    const path = await databasePath();
    const store = await SqliteRefStore.initialize(path);
    store.createRef(initial);
    const workspace = store.createWorkspace(workspaceInput());
    const runIdHex = "94949494949494949494949494949494";
    store.createWorkspaceRun({
      runIdHex,
      workspaceIdHex,
      executorId: "system.diagnostic",
      inputHeadFidHex: workspace.baselineHeadFidHex,
      createdAtMs: workspace.createdAtMs + 5,
    });

    expect(() =>
      store.transitionWorkspaceRun({
        runIdHex,
        expectedState: "PREPARING",
        newState: "STOPPED",
        timestampMs: workspace.createdAtMs + 6,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_REF_VALUE" }) as RefStoreError,
    );
    expect(() =>
      store.transitionWorkspaceRun({
        runIdHex,
        expectedState: "PREPARING",
        newState: "RUNNING",
        timestampMs: workspace.createdAtMs + 6,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_REF_VALUE" }) as RefStoreError,
    );
    expect(() =>
      store.transitionWorkspaceRun({
        runIdHex,
        expectedState: "PREPARING",
        newState: "FAILED",
        errorCode: "PREPARE_FAILED",
        timestampMs: workspace.createdAtMs,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_REF_VALUE" }) as RefStoreError,
    );
    expect(store.getWorkspaceRun(runIdHex).state).toBe("PREPARING");
    expect(store.getWorkspace(workspaceIdHex).activeWriteRunIdHex).toBe(
      runIdHex,
    );

    const failed = store.transitionWorkspaceRun({
      runIdHex,
      expectedState: "PREPARING",
      newState: "FAILED",
      errorCode: "PREPARE_FAILED",
      timestampMs: workspace.createdAtMs + 7,
    });
    expect(failed.state).toBe("FAILED");
    expect(store.getWorkspace(workspaceIdHex).activeWriteRunIdHex).toBeNull();
    expect(() =>
      store.transitionWorkspaceRun({
        runIdHex,
        expectedState: "PREPARING",
        newState: "RUNNING",
        runtimeIdentity: "container-late",
        timestampMs: workspace.createdAtMs + 8,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "RUN_STATE_CONFLICT" }) as RefStoreError,
    );
    store.close();
  });

  it("rejects a Run whose input Head is not the current Workspace Ref", async () => {
    const path = await databasePath();
    const store = await SqliteRefStore.initialize(path);
    store.createRef(initial);
    store.createWorkspace(workspaceInput());

    expect(() =>
      store.createWorkspaceRun({
        runIdHex: "95959595959595959595959595959595",
        workspaceIdHex,
        executorId: "system.diagnostic",
        inputHeadFidHex: "96969696969696969696969696969696",
        createdAtMs: initial.updatedAtMs + 2,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "REF_CONFLICT" }) as RefStoreError,
    );
    expect(store.listWorkspaceRuns(workspaceIdHex)).toEqual([]);
    expect(store.getWorkspace(workspaceIdHex).activeWriteRunIdHex).toBeNull();
    store.close();
  });

  it("atomically publishes a committed Run with its Workspace Ref and lease release", async () => {
    const path = await databasePath();
    const store = await SqliteRefStore.initialize(path);
    store.createRef(initial);
    const workspace = store.createWorkspace(workspaceInput());
    const runIdHex = "97979797979797979797979797979797";
    prepareCommittingRun(store, workspace, runIdHex);

    const result = store.commitWorkspaceRun({
      runIdHex,
      expectedHeadFidHex: workspace.baselineHeadFidHex,
      expectedRevision: 0,
      newHeadFidHex: "98989898989898989898989898989898",
      newRevision: 1,
      timestampMs: workspace.createdAtMs + 10,
    });
    expect(result).toMatchObject({
      outcome: "committed",
      run: {
        state: "COMMITTED",
        outputHeadFidHex: "98989898989898989898989898989898",
        errorCode: null,
      },
      ref: {
        revision: 1,
        headFidHex: "98989898989898989898989898989898",
      },
    });
    expect(store.getWorkspace(workspaceIdHex).activeWriteRunIdHex).toBeNull();
    store.close();
  });

  it("atomically completes an unchanged Run without advancing its Workspace Ref", async () => {
    const path = await databasePath();
    const store = await SqliteRefStore.initialize(path);
    store.createRef(initial);
    const workspace = store.createWorkspace(workspaceInput());
    const runIdHex = "a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2";
    prepareCommittingRun(store, workspace, runIdHex);
    const before = store.getRef(workspace.refId);

    const result = store.completeUnchangedWorkspaceRun({
      runIdHex,
      expectedHeadFidHex: before.headFidHex,
      expectedRevision: before.revision,
      timestampMs: workspace.createdAtMs + 10,
    });

    expect(result).toMatchObject({
      outcome: "committed",
      run: {
        state: "COMMITTED",
        outputHeadFidHex: before.headFidHex,
        errorCode: null,
      },
      ref: before,
    });
    expect(store.getRef(workspace.refId)).toEqual(before);
    expect(store.getWorkspace(workspaceIdHex).activeWriteRunIdHex).toBeNull();
    store.close();
  });

  it("records a lost Ref CAS as CONFLICT without overwriting the winner", async () => {
    const path = await databasePath();
    const store = await SqliteRefStore.initialize(path);
    store.createRef(initial);
    const workspace = store.createWorkspace(workspaceInput());
    const runIdHex = "99999999999999999999999999999999";
    prepareCommittingRun(store, workspace, runIdHex);
    const winnerHead = "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0";
    store.compareAndSwap({
      refId: workspace.refId,
      expectedHeadFidHex: workspace.baselineHeadFidHex,
      expectedRevision: 0,
      newHeadFidHex: winnerHead,
      newRevision: 1,
      updatedAtMs: workspace.createdAtMs + 9,
    });

    const result = store.commitWorkspaceRun({
      runIdHex,
      expectedHeadFidHex: workspace.baselineHeadFidHex,
      expectedRevision: 0,
      newHeadFidHex: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
      newRevision: 1,
      timestampMs: workspace.createdAtMs + 10,
    });
    expect(result).toMatchObject({
      outcome: "conflict",
      run: {
        state: "CONFLICT",
        outputHeadFidHex: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
        errorCode: "REF_CONFLICT",
      },
      ref: { headFidHex: winnerHead, revision: 1 },
    });
    expect(store.getWorkspace(workspaceIdHex).activeWriteRunIdHex).toBeNull();
    expect(store.listAllProtectedHeadFids()).toEqual(
      [
        initial.headFidHex,
        workspace.baselineHeadFidHex,
        winnerHead,
        "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
      ].sort(),
    );
    store.close();
  });

  it("publishes a fully initialized genesis database in one create-only step", async () => {
    const path = await databasePath();
    const store = await SqliteRefStore.initializeWithRef(path, initial);
    expect(store.getRef("main")).toEqual(initial);
    store.close();

    await expect(
      SqliteRefStore.initializeWithRef(path, {
        ...initial,
        headFidHex: "30303030303030303030303030303030",
      }),
    ).rejects.toMatchObject({ code: "REF_ALREADY_EXISTS" });
    const reopened = await SqliteRefStore.openExisting(path);
    expect(reopened.getRef("main")).toEqual(initial);
    reopened.close();
  });

  it("publishes with exact head and revision CAS and never overwrites a winner", async () => {
    const path = await databasePath();
    const store = await SqliteRefStore.initialize(path);
    store.createRef(initial);
    const winner = {
      refId: "main",
      expectedHeadFidHex: initial.headFidHex,
      expectedRevision: 0,
      newHeadFidHex: "30303030303030303030303030303030",
      newRevision: 1,
      updatedAtMs: initial.updatedAtMs + 1,
    };

    expect(store.compareAndSwap(winner)).toMatchObject({
      headFidHex: winner.newHeadFidHex,
      revision: 1,
    });
    expect(() =>
      store.compareAndSwap({
        ...winner,
        newHeadFidHex: "40404040404040404040404040404040",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "REF_CONFLICT" }) as RefStoreError,
    );
    expect(store.getRef("main").headFidHex).toBe(winner.newHeadFidHex);
    store.close();
  });

  it("allows only one winner across independent database connections", async () => {
    const path = await databasePath();
    const first = await SqliteRefStore.initialize(path);
    first.createRef(initial);
    const second = await SqliteRefStore.openExisting(path);
    const candidate = {
      refId: "main",
      expectedHeadFidHex: initial.headFidHex,
      expectedRevision: 0,
      newHeadFidHex: "30303030303030303030303030303030",
      newRevision: 1,
      updatedAtMs: initial.updatedAtMs + 1,
    };

    expect(first.compareAndSwap(candidate).headFidHex).toBe(
      candidate.newHeadFidHex,
    );
    expect(() =>
      second.compareAndSwap({
        ...candidate,
        newHeadFidHex: "40404040404040404040404040404040",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "REF_CONFLICT" }) as RefStoreError,
    );
    expect(second.getRef("main").headFidHex).toBe(candidate.newHeadFidHex);
    second.close();
    first.close();
  });

  it("rejects revision gaps before entering the publication transaction", async () => {
    const path = await databasePath();
    const store = await SqliteRefStore.initialize(path);
    store.createRef(initial);

    expect(() =>
      store.compareAndSwap({
        refId: "main",
        expectedHeadFidHex: initial.headFidHex,
        expectedRevision: 0,
        newHeadFidHex: "30303030303030303030303030303030",
        newRevision: 2,
        updatedAtMs: initial.updatedAtMs + 1,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_REF_VALUE" }) as RefStoreError,
    );
    expect(store.getRef("main")).toEqual(initial);
    store.close();
  });

  it("only snapshots the current Ref value and enforces unique names", async () => {
    const path = await databasePath();
    const store = await SqliteRefStore.initialize(path);
    store.createRef(initial);
    const snapshot = store.createSnapshot({
      snapshotIdHex: "50505050505050505050505050505050",
      refId: "main",
      name: "before-edit",
      headFidHex: initial.headFidHex,
      revision: initial.revision,
      createdAtMs: initial.updatedAtMs,
      pinned: true,
    });

    expect(store.listSnapshots("main")).toEqual([snapshot]);
    expect(store.listProtectedHeadFids("main")).toEqual([
      initial.headFidHex,
      snapshot.headFidHex,
    ]);
    expect(() =>
      store.createSnapshot({
        ...snapshot,
        snapshotIdHex: "60606060606060606060606060606060",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "SNAPSHOT_ALREADY_EXISTS",
      }) as RefStoreError,
    );
    store.close();
  });

  it("creates a consistent validated backup that restores an earlier Ref", async () => {
    const path = await databasePath();
    const backupPath = join(join(path, ".."), "backups", "refstore.sqlite");
    const store = await SqliteRefStore.initialize(path);
    store.createRef(initial);
    await store.backupTo(backupPath);
    store.compareAndSwap({
      refId: "main",
      expectedHeadFidHex: initial.headFidHex,
      expectedRevision: 0,
      newHeadFidHex: "30303030303030303030303030303030",
      newRevision: 1,
      updatedAtMs: initial.updatedAtMs + 1,
    });
    store.close();

    const restored = await SqliteRefStore.openExisting(backupPath);
    expect(restored.getRef("main")).toEqual(initial);
    restored.close();
  });

  it("refuses a corrupt or unrelated database instead of silently recreating state", async () => {
    const path = await databasePath();
    await writeFile(path, "not a sqlite database");

    await expect(SqliteRefStore.openExisting(path)).rejects.toMatchObject({
      code: "REFSTORE_CORRUPT",
    });
  });
});

function createLegacySchemaV1(path: string): void {
  const database = new Database(path);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE filesystem_refs (
      ref_id TEXT PRIMARY KEY,
      lineage_id BLOB NOT NULL CHECK(length(lineage_id) = 16),
      head_fid BLOB NOT NULL CHECK(length(head_fid) = 16),
      revision INTEGER NOT NULL CHECK(revision >= 0),
      updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
    ) STRICT;
    CREATE TABLE filesystem_snapshots (
      snapshot_id BLOB PRIMARY KEY CHECK(length(snapshot_id) = 16),
      ref_id TEXT NOT NULL REFERENCES filesystem_refs(ref_id),
      name TEXT NOT NULL,
      head_fid BLOB NOT NULL CHECK(length(head_fid) = 16),
      revision INTEGER NOT NULL CHECK(revision >= 0),
      created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
      pinned INTEGER NOT NULL CHECK(pinned IN (0, 1)),
      UNIQUE(ref_id, name)
    ) STRICT;
    CREATE TABLE file_service_meta (
      key TEXT PRIMARY KEY,
      value BLOB NOT NULL
    ) STRICT;
    INSERT INTO file_service_meta(key, value)
    VALUES ('schema_version', X'00000001');
    INSERT INTO filesystem_refs
      (ref_id, lineage_id, head_fid, revision, updated_at_ms)
    VALUES (
      '${initial.refId}',
      X'${initial.lineageIdHex}',
      X'${initial.headFidHex}',
      ${initial.revision},
      ${initial.updatedAtMs}
    );
    PRAGMA user_version = 1;
  `);
  database.close();
}

function downgradeSchemaToV2(path: string): void {
  const database = new Database(path);
  database.pragma("foreign_keys = OFF");
  database.exec(`
    DROP TABLE bwa_application_environment;
    DROP TABLE bwa_startup_failures;
    DROP TABLE bwa_run_bindings;
    DROP TABLE bwa_environment;
    DROP TABLE bwa_instances;
    DROP TABLE bwa_applications;
    UPDATE file_service_meta SET value = X'00000002' WHERE key = 'schema_version';
    PRAGMA user_version = 2;
  `);
  database.close();
}

function downgradeSchemaToV3(path: string): void {
  const database = new Database(path);
  database.pragma("foreign_keys = OFF");
  database.exec(`
    DROP TABLE bwa_application_environment;
    DROP TABLE bwa_startup_failures;
    DROP TABLE bwa_run_bindings;
    UPDATE file_service_meta SET value = X'00000003' WHERE key = 'schema_version';
    PRAGMA user_version = 3;
  `);
  database.close();
}

function downgradeSchemaToV4(path: string): void {
  const database = new Database(path);
  database.pragma("foreign_keys = OFF");
  database.exec(`
    DROP TABLE bwa_application_environment;
    DROP TABLE bwa_startup_failures;
    UPDATE file_service_meta SET value = X'00000004' WHERE key = 'schema_version';
    PRAGMA user_version = 4;
  `);
  database.close();
}

function downgradeSchemaToV5(path: string): void {
  const database = new Database(path);
  database.pragma("foreign_keys = OFF");
  database.exec(`
    DROP TABLE bwa_application_environment;
    UPDATE file_service_meta SET value = X'00000005' WHERE key = 'schema_version';
    PRAGMA user_version = 5;
  `);
  database.close();
}

function bwaApplication() {
  return {
    applicationId: "ghcr.io/echo983/probe",
    installedDigest: `sha256:${"a".repeat(64)}`,
    previousDigest: null,
    protocolVersion: 1 as const,
    title: "Probe",
    description: "BWA registry probe",
    sourceUrl: "https://github.com/echo983/probe",
    imageVersion: "1.0.0",
    imageRevision: null,
    imageLicenses: "MIT",
    enabled: true,
    defaultInstanceIdHex: null,
    createdAtMs: initial.updatedAtMs + 2,
    updatedAtMs: initial.updatedAtMs + 2,
  };
}

function bwaInstance() {
  return {
    instanceIdHex: "61616161616161616161616161616161",
    applicationId: bwaApplication().applicationId,
    workspaceIdHex,
    desiredState: "STOPPED" as const,
    startupPolicy: "MANUAL" as const,
    displayName: "Probe state",
    createdAtMs: initial.updatedAtMs + 3,
    updatedAtMs: initial.updatedAtMs + 3,
  };
}

function prepareCommittingRun(
  store: SqliteRefStore,
  workspace: ReturnType<SqliteRefStore["getWorkspace"]>,
  runIdHex: string,
): void {
  store.createWorkspaceRun({
    runIdHex,
    workspaceIdHex: workspace.workspaceIdHex,
    executorId: "system.diagnostic",
    inputHeadFidHex: workspace.baselineHeadFidHex,
    createdAtMs: workspace.createdAtMs + 1,
  });
  store.transitionWorkspaceRun({
    runIdHex,
    expectedState: "PREPARING",
    newState: "RUNNING",
    runtimeIdentity: `container-${runIdHex.slice(0, 4)}`,
    timestampMs: workspace.createdAtMs + 2,
  });
  store.transitionWorkspaceRun({
    runIdHex,
    expectedState: "RUNNING",
    newState: "STOPPED",
    timestampMs: workspace.createdAtMs + 3,
  });
  store.transitionWorkspaceRun({
    runIdHex,
    expectedState: "STOPPED",
    newState: "COMMITTING",
    timestampMs: workspace.createdAtMs + 4,
  });
}

function readSchema(path: string): {
  version: number;
  workspaceTables: string[];
  bwaTables: string[];
} {
  const database = new Database(path, { readonly: true });
  try {
    return {
      version: database.pragma("user_version", { simple: true }) as number,
      workspaceTables: (
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name LIKE 'workspace_%'
             ORDER BY name`,
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
      bwaTables: (
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name LIKE 'bwa_%'
             ORDER BY name`,
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    };
  } finally {
    database.close();
  }
}
