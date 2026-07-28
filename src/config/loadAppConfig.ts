import { validateAppConfig } from "./validateAppConfig";

export interface AppSourceLoadResult {
  status: "ready" | "error";
  apps: ReturnType<typeof validateAppConfig>["apps"];
  warnings: string[];
  error?: string;
}

async function loadAndValidate(url: string, label: string) {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`请求失败：HTTP ${response.status}`);
    }

    const value: unknown = await response.json();
    const validation = validateAppConfig(value);
    if (validation.fatalError) {
      return {
        status: "error" as const,
        apps: [],
        warnings: [],
        error: `${label}：${validation.fatalError}`,
      };
    }

    return {
      status: "ready" as const,
      apps: validation.apps,
      warnings: validation.warnings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    console.error(`Failed to load ${label}`, error);
    return {
      status: "error" as const,
      apps: [],
      warnings: [],
      error: `无法加载${label}：${message}`,
    };
  }
}

export function loadLegacyAppConfig(): Promise<AppSourceLoadResult> {
  return loadAndValidate("/config/apps.json", "传统应用配置");
}

export async function loadManagedAppConfig(): Promise<AppSourceLoadResult> {
  try {
    const response = await fetch("/api/v1/apps", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`请求失败：HTTP ${response.status}`);
    }

    const value: unknown = await response.json();
    if (
      typeof value !== "object" ||
      value === null ||
      !("apps" in value)
    ) {
      throw new Error("响应缺少 apps 数组");
    }

    const validation = validateAppConfig(value.apps);
    if (validation.fatalError) {
      throw new Error(validation.fatalError);
    }

    return {
      status: "ready",
      apps: validation.apps,
      warnings: validation.warnings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    console.error("Failed to load managed applications", error);
    return {
      status: "error",
      apps: [],
      warnings: [],
      error: `无法加载已安装应用：${message}`,
    };
  }
}
