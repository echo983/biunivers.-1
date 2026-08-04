# Biunivers Static App v1 故障排查

本页主体适用于 Static App。BWA 的镜像安装、健康检查、Workspace 与代理故障见本页末尾
“Workspace Application 故障排查”。

先找到最接近的现象，再按顺序检查。

## 安装器提示缺少协议

确认仓库根目录存在：

```text
BIUNIVERS_APP_PROTOCOL_V1.md
```

文件名区分大小写。不要重新排版、翻译或删减协议正文，应直接复制开发包中的官方文件。

## Manifest 无法通过校验

检查：

- 文件名是否为 `biunivers.app.json`；
- JSON 是否存在注释、尾随逗号或重复字段；
- `formatVersion` 是否为数字 `1`；
- `protocol` 是否为 `biunivers.static-app/1`；
- `appId` 是否全部小写并与 GitHub owner 一致；
- `version` 是否为 SemVer；
- `configuration` 是否为数组；
- 是否加入了 V1 未定义字段。

使用 `biunivers.app.schema.json` 定位具体字段错误。

## 安装器找不到入口

入口必须精确位于：

```text
<仓库根目录>/index.html
```

以下结构不符合 V1：

```text
dist/index.html
public/index.html
src/index.html
```

如果项目需要构建，应在发布前把完整生产产物放到仓库根目录。

## 页面打开后空白

依次检查：

1. 浏览器控制台的第一条错误；
2. 网络面板中的 404；
3. JS 和 CSS 是否使用 `/assets/...` 绝对根路径；
4. 构建工具的 base path 是否为相对路径；
5. `index.html` 引用的文件是否已经提交；
6. 模块脚本是否由 HTTP 服务而不是 `file://` 打开。

## 开发环境正常，安装后资源 404

最常见原因是资源使用站点根路径：

```text
/assets/app.js
```

改成：

```text
./assets/app.js
```

同时检查：

- CSS `url(...)`；
- `fetch(...)`；
-动态 import；
-Worker 构造函数；
-WASM 加载地址；
-字体和图片地址。

## 配置始终为空

应用必须从相对虚拟地址读取：

```text
./.biunivers/config.json
```

不要读取操作系统环境变量，也不要假定 `process.env` 会由 Biunivers 注入。

检查配置 key 是否已经在 manifest 中声明，以及应用是否对 HTTP 错误进行了处理。

## 外部 API 请求失败

Biunivers 不代理普通第三方 API。检查：

- API 是否支持 HTTPS；
- 服务端是否允许浏览器 CORS；
- 请求地址是否在局域网用户的浏览器中可达；
- API 是否错误地要求不能暴露给浏览器的 secret；
- 浏览器控制台是否报告 mixed content 或权限错误。

如果必须使用服务端 secret，该应用不适合仅通过 Static App Protocol v1 交付。

## WASM、Worker 或 WebGL 不工作

检查：

- WASM 和 Worker URL 是否为相对路径；
- 静态服务器是否返回正确 MIME 类型；
- 浏览器是否支持所需能力；
- 功能是否要求安全上下文；
- 功能是否受到 iframe 或跨域隔离限制。

应用应检测能力并显示明确错误，不能假定所有浏览器环境相同。

## 窗口尺寸变化后界面损坏

确认根元素使用可伸缩尺寸：

```css
html,
body,
#app {
  width: 100%;
  height: 100%;
  margin: 0;
}
```

避免使用固定屏幕宽高、固定坐标和只在首次加载时计算一次的布局。

## 想从一个应用打开另一个应用

Open Resource Protocol v1/v1.1 只定义宿主向已声明 Handler 的应用交付用户明确选择的
文件，不是通用应用间调用。

不要通过访问 `window.parent` 或自行约定私有消息绕过限制。通用应用间调用仍属于未来能力。

## GitHub 仓库已经更新，但应用没有变化

Biunivers 安装后固定到具体 commit，不会持续跟随 branch 或 tag。

请在 Biunivers 中显式发起更新，并选择包含新内容的 ref。

## Workspace Application 故障排查

### 镜像无法安装

确认镜像已公开发布到 registry，引用格式类似 `ghcr.io/owner/image:tag`，并包含：

```text
io.biunivers.workspace-application.protocol=1
```

不要填写 GitHub 仓库 URL、Dockerfile 路径或本地镜像名。宿主会把 tag 固定为 digest；更新
同一 tag 后仍需在管理界面显式执行更新。

### Instance 启动失败

在普通 Docker 中验证镜像能够以非 root、只读 root filesystem 运行，并确认：

