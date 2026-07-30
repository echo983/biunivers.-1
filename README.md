# Biunivers 浏览器云端个人桌面

一个部署在个人 VPS 或家用服务器上的轻量浏览器桌面。当前版本 `v0.11.0` 已具备窗口与
自由布局桌面、第三方静态应用安装、不可变文件服务、文件管理器、资源关联打开、可续租
Resource Session、桌面快捷入口、原子批量文件操作和按需 WebDAV 文件交换。
文件管理器可把目录或多选项目导出为不压缩 ZIP；Wormhole 可供 rclone 和原生 WebDAV
客户端挂载或主动同步，但不承担实时同步。

## 项目状态

`v0.1.0` 至 `v0.10.0` 已按里程碑归档；`v0.11.0` Wormhole 正在进行合并前验收。
各版本需求、技术设计、施工计划和真实验收证据统一收录在 [`docs/`](docs/)。

当前定位是单用户、单实例的个人部署版本。公网使用时应在 Biunivers 前增加 VPN、
Cloudflare Access 或反向代理认证；管理员 token 只保护管理接口，不等同于桌面登录。

## 环境要求

- Node.js 24.x；
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

## 管理第三方应用

1. 打开内建“设置”应用；
2. 在“应用管理”中输入部署时设置的 `BIUNIVERS_ADMIN_TOKEN`；
3. 填写公开 GitHub 仓库 URL 和 branch、tag 或 commit；
4. 检查应用身份、许可证、固定 commit 和公开配置；
5. 确认安装。

管理员 token 只保存在当前设置窗口的内存中。安装配置会由 App Origin
发送给浏览器，因此不能填写密码、私钥或长期 token。

已安装应用可以在同一页面修改配置、更新、停用、启用和卸载。更新失败不会替换当前版本；
卸载会删除服务器端文件和配置，但不能保证清除第三方应用已经写入浏览器的站点数据。

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

`internal` 只允许由源码中的编译期白名单注册，目前包含“文件”、“设置”、“Wormhole”和
“关于”；运行时 `apps.json` 不能创建或覆盖 internal 应用。

ID 只允许小写字母、数字、点和短横线。iframe 和 external URL 支持 `/` 开头的同源路径以及 HTTP(S) 地址。

无效条目会被跳过；其他有效应用继续加载。传统配置或 managed APP API 请求失败时，桌面
保留其他可用来源，内建“文件”、“设置”、“Wormhole”和“关于”始终存在。

## iframe 与反向代理

推荐把自托管应用代理到桌面同一域名：

```text
https://desktop.example.com/services/example/
```

目标服务必须允许 iframe 嵌入。请检查：

- `Content-Security-Policy` 的 `frame-ancestors`；
- `X-Frame-Options`；
- Cookie 的 `SameSite`、`Secure` 和域名；
- 反向代理是否正确转发 WebSocket、路径前缀和认证头。

浏览器无法可靠报告所有 iframe 拒绝加载情况，因此每个 iframe 窗口都提供“在新标签页打开”。

## Docker

V0.11 使用 Node.js 单容器提供桌面、管理 API、第三方应用静态文件、可选 File Service
和按需开启的 Wormhole。
构建并运行：

```bash
docker build -t biunivers:wormhole-dev .
docker run --rm \
  -p 8080:8080 \
  -p 8081:8081 \
  -e BIUNIVERS_ADMIN_TOKEN="请使用至少16字符的随机值" \
  -e BIUNIVERS_DESKTOP_ORIGIN="http://localhost:8080" \
  -e BIUNIVERS_APP_ORIGIN="http://localhost:8081" \
  -v biunivers-data:/data \
  --name biunivers \
  biunivers:wormhole-dev
```

桌面访问 `http://localhost:8080`。Desktop 和 App Origin 的健康检查地址均为 `/health`。

### File Service

File Service 默认关闭，不影响现有桌面和应用管理。启用时额外传入：

