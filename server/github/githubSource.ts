import { open, mkdir, unlink } from "node:fs/promises";
import { join, posix } from "node:path";
import * as tar from "tar";

const GITHUB_HOSTS = new Set([
  "github.com",
  "api.github.com",
  "codeload.github.com",
]);

export interface GitHubRepository {
  repository: string;
  owner: string;
  name: string;
}

export interface PreparedRepository extends GitHubRepository {
  requestedRef: string;
  commitSha: string;
  rootDir: string;
}

export interface RepositorySource {
  prepare(
    repositoryInput: string,
    requestedRef: string,
    stagingDir: string,
  ): Promise<PreparedRepository>;
}

export interface GitHubSourceOptions {
  token?: string;
  maxArchiveBytes: number;
  maxAppBytes: number;
  maxAppFiles: number;
}

export function parseGitHubRepository(value: string): GitHubRepository {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("仓库地址必须是有效的 GitHub HTTPS URL");
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("仓库地址必须是 github.com 上的公开 HTTPS 仓库");
  }

  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  if (segments.length !== 2) {
    throw new Error("仓库地址必须是 https://github.com/<owner>/<repo>");
  }

  const owner = segments[0].toLowerCase();
  const name = segments[1].replace(/\.git$/i, "").toLowerCase();
  const namePattern = /^[a-z0-9_.-]+$/;
  if (!name || !namePattern.test(owner) || !namePattern.test(name)) {
    throw new Error("GitHub owner 或仓库名称无效");
  }

  return {
    repository: `https://github.com/${owner}/${name}`,
    owner,
    name,
  };
}

function safeRedirect(current: URL, location: string) {
  const next = new URL(location, current);
  if (next.protocol !== "https:" || !GITHUB_HOSTS.has(next.hostname)) {
    throw new Error("GitHub 下载被重定向到不允许的地址");
  }
  return next;
}

export class GitHubSource implements RepositorySource {
  constructor(private readonly options: GitHubSourceOptions) {}

  private headers(url: URL) {
    return {
      Accept: "application/vnd.github+json",
      "User-Agent": "biunivers-v0.2",
      ...(this.options.token && url.hostname === "api.github.com"
        ? { Authorization: `Bearer ${this.options.token}` }
        : {}),
    };
  }

  private async fetchGitHub(url: URL) {
    let current = url;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const response = await fetch(current, {
        headers: this.headers(current),
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new Error("GitHub 返回了没有 location 的重定向");
        }
        current = safeRedirect(current, location);
        continue;
      }
      return response;
    }
    throw new Error("GitHub 下载重定向次数过多");
  }

  async prepare(
    repositoryInput: string,
    requestedRef: string,
    stagingDir: string,
  ): Promise<PreparedRepository> {
    const repository = parseGitHubRepository(repositoryInput);
    const ref = requestedRef.trim();
    const containsControlCharacter = [...ref].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    });
    if (!ref || ref.length > 255 || containsControlCharacter) {
      throw new Error("Git ref 无效");
    }

    const commitResponse = await this.fetchGitHub(
      new URL(
        `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/commits/${encodeURIComponent(ref)}`,
      ),
    );
    if (!commitResponse.ok) {
      throw new Error(`无法解析 Git ref：GitHub HTTP ${commitResponse.status}`);
    }
    const commitValue = (await commitResponse.json()) as { sha?: unknown };
    if (
      typeof commitValue.sha !== "string" ||
      !/^[0-9a-f]{40}$/.test(commitValue.sha)
    ) {
      throw new Error("GitHub 没有返回有效的完整 commit SHA");
    }

    await mkdir(stagingDir, { recursive: true });
    const archivePath = join(stagingDir, "repository.tgz");
    const rootDir = join(stagingDir, "repository");
    await mkdir(rootDir, { recursive: true });

    const archiveResponse = await this.fetchGitHub(
      new URL(
        `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/tarball/${commitValue.sha}`,
      ),
    );
    if (!archiveResponse.ok || !archiveResponse.body) {
      throw new Error(`无法下载仓库：GitHub HTTP ${archiveResponse.status}`);
    }

    const declaredLength = Number(
      archiveResponse.headers.get("content-length") ?? "0",
    );
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > this.options.maxArchiveBytes
    ) {
      throw new Error("GitHub archive 超过下载大小限制");
    }

    const archiveHandle = await open(archivePath, "wx", 0o600);
    let downloaded = 0;
    try {
      const reader = archiveResponse.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        downloaded += value.byteLength;
        if (downloaded > this.options.maxArchiveBytes) {
          await reader.cancel();
          throw new Error("GitHub archive 超过下载大小限制");
        }
        await archiveHandle.write(value);
      }
      await archiveHandle.sync();
    } finally {
      await archiveHandle.close();
    }

    let files = 0;
    let extractedBytes = 0;
    await tar.x({
      file: archivePath,
      cwd: rootDir,
      strip: 1,
      strict: true,
      preservePaths: false,
      filter: (entryPath, entry) => {
        const stripped = entryPath.split("/").slice(1).join("/");
        if (!stripped) return false;
        const normalized = posix.normalize(stripped);
        if (
          normalized.startsWith("../") ||
          normalized === ".." ||
          posix.isAbsolute(normalized)
        ) {
          throw new Error("archive 包含越界路径");
        }
        const isFile =
          "type" in entry ? entry.type === "File" : entry.isFile();
        const isDirectory =
          "type" in entry
            ? entry.type === "Directory"
            : entry.isDirectory();
        if (!isFile && !isDirectory) {
          throw new Error("archive 包含链接或其他不支持的文件类型");
        }
        if (isFile) {
          files += 1;
          extractedBytes += entry.size;
          if (files > this.options.maxAppFiles) {
            throw new Error("应用文件数量超过限制");
          }
          if (extractedBytes > this.options.maxAppBytes) {
            throw new Error("应用解包大小超过限制");
          }
        }
        return true;
      },
    });
    await unlink(archivePath);

    return {
      ...repository,
      requestedRef: ref,
      commitSha: commitValue.sha,
      rootDir,
    };
  }
}
