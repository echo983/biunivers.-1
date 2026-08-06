# GitHub Stable Release

状态：V0.16 发布候选运行手册
日期：2026-08-06

## 发布入口

稳定版只由 `vMAJOR.MINOR.PATCH` tag 触发 `.github/workflows/release.yml`。tag 必须与
`package.json` 版本完全一致，并且指向当前 checkout 的精确 commit。流水线不读取 `main`、
`latest` 或其他浮动发布来源。

发布前在目标 commit 完成：

```bash
npm ci
npm run lint
npm test
npm run test:pvlog
npm run build
npm run test:debian-release
npm run test:debian-installer
npm run test:release-workflow
```

然后创建并推送 tag：

```bash
git tag -a v0.16.0 -m "Biunivers v0.16.0"
git push origin v0.16.0
```

## 流水线产物

流水线依次：

1. 构建并推送 `ghcr.io/<owner>/biunivers:v0.16.0`；
2. 构建并推送 `ghcr.io/<owner>/biunivers-runtime-diagnostic:v0.16.0`；
3. 取得两个 registry digest；
4. 在全新未登录 runner 中按 digest 匿名拉取两个镜像；
5. 在 `node:24-bookworm`（Debian 12）中构建 Runtime；
6. 把两个 digest 写入 `release.json`；
7. 生成 Runtime 压缩包、固定 tag 安装器和 `SHA256SUMS`；
8. 创建 GitHub stable Release。

GitHub Release 包含：

```text
biunivers-runtime-v0.16.0-linux-x64.tar.zst
biunivers-install-v0.16.0.sh
SHA256SUMS
```

Runtime 必须在 Debian 12 用户空间构建。GitHub 默认 Ubuntu 的 glibc 可能比 Debian 12 新，
不能用它直接产生声称兼容 Debian 12 的 Node 原生模块和 Rust 二进制。

## GHCR 首次发布

GHCR 新容器包可能默认为 private。流水线不会自动扩大包的可见性；仓库主人必须在 GitHub
Package settings 中把 Host 和诊断执行器两个包设为 public。匿名拉取门禁未通过时，不会继续
创建 GitHub Release。修改可见性后，可在 Actions 中重新运行失败的 workflow。

OCI 镜像带 `org.opencontainers.image.source`、version 和 revision label，用于关联源码。
正式运行不使用 tag，而使用 Release 固定的 digest。

## 用户验证和安装

用户应下载同一个固定 tag 的三个文件：

```bash
version=v0.16.0
base="https://github.com/echo983/biunivers.-1/releases/download/$version"
curl -fLO "$base/SHA256SUMS"
curl -fLO "$base/biunivers-install-$version.sh"
sha256sum --check --ignore-missing SHA256SUMS
sudo bash "biunivers-install-$version.sh" --version "$version" --env-file ./biunivers.env
```

安装器随后会自行下载并再次校验 Runtime 资产。`curl | sudo bash` 不是唯一或推荐路径；先下载、
检查固定 tag 的 checksum，再执行更容易审计和复现。

## 失败与重跑

- 任一镜像构建、匿名拉取、Debian Runtime 构建或 checksum 门禁失败，都不会创建 Release；
- Release 创建阶段重跑时，已有 tag 的资产使用 `--clobber` 更新，避免一次上传中断后永久卡住；
- 不得为了让发布变绿而删除 digest、切换到 floating tag 或跳过匿名拉取门禁；
- tag 已正式交付用户后，不应把不同源码重新发布到同名 tag，应增加 patch 版本。
