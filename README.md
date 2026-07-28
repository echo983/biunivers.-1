# Biunivers 浏览器云端个人桌面

一个部署在个人 VPS 或家用服务器上的轻量浏览器桌面入口。V0.1 支持内建应用、iframe 自托管服务和新标签页外部应用；V0.2 正在增加第三方静态应用安装与管理能力。

## 项目状态

V0.1 已完成并归档，对应 `main` 历史基线提交：

```text
8586732 implement browser desktop V0.1
```

V0.2 正在 `agent/static-app-ecosystem-v0-2` 分支施工。需求、技术设计、施工计划和验收记录统一收录在 [`docs/`](docs/) 中。V0.1 文档作为已交付版本的历史基线冻结。

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
BIUNIVERS_ADMIN_TOKEN="请使用至少16字符的随机值" \
BIUNIVERS_DESKTOP_ORIGIN="http://localhost:8080" \
BIUNIVERS_APP_ORIGIN="http://localhost:8081" \
BIUNIVERS_DATA_DIR="./data" \
npm start
```

Desktop Origin 为 `http://localhost:8080`，第三方 App Origin 为 `http://localhost:8081`。V0.2 要求两者不同。

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

- `iframe`：在桌面窗口中打开可信 Web 服务，必须设置 `trusted: true`；
- `external`：通过用户点击在新标签页打开。

`internal` 只允许由源码中的编译期白名单注册，目前包含“设置”和“关于”；运行时 `apps.json` 不能创建或覆盖 internal 应用。

ID 只允许小写字母、数字、点和短横线。iframe 和 external URL 支持 `/` 开头的同源路径以及 HTTP(S) 地址。

无效条目会被跳过；其他有效应用继续加载。传统配置或 managed APP API 请求失败时，桌面保留其他可用来源，内建“设置”和“关于”始终存在。

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

V0.2 使用 Node.js 单容器提供桌面、管理 API 和第三方应用静态文件。构建并运行：

```bash
docker build -t biunivers:v0.2-dev .
docker run --rm \
  -p 8080:8080 \
  -p 8081:8081 \
  -e BIUNIVERS_ADMIN_TOKEN="请使用至少16字符的随机值" \
  -e BIUNIVERS_DESKTOP_ORIGIN="http://localhost:8080" \
  -e BIUNIVERS_APP_ORIGIN="http://localhost:8081" \
  -v biunivers-data:/data \
  --name biunivers \
  biunivers:v0.2-dev
```

桌面访问 `http://localhost:8080`。Desktop 和 App Origin 的健康检查地址均为 `/health`。

运行时替换应用配置：

```bash
docker run --rm \
  -p 8080:8080 \
  -p 8081:8081 \
  -e BIUNIVERS_ADMIN_TOKEN="请使用至少16字符的随机值" \
  -e BIUNIVERS_DESKTOP_ORIGIN="http://localhost:8080" \
  -e BIUNIVERS_APP_ORIGIN="http://localhost:8081" \
  -v "$PWD/apps.json:/app/dist/client/config/apps.json:ro" \
  -v biunivers-data:/data \
  --name biunivers \
  biunivers:v0.2-dev
```

也可复制 `compose.example.yml`，在同目录准备 `apps.json` 并设置管理员 token：

```bash
export BIUNIVERS_ADMIN_TOKEN="请使用至少16字符的随机值"
docker compose -f compose.example.yml up -d --build
```

## 本地状态

壁纸、固定应用、运行窗口、活动窗口和窗口边界保存在当前浏览器的 localStorage 中，key 为：

```text
biunivers.desktop.v1
```

设置应用可以分别恢复默认壁纸、默认固定应用、默认窗口状态，或确认后清除本产品的全部本地数据。项目不会调用 `localStorage.clear()`。

## 当前范围

V0.2 仍不提供账号、多用户、文件系统、应用商店、多桌面、Host API 或应用间资源交换。当前施工范围和进度参见 `docs` 目录。
