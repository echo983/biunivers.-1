import { resolve } from "node:path";

export interface ServerConfig {
  adminToken: string;
  dataDir: string;
  desktopPort: number;
  appPort: number;
  desktopOrigin: string;
  appOrigin: string;
  githubToken?: string;
  maxAppBytes: number;
  maxAppFiles: number;
}

type Environment = Record<string, string | undefined>;

function required(environment: Environment, key: string) {
  const value = environment[key]?.trim();
  if (!value) {
    throw new Error(`缺少必需环境变量 ${key}`);
  }
  return value;
}

function parsePort(value: string | undefined, fallback: number, key: string) {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${key} 必须是 1 到 65535 的整数`);
  }
  return port;
}

function parseOrigin(value: string, key: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} 必须是有效的 HTTP(S) origin`);
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${key} 必须是无路径、凭据、查询或片段的 HTTP(S) origin`);
  }

  return url.origin;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  key: string,
) {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new Error(`${key} 必须是正整数`);
  }
  return result;
}

export function loadServerConfig(
  environment: Environment = process.env,
): ServerConfig {
  const adminToken = required(environment, "BIUNIVERS_ADMIN_TOKEN");
  if (adminToken === "replace-me" || adminToken.length < 16) {
    throw new Error(
      "BIUNIVERS_ADMIN_TOKEN 不能使用示例值且长度至少为 16 个字符",
    );
  }

  const desktopOrigin = parseOrigin(
    required(environment, "BIUNIVERS_DESKTOP_ORIGIN"),
    "BIUNIVERS_DESKTOP_ORIGIN",
  );
  const appOrigin = parseOrigin(
    required(environment, "BIUNIVERS_APP_ORIGIN"),
    "BIUNIVERS_APP_ORIGIN",
  );

  if (desktopOrigin === appOrigin) {
    throw new Error("BIUNIVERS_DESKTOP_ORIGIN 和 BIUNIVERS_APP_ORIGIN 必须不同");
  }

  return {
    adminToken,
    dataDir: resolve(environment.BIUNIVERS_DATA_DIR?.trim() || "/data"),
    desktopPort: parsePort(
      environment.BIUNIVERS_DESKTOP_PORT,
      8080,
      "BIUNIVERS_DESKTOP_PORT",
    ),
    appPort: parsePort(
      environment.BIUNIVERS_APP_PORT,
      8081,
      "BIUNIVERS_APP_PORT",
    ),
    desktopOrigin,
    appOrigin,
    githubToken: environment.BIUNIVERS_GITHUB_TOKEN?.trim() || undefined,
    maxAppBytes: parsePositiveInteger(
      environment.BIUNIVERS_MAX_APP_BYTES,
      100 * 1024 * 1024,
      "BIUNIVERS_MAX_APP_BYTES",
    ),
    maxAppFiles: parsePositiveInteger(
      environment.BIUNIVERS_MAX_APP_FILES,
      5_000,
      "BIUNIVERS_MAX_APP_FILES",
    ),
  };
}
