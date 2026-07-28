import { mergeWithBuiltInApps } from "../apps/registry";
import { defaultApps } from "../store/defaults";
import { validateAppConfig } from "./validateAppConfig";

export async function loadAppConfig() {
  try {
    const response = await fetch("/config/apps.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`请求失败：HTTP ${response.status}`);
    }

    const value: unknown = await response.json();
    const validation = validateAppConfig(value);
    if (validation.fatalError) {
      return {
        status: "error" as const,
        apps: defaultApps,
        warnings: [],
        error: validation.fatalError,
      };
    }

    const warnings = [...validation.warnings];
    return {
      status: "ready" as const,
      apps: mergeWithBuiltInApps(validation.apps, warnings),
      warnings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    console.error("Failed to load apps.json", error);
    return {
      status: "error" as const,
      apps: defaultApps,
      warnings: [],
      error: `无法加载应用配置：${message}`,
    };
  }
}