- HTTP 监听 `0.0.0.0:8080`，而不是 `127.0.0.1`；
- `/health` 无需登录即可快速返回 `2xx`；
- 持久写入只进入 `/workspace`，临时写入进入 `/tmp`；
- 启动不依赖 Docker socket、host network、capabilities 或固定 UID；
- 必需环境变量已在 Instance 配置中填写。

### 界面提示重新打开或代理错误

不要缓存或分享 Instance bootstrap URL。关闭旧窗口，从 Biunivers 重新打开 Instance。应用
生成链接、表单和 WebSocket 地址时使用当前代理 origin 或转发头，浏览器不能访问容器私有 IP。

### 重启后数据消失

只有 `/workspace` 是主要持久状态。容器 root、`/tmp`、内存和浏览器连接不会进入 Workspace
HEAD。应用先 flush 自身事务，再由用户执行停止、保存重启或其他受控提交。

### 停止很慢

宿主会给容器正常终止窗口，让应用 flush 后提交 COW 改动。确保 PID 1 能接收或转发
SIGTERM，不要用吞掉信号的 shell 包裹主进程。

### 出现待处理的异常改动

异常退出后宿主不会自动发布 Upper。用户必须选择发布或丢弃；处理前新的 Run 会被阻止。
这是数据保护门禁，不应由应用绕过。
# Open Resource 与 Resource Session 常见问题

## 应用安装成功但不出现在“打开方式”

检查：

- 根目录是否存在声明版本对应的一份 Open Resource 协议原文和
  `biunivers.open-resource.json`；
- 协议原文是否逐字一致；
- `protocol` 是否为宿主支持的 `biunivers.open-resource/1` 或
  `biunivers.open-resource/1.1`，文件名是否与版本一致；
- 扩展名是否使用小写和前导点；
- 应用是否已启用；
- Handler 是否声明了当前动作。

## `resource.openMany` 不可用或文件管理器没有批量候选

依次检查：

- 声明是否为 `biunivers.open-resource/1.1`，并携带 v1.1 原文；
- Handler 是否同时声明 `multiple: true`、`open` 和 `read`；
- 每个所选文件的扩展名是否都被同一个 Handler 接受；
- 所选项目是否全部是同一目录中的普通文件，数量是否为 2 至宿主上限；
- `resource.getCapabilities` 是否返回 `openMany: true`；
- 应用是否错误地只读取了 `claimLaunch` 的单数 `resource`，而没有处理复数 `resources`。

宿主不会为了凑齐集合而自动附加同目录文件，也不会把多个不同 Handler 的匹配结果拼成一个
批次。

## `resource.getCapabilities` 没有响应

确认消息监听器在发送请求前已经注册，并检查：

- 应用是否位于 Biunivers 管理的 iframe 中；
- `event.source` 是否严格等于 `window.parent`；
- `event.origin` 和 `postMessage` target origin 是否来自 `document.referrer`；
- 请求协议是否为 `biunivers.resource-session/1`；
- 当前宿主是否启用了 File Service。

新应用应显示“当前宿主不支持文件能力”，不能静默改用自创接口。

## 普通启动返回 `NO_LAUNCH_CONTEXT`

这是正常行为，表示用户直接从桌面启动应用，而不是用文件打开。应用应显示空白文档、欢迎页
或自己的打开按钮。

## 已打开应用收到 `launch.contextAvailable`

这表示用户又选择了一个文件。先处理当前未保存内容，再调用 `resource.claimLaunch`。通知
本身不携带资源信息，也不是资源授权。

## 能读取但不能保存

检查 session 返回的实际 `access`。`read-write` Handler 只是最大能力声明；只读打开仍会
得到只读 session。

## GET 返回 401、404 或 410

检查实例凭据和资源会话请求头是否都存在。404/410 还可能表示 session 已释放、超过 300 秒
未续租、被宿主撤销，或宿主已经重启。不要继续重试旧 session，应请用户重新选择文件。

## Range 返回 416

请求区间超出当前内容长度。读取 `Content-Range: bytes */<total>`，更新长度并重新计算区间。
V1 只支持单区间，不要发送 multipart Range。

## 保存返回版本冲突

文件已被其他窗口修改。保留当前编辑内容，提示重新打开或另存为，不要自动重试覆盖。

## 维护旧 Host API 应用

冻结的 Open Resource v1 原文描述 `launch.getContext` 和 Host API handle，这是兼容路径，不是
新应用首选路径。需要兼容时，将 Host API 和 Resource Session 分别检测；一个资源一旦选择
transport，就不要在其生命周期内切换。
