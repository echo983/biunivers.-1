import type { AppDefinition } from "../types/desktop";
import { defaultApps } from "../store/defaults";

export function mergeAppSources(
  legacyApps: AppDefinition[],
  managedApps: AppDefinition[],
  warnings: string[],
) {
  const registry = new Map(defaultApps.map((app) => [app.id, app]));

  const addSource = (apps: AppDefinition[], source: string) => {
    for (const app of apps) {
      if (registry.has(app.id)) {
        warnings.push(
          `${source}应用“${app.id}”与已有应用 ID 冲突，已跳过`,
        );
        continue;
      }
      registry.set(app.id, app);
    }
  };

  addSource(legacyApps, "传统配置");
  addSource(managedApps, "已安装");

  return [...registry.values()];
}
