# Biunivers 浏览器云端个人桌面

一个部署在个人 VPS 或家用服务器上的轻量浏览器桌面入口。V0.1 面向单用户和可信应用，支持内建应用、iframe 自托管服务和新标签页外部应用。

## 项目状态

V0.1 已完成并归档，对应 `main` 基线提交：

```text
8586732 implement browser desktop V0.1
```

需求、技术设计、施工计划和验收记录统一收录在 [`docs/`](docs/) 中。V0.1 文档作为已交付版本的历史基线冻结；新功能应在新的版本需求或变更文档中描述。

## 环境要求

- Node.js 20.19 或更新的兼容版本；
- npm 9 或更新版本；
- 当前稳定版 Chrome、Chromium 或 Edge；
- Docker 部署可选。

## 本地运行

```bash
npm install
npm run dev
```

生产构建和预览：

```bash
npm run build
npm run preview
```

质量检查：

```bash
npm run lint
npm run test
npm run test:e2e
npm audit
```

E2E 默认使用系统安装的 Google Chrome。

## 应用配置

应用注册表位于 `public/config/apps.json`，部署后对应：

```text
/config/apps.json
```

该文件在页面启动时读取，不编译进 JavaScript，因此部署时可以直接替换。支持的类型：

- `internal`：内建 React 应用，目前支持 `about` 和 `settings`；
- `iframe`：在桌面窗口中打开可信 Web 服务，必须设置 `trusted: true`；
- `external`：通过用户点击在新标签页打开。

ID 只允许小写字母、数字、点和短横线。iframe 和 external URL 支持 `/` 开头的同源路径以及 HTTP(S) 地址。

无效条目会被跳过；其他有效应用继续加载。整个配置请求失败时，桌面仍提供内建“设置”和“关于”应用。

## iframe 与反向代理

推荐把自托管应用代理到桌面同一域名：

```text
https://desktop.example.com/services/files/
https://desktop.example.com/services/transmission/
```

目标服务必须允许 iframe 嵌入。请检查：

- `Content-Security-Policy` 的 `frame-ancestors`；
- `X-Frame-Options`；
- Cookie 的 `SameSite`、`Secure` 和域名；
- 反向代理是否正确转发 WebSocket、路径前缀和认证头。

浏览器无法可靠报告所有 iframe 拒绝加载情况，因此每个 iframe 窗口都提供“在新标签页打开”。

## Docker

构建并运行：

```bash
docker build -t biunivers:v0.1 .
docker run --rm -p 8080:80 --name biunivers biunivers:v0.1
```

访问 `http://localhost:8080`。健康检查地址为 `/health.txt`。

运行时替换应用配置：

```bash
docker run --rm -p 8080:80 \
  -v "$PWD/apps.json:/usr/share/nginx/html/config/apps.json:ro" \
  --name biunivers biunivers:v0.1
```

也可复制 `compose.example.yml`，在同目录准备 `apps.json` 后执行：

```bash
docker compose -f compose.example.yml up -d --build
```

## 本地状态

壁纸、固定应用、运行窗口、活动窗口和窗口边界保存在当前浏览器的 localStorage 中，key 为：

```text
biunivers.desktop.v1
```

设置应用可以分别恢复默认壁纸、默认固定应用、默认窗口状态，或确认后清除本产品的全部本地数据。项目不会调用 `localStorage.clear()`。

## 当前范围

V0.1 不提供账号、多用户、服务端状态同步、文件系统、应用商店、多桌面、移动端窗口模式或任意第三方 URL 安装能力。详细范围与设计参见 `docs` 目录。
