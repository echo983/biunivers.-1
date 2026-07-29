import type { AppStore } from "../apps/appStore.js";
import { projectInstalledApp } from "../apps/projection.js";
import type { EntryIndex } from "../files/entryIndex.js";
import {
  DesktopSurfaceError,
  DesktopSurfaceStore,
} from "./desktopSurfaceStore.js";
import type {
  DesktopItem,
  DesktopPosition,
  DesktopSurface,
  DesktopTarget,
  ResolvedDesktopItem,
} from "./types.js";

export interface InternalDesktopApp {
  id: string;
  name: string;
  icon?: string;
  desktop: boolean;
}

interface DesktopSurfaceServiceOptions {
  store: DesktopSurfaceStore;
  appStore: AppStore;
  appOrigin: string;
  internalApps: readonly InternalDesktopApp[];
  loadEntryIndex?: () => Promise<EntryIndex>;
}

export class DesktopSurfaceService {
  readonly #internalApps: Map<string, InternalDesktopApp>;

  constructor(readonly options: DesktopSurfaceServiceOptions) {
    this.#internalApps = new Map(
      options.internalApps.map((app) => [app.id, app]),
    );
  }

  async initialize() {
    const installed = await this.options.appStore.read();
    const targets: DesktopTarget[] = [
      ...this.options.internalApps
        .filter((app) => app.desktop)
        .map((app) => ({ type: "app" as const, handle: app.id })),
      ...installed.apps
        .filter(
          (app) =>
            app.status === "active" && (app.manifest.window.desktop ?? true),
        )
        .map((app) => ({ type: "app" as const, handle: app.appId })),
    ];
    return this.options.store.initialize(uniqueTargets(targets));
  }

  read() {
    return this.options.store.read();
  }

  async add(
    target: DesktopTarget,
    position: DesktopPosition,
    expectedRevision: number,
  ) {
    await this.#requireTarget(target);
    return this.options.store.add(target, position, expectedRevision);
  }

  move(
    moves: Array<{ itemId: string; position: DesktopPosition }>,
    expectedRevision: number,
  ) {
    return this.options.store.move(moves, expectedRevision);
  }

  remove(itemIds: string[], expectedRevision: number) {
    return this.options.store.remove(itemIds, expectedRevision);
  }

  async reset(expectedRevision: number) {
    const targets = this.options.internalApps
      .filter((app) => app.desktop)
      .map((app) => ({ type: "app" as const, handle: app.id }));
    return this.options.store.reset(targets, expectedRevision);
  }

  async resolve(surface: DesktopSurface = this.read()) {
    const [installed, entryIndex] = await Promise.all([
      this.options.appStore.read(),
      this.options.loadEntryIndex?.().catch(() => undefined),
    ]);
    const installedApps = new Map(
      installed.apps.map((app) => [app.appId, app]),
    );

    return {
      ...surface,
      items: surface.items.map((item): ResolvedDesktopItem => {
        if (item.target.type === "app") {
          const internal = this.#internalApps.get(item.target.handle);
          if (internal) {
            return {
              ...item,
              resolved: {
                available: true,
                kind: "app",
                name: internal.name,
                ...(internal.icon ? { icon: internal.icon } : {}),
              },
            };
          }
          const installedApp = installedApps.get(item.target.handle);
          if (!installedApp || installedApp.status !== "active") {
            return unavailable(item, "应用不存在或未启用");
          }
          const projected = projectInstalledApp(
            installedApp,
            this.options.appOrigin,
          );
          return {
            ...item,
            resolved: {
              available: true,
              kind: "app",
              name: projected.name,
              icon: projected.icon,
            },
          };
        }

        if (!entryIndex) {
          return unavailable(item, "文件服务当前不可用");
        }
        const entry = entryIndex.get(item.target.handle);
        if (!entry || entry.kind !== item.target.type) {
          return unavailable(item, "文件或目录不存在");
        }
        return {
          ...item,
          resolved: {
            available: true,
            kind: item.target.type,
            name: entry.name || "/",
            fileRevision: entryIndex.revision,
          },
        };
      }),
    };
  }

  async #requireTarget(target: DesktopTarget) {
    if (target.type === "app") {
      if (this.#internalApps.has(target.handle)) {
        return;
      }
      const state = await this.options.appStore.read();
      if (
        state.apps.some(
          (app) =>
            app.appId === target.handle && app.status === "active",
        )
      ) {
        return;
      }
      throw new DesktopSurfaceError(
        "DESKTOP_ITEM_NOT_FOUND",
        "应用不存在或未启用",
      );
    }
    if (!this.options.loadEntryIndex) {
      throw new DesktopSurfaceError(
        "DESKTOP_ITEM_NOT_FOUND",
        "文件服务当前不可用",
      );
    }
    const entry = (await this.options.loadEntryIndex()).get(target.handle);
    if (!entry || entry.kind !== target.type) {
      throw new DesktopSurfaceError(
        "DESKTOP_ITEM_NOT_FOUND",
        "文件或目录不存在",
      );
    }
  }
}

function unavailable(
  item: DesktopItem,
  reason: string,
): ResolvedDesktopItem {
  return {
    ...item,
    resolved: {
      available: false,
      kind: item.target.type,
      name: item.target.handle,
      reason,
    },
  };
}

function uniqueTargets(targets: DesktopTarget[]) {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.type}:${target.handle}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
