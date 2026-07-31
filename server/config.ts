import { resolve } from "node:path";
import { isIP } from "node:net";

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
  fileService?: FileServiceConfig;
  bwaManager?: BwaManagerConfig;
}

export interface BwaManagerConfig {
  runtimeSocketPath: string;
  runtimeAuthenticationTokenHex: string;
  secretStorePath: string;
}

export interface FileServiceConfig {
  initialize: boolean;
  databasePath: string;
  endpoint: string;
  region: string;
  bucket: string;
  keyPrefix: string;
  namespace: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  writerId: string;
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

function parseAppBaseOrigin(value: string) {
  const origin = parseOrigin(value, "BIUNIVERS_APP_ORIGIN");
  const hostname = new URL(origin).hostname;
  if (hostname !== "localhost" && isIP(hostname) !== 0) {
    throw new Error(
      "BIUNIVERS_APP_ORIGIN 必须使用支持子域名的 DNS 名称或 localhost，不能使用 IP",
    );
  }
  return origin;
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

function parseBoolean(
  value: string | undefined,
  fallback: boolean,
  key: string,
) {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${key} 必须是 true 或 false`);
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
  const appOrigin = parseAppBaseOrigin(
    required(environment, "BIUNIVERS_APP_ORIGIN"),
  );

  if (desktopOrigin === appOrigin) {
    throw new Error("BIUNIVERS_DESKTOP_ORIGIN 和 BIUNIVERS_APP_ORIGIN 必须不同");
  }

  const dataDir = resolve(environment.BIUNIVERS_DATA_DIR?.trim() || "/data");
  const fileEnabled = parseBoolean(
    environment.BIUNIVERS_FILE_ENABLED,
    false,
    "BIUNIVERS_FILE_ENABLED",
  );
  const fileService = fileEnabled
    ? {
        initialize: parseBoolean(
          environment.BIUNIVERS_FILE_INITIALIZE,
          false,
          "BIUNIVERS_FILE_INITIALIZE",
        ),
        databasePath: resolve(dataDir, "file-service", "file-service.sqlite"),
        endpoint: parseOrigin(
          required(environment, "BIUNIVERS_FILE_S3_ENDPOINT"),
          "BIUNIVERS_FILE_S3_ENDPOINT",
        ),
        region: environment.BIUNIVERS_FILE_S3_REGION?.trim() || "auto",
        bucket: required(environment, "BIUNIVERS_FILE_S3_BUCKET"),
        keyPrefix:
          environment.BIUNIVERS_FILE_S3_PREFIX?.trim() || "biunivers-files",
        namespace: required(environment, "BIUNIVERS_FILE_NAMESPACE"),
        accessKeyId: required(
          environment,
          "BIUNIVERS_FILE_S3_ACCESS_KEY_ID",
        ),
        secretAccessKey: required(
          environment,
          "BIUNIVERS_FILE_S3_SECRET_ACCESS_KEY",
        ),
        forcePathStyle: parseBoolean(
          environment.BIUNIVERS_FILE_S3_FORCE_PATH_STYLE,
          true,
          "BIUNIVERS_FILE_S3_FORCE_PATH_STYLE",
        ),
        writerId:
          environment.BIUNIVERS_FILE_WRITER_ID?.trim() || "biunivers-host",
      }
    : undefined;
  const bwaEnabled = parseBoolean(
    environment.BIUNIVERS_BWA_ENABLED,
    false,
    "BIUNIVERS_BWA_ENABLED",
  );
  if (bwaEnabled && !fileEnabled) {
    throw new Error("BIUNIVERS_BWA_ENABLED 需要启用 File Service");
  }
  const runtimeAuthenticationTokenHex =
    environment.BIUNIVERS_RUNTIME_AUTH_TOKEN?.trim() ?? "";
  if (bwaEnabled && !/^[0-9a-f]{64}$/.test(runtimeAuthenticationTokenHex)) {
    throw new Error("BIUNIVERS_RUNTIME_AUTH_TOKEN 必须是 64 位小写十六进制值");
  }
  const bwaManager = bwaEnabled
    ? {
        runtimeSocketPath: absoluteFile(
          environment.BIUNIVERS_RUNTIME_SOCKET?.trim() ||
            resolve(dataDir, "compute-runtime", "runtime.sock"),
          "BIUNIVERS_RUNTIME_SOCKET",
        ),
        runtimeAuthenticationTokenHex,
        secretStorePath: resolve(dataDir, "private", "bwa-secrets.json"),
      }
    : undefined;

  return {
    adminToken,
    dataDir,
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
    fileService,
    bwaManager,
  };
}

function absoluteFile(value: string, key: string): string {
  const path = resolve(value);
  if (!value.startsWith("/") || path !== value || path === "/") {
    throw new Error(`${key} 必须是绝对、规范化的文件路径`);
  }
  return path;
}
