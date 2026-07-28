import type { AppDefinition } from "../types/desktop";
import { defaultApps } from "../store/defaults";

export function mergeWithBuiltInApps(
  configuredApps: AppDefinition[],
  warnings: string[],
) {
  const registry = new Map(defaultApps.map((app) => [app.id, app]));
  const builtIns = new Map(defaultApps.map((app) => [app.id, app]));

  for (const app of configuredApps) {
    const builtIn = builtIns.get(app.id);
    if (
      builtIn &&
      (app.kind !== "internal" ||
        app.internalComponent !== builtIn.internalComponent)
    ) {
      warnings.push(
        `应用 “${app.id}” 不能改变内建应用类型或组件，已保留内建定义`,
      );
      continue;
    }
    registry.set(app.id, builtIn ? { ...builtIn, ...app } : app);
  }

  return [...registry.values()];
}
