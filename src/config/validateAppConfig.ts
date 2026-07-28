import type { AppDefinition, AppKind } from "../types/desktop";

const APP_ID_PATTERN = /^[a-z0-9.-]+$/;
const CONFIG_APP_KINDS = new Set<AppKind>(["iframe", "external"]);

export type AppValidationResult =
  | { ok: true; app: AppDefinition }
  | { ok: false; index: number; issues: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0
  );
}

function isSupportedUrl(value: string) {
  if (value.startsWith("/")) {
    return !value.startsWith("//");
  }

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function validateAppConfigEntry(
  value: unknown,
  index: number,
): AppValidationResult {
  if (!isRecord(value)) {
    return { ok: false, index, issues: ["必须是对象"] };
  }

  const issues: string[] = [];
  const id = value.id;
  const name = value.name;
  const icon = value.icon;
  const kind = value.kind;
  const defaultWidth = value.defaultWidth;
  const defaultHeight = value.defaultHeight;
  const minWidth = value.minWidth;
  const minHeight = value.minHeight;
  const desktop = value.desktop;
  const pinned = value.pinned;

  if (!isNonEmptyString(id) || !APP_ID_PATTERN.test(id)) {
    issues.push("id 必须只包含小写字母、数字、点和短横线");
  }
  if (!isNonEmptyString(name)) {
    issues.push("name 必须是非空字符串");
  }
  if (!isNonEmptyString(icon)) {
    issues.push("icon 必须是非空字符串");
  }
  if (typeof kind !== "string" || !CONFIG_APP_KINDS.has(kind as AppKind)) {
    issues.push("kind 必须是 iframe 或 external；internal 仅允许编译期注册");
  }
  if (!isPositiveNumber(defaultWidth)) {
    issues.push("defaultWidth 必须是正数");
  }
  if (!isPositiveNumber(defaultHeight)) {
    issues.push("defaultHeight 必须是正数");
  }
  if (minWidth !== undefined && !isPositiveNumber(minWidth)) {
    issues.push("minWidth 必须是正数");
  }
  if (minHeight !== undefined && !isPositiveNumber(minHeight)) {
    issues.push("minHeight 必须是正数");
  }
  if (
    isPositiveNumber(minWidth) &&
    isPositiveNumber(defaultWidth) &&
    minWidth > defaultWidth
  ) {
    issues.push("minWidth 不能大于 defaultWidth");
  }
  if (
    isPositiveNumber(minHeight) &&
    isPositiveNumber(defaultHeight) &&
    minHeight > defaultHeight
  ) {
    issues.push("minHeight 不能大于 defaultHeight");
  }
  if (typeof desktop !== "boolean") {
    issues.push("desktop 必须是 boolean");
  }
  if (typeof pinned !== "boolean") {
    issues.push("pinned 必须是 boolean");
  }

  if (kind === "iframe" || kind === "external") {
    if (!isNonEmptyString(value.url) || !isSupportedUrl(value.url)) {
      issues.push("url 必须是同源绝对路径或 HTTP(S) URL");
    }
  }

  if (kind === "iframe" && value.trusted !== true) {
    issues.push("iframe 应用必须显式设置 trusted: true");
  }

  if (issues.length > 0) {
    return { ok: false, index, issues };
  }

  return {
    ok: true,
    app: {
      id: id as string,
      name: name as string,
      kind: kind as AppKind,
      icon: icon as string,
      description: isNonEmptyString(value.description)
        ? value.description
        : undefined,
      url: isNonEmptyString(value.url) ? value.url : undefined,
      defaultWidth: defaultWidth as number,
      defaultHeight: defaultHeight as number,
      minWidth: isPositiveNumber(minWidth) ? minWidth : undefined,
      minHeight: isPositiveNumber(minHeight) ? minHeight : undefined,
      desktop: desktop as boolean,
      pinned: pinned as boolean,
      trusted: value.trusted === true ? true : undefined,
    },
  };
}

export function validateAppConfig(value: unknown) {
  if (!Array.isArray(value)) {
    return {
      fatalError: "apps.json 顶层必须是数组",
      apps: [] as AppDefinition[],
      warnings: [] as string[],
    };
  }

  const apps: AppDefinition[] = [];
  const warnings: string[] = [];
  const seenIds = new Set<string>();

  value.forEach((entry, index) => {
    const result = validateAppConfigEntry(entry, index);
    if (!result.ok) {
      warnings.push(`第 ${index + 1} 项：${result.issues.join("；")}`);
      return;
    }
    if (seenIds.has(result.app.id)) {
      warnings.push(`第 ${index + 1} 项：应用 ID “${result.app.id}” 重复，已跳过`);
      return;
    }
    seenIds.add(result.app.id);
    apps.push(result.app);
  });

  return { apps, warnings };
}
