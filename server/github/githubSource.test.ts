// @vitest-environment node

import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitHubSource,
  GitHubSourceError,
  parseGitHubRepository,
} from "./githubSource.js";

const temporaryDirectories: string[] = [];
const sha = "0123456789abcdef0123456789abcdef01234567";

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("parseGitHubRepository", () => {
  it("normalizes a public GitHub repository URL", () => {
    expect(
      parseGitHubRepository("https://github.com/Example/Hello.git"),
    ).toEqual({
      repository: "https://github.com/example/hello",
      owner: "example",
      name: "hello",
    });
  });

  it.each([
    "http://github.com/example/hello",
    "https://example.com/example/hello",
    "https://github.com/example/hello/issues",
    "https://user:password@github.com/example/hello",
    "https://github.com/example/hello?download=1",
  ])("rejects unsupported repository URL %s", (url) => {
    expect(() => parseGitHubRepository(url)).toThrow();
  });

  it("resolves a ref, downloads a bounded archive and extracts its root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "biunivers-github-"));
    temporaryDirectories.push(directory);
    const archiveRoot = join(directory, `example-hello-${sha}`);
    await mkdir(archiveRoot);
    await writeFile(join(archiveRoot, "index.html"), "<h1>Hello</h1>");
    const archivePath = join(directory, "fixture.tgz");
    await tar.c(
      {
        cwd: directory,
        file: archivePath,
        gzip: true,
      },
      [`example-hello-${sha}`],
    );
    const archive = await readFile(archivePath);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/commits/")) {
          return Response.json({ sha });
        }
        return new Response(new Uint8Array(archive), { status: 200 });
      }),
    );

    const source = new GitHubSource({
      maxArchiveBytes: 1024 * 1024,
      maxAppBytes: 1024 * 1024,
      maxAppFiles: 10,
    });
    const prepared = await source.prepare(
      "https://github.com/example/hello",
      "v1.0.0",
      join(directory, "staging"),
    );

    expect(prepared.commitSha).toBe(sha);
    await expect(readFile(join(prepared.rootDir, "index.html"), "utf8"))
      .resolves.toContain("Hello");
  });

  it("classifies an unknown ref as a correctable repository error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    const source = new GitHubSource({
      maxArchiveBytes: 1024,
      maxAppBytes: 1024,
      maxAppFiles: 10,
    });

    await expect(
      source.prepare(
        "https://github.com/example/hello",
        "missing",
        join(tmpdir(), "unused-staging"),
      ),
    ).rejects.toMatchObject<Partial<GitHubSourceError>>({
      code: "GITHUB_REF_NOT_FOUND",
      status: 400,
      message: "无法解析 Git ref：GitHub HTTP 404",
    });
  });
});