```text
BIUNIVERS_FILE_ENABLED=true
BIUNIVERS_FILE_INITIALIZE=true
BIUNIVERS_FILE_S3_ENDPOINT=https://your-s3-endpoint.example
BIUNIVERS_FILE_S3_REGION=auto
BIUNIVERS_FILE_S3_BUCKET=your-bucket
BIUNIVERS_FILE_S3_PREFIX=biunivers-files
BIUNIVERS_FILE_NAMESPACE=users/your-user
BIUNIVERS_FILE_S3_ACCESS_KEY_ID=...
BIUNIVERS_FILE_S3_SECRET_ACCESS_KEY=...
BIUNIVERS_FILE_S3_FORCE_PATH_STYLE=true
BIUNIVERS_FILE_WRITER_ID=your-host-id
```

`BIUNIVERS_FILE_INITIALIZE=true` 只用于第一次显式创建文件系统。成功后必须改为 `false`；
重复初始化会被拒绝，不会覆盖既有 RefStore。SQLite 位于持久卷
`/data/file-service/file-service.sqlite`。

File Service 启用后可从应用菜单打开 Wormhole。每次开启会生成临时 10 位密码，并提供
Windows WebDAV 连接信息以及可复制的 rclone Mount/Sync 命令。关闭、换密或宿主重启会
撤销旧凭据。公网使用必须通过 HTTPS；它是传输与主动同步通道，不是实时同步服务。

RefStore 缺失/损坏、对象存储不可用或 Head 校验失败时，File Service 进入不可写的
`offline` 状态，桌面和应用管理继续启动。管理员可通过
`GET /api/v1/admin/file-service` 查看不含凭据的状态。Access Key 和 Secret 只能通过 secret
管理或环境变量提供，不能写入应用配置、日志或 Git。

管理员可以创建在线一致性 RefStore 备份和只读 GC 报告：

```bash
curl -X POST \
  -H 'Authorization: Bearer <admin-token>' \
  http://localhost:8080/api/v1/admin/file-service/backups

curl -X POST \
  -H 'Authorization: Bearer <admin-token>' \
  http://localhost:8080/api/v1/admin/file-service/gc-reports
```

备份固定写入 `/data/file-service/backups/latest.sqlite`。V0.3 GC 只报告，不删除对象；
详细恢复步骤与内容校验命令见
[`File Service RefStore 备份与恢复`](<docs/runbooks/File Service RefStore 备份恢复.md>)。

公网部署必须为两个 origin 分配不同的主机名。例如 Nginx：

```nginx
server {
  listen 443 ssl;
  server_name desktop.example.com;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}

server {
  listen 443 ssl;
  # 需要覆盖 app-<hash>.apps.desktop.example.com 的 wildcard DNS 和 TLS 证书。
  server_name *.apps.desktop.example.com apps.desktop.example.com;

  location / {
    proxy_pass http://127.0.0.1:8081;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

对应环境变量：

```text
BIUNIVERS_DESKTOP_ORIGIN=https://desktop.example.com
BIUNIVERS_APP_ORIGIN=https://apps.desktop.example.com
```

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
  biunivers:v0.7.0
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

## 备份

S3 保存不可变文件内容，但当前文件树、已安装应用和桌面布局仍依赖 `/data`。生产部署必须
备份整个数据卷，而不能只备份 S3 或 File Service 的 `latest.sqlite`。一致性备份、非破坏性
恢复演练和环境变量保管方式见
[`Biunivers 数据卷备份与恢复`](<docs/runbooks/Biunivers 数据卷备份恢复.md>)。

## 已知限制

- 只安装公开 `github.com` 仓库根目录中的应用；
- 安装期间不执行依赖安装或构建脚本；
- 配置是公开浏览器配置，不是 secret 存储；
- 单进程本地状态适合个人部署，不支持多副本并发写入；
- 第三方应用使用独立 App Origin；文件能力采用短期实例、句柄和一次性传输 capability；
- File Service 为可选的单用户、单写者能力，不支持多副本并发写入；
- V0.3 GC 只生成报告，不删除不可变对象；
- 不提供账号、多用户、应用商店、多桌面或应用间资源交换。
- 不内置桌面登录认证；公网部署必须使用额外访问控制。

当前范围和验收记录参见 [`docs/`](docs/)。
