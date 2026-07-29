# Biunivers 第三方静态应用开发包 v1

这份开发包帮助人类开发者和 AI 开发代理创建一个能够被 Biunivers 安装并在桌面窗口中运行的第三方应用。

如果你只想尽快完成第一个应用，请按“最短路径”操作，不需要先阅读 Biunivers 内部架构文档。

## 你最终要交付什么

一个公开的 GitHub 仓库，根目录至少包含：

```text
/
├── index.html
├── biunivers.app.json
├── BIUNIVERS_APP_PROTOCOL_V1.md
├── LICENSE
├── icon.svg
└── 你的其他静态文件
```

这个仓库必须满足：

- `index.html` 可以由浏览器直接运行；
- 不需要 Biunivers 执行构建命令；
- 不需要 Biunivers 启动应用专属后端；
- 所有包内资源使用相对路径；
- 安装配置不包含密码、私钥或其他 secret；
- 仓库是 GitHub public，并提供开源许可证。

完成后，用户向 Biunivers 提供仓库地址和 branch、tag 或 commit，即可发起安装。

## 最短路径

### 第一步：选择模板

- 不需要文件能力：复制 [`template/minimal-app`](template/minimal-app/)；
- 需要选择、打开或保存文件：复制
  [`template/resource-app`](template/resource-app/)。

把所选目录的全部文件放到一个新的 GitHub 仓库根目录。资源应用模板已经包含 Open Resource
Handler 声明、Resource Session 客户端、续租和释放示例。

不要删除或改写：

```text
BIUNIVERS_APP_PROTOCOL_V1.md
```

它必须与本开发包根目录的协议原文完全一致。

资源应用还不得删除或改写：

```text
BIUNIVERS_OPEN_RESOURCE_PROTOCOL_V1.md
BIUNIVERS_RESOURCE_SESSION_PROTOCOL_V1.md
```

### 第二步：修改应用身份

编辑 `biunivers.app.json`：

```json
{
  "appId": "io.github.<你的 GitHub 用户名>.<应用名>",
  "version": "1.0.0",
  "name": "你的应用名称",
  "license": "MIT"
}
```

示例：

```text
GitHub 仓库：https://github.com/alice/calculator
appId：io.github.alice.calculator
```

`appId` 发布后应保持不变。更新应用时只修改 `version` 和应用内容。

### 第三步：实现应用

修改 `index.html`、CSS、JavaScript 和其他静态资源。

推荐：

```html
<script type="module" src="./assets/app.js"></script>
```

不要使用：

```html
<script type="module" src="/assets/app.js"></script>
```

前者相对于应用目录加载，后者会错误地访问 Biunivers 站点根目录。

你可以使用：

- 原生 HTML、CSS 和 JavaScript；
- React、Vue、Svelte 等框架的构建产物；
- Canvas 和 WebGL；
- WebAssembly；
- Web Worker；
- 浏览器允许的外部 HTTP API。

如果使用 Vite 或其他构建工具，请把生产构建配置为相对资源路径，并把最终可运行文件放到仓库根目录。Biunivers 不运行 `npm install` 或 `npm run build`。

### 第四步：检查窗口适配

应用必须在 manifest 声明的最小尺寸和默认尺寸下可用，并能适应最大化。

最少检查：

- 页面根元素填满 iframe；
- 调整窗口大小时布局不会损坏；
- 不出现无意义的横向滚动条；
- 不重复绘制 Biunivers 的最小化、最大化和关闭按钮；
- 键盘焦点可见。

### 第五步：发布

1. 按照 [发布检查表](PUBLISH_CHECKLIST.md) 检查仓库；
2. 推送到 GitHub public 仓库；
3. 推荐创建一个 tag，例如 `v1.0.0`；
4. 在 Biunivers 安装界面填写仓库 URL 和 tag；
5. 填写 manifest 声明的公开配置；
6. 完成安装并打开应用。

## Manifest 怎么写

最小示例：

```json
{
  "formatVersion": 1,
  "protocol": "biunivers.static-app/1",
  "appId": "io.github.example.hello",
  "version": "1.0.0",
  "name": "Hello",
  "license": "MIT",
  "icon": "icon.svg",
  "window": {
    "defaultWidth": 640,
    "defaultHeight": 480
  },
  "configuration": []
}
```

使用本开发包中的 [`biunivers.app.schema.json`](biunivers.app.schema.json) 获得编辑器补全和机器校验。

字段的规范定义见 [Biunivers App Manifest v1](<../../protocols/Biunivers App Manifest v1.md>)。

## 安装配置

如果应用需要用户配置，在 manifest 的 `configuration` 中声明：

```json
{
  "configuration": [
    {
      "key": "defaultPrecision",
      "label": "默认精度",
      "type": "integer",
      "required": false,
      "default": 2,
      "minimum": 0,
      "maximum": 12
    }
  ]
}
```

应用从固定地址读取最终值：

```js
const config = await fetch("./.biunivers/config.json", {
  cache: "no-store",
}).then((response) => response.json());
```

这些值会进入最终用户的浏览器，始终视为公开数据。

适合：

- 默认主题；
- 语言；
- 公共 API 地址；
- 功能开关；
- 计算精度。

不适合：

- 密码；
- 私钥；
- 数据库凭据；
- 长期访问 token；
- 任何浏览器用户不应看到的值。

## 启动上下文

Biunivers 可能在入口 URL 中提供：

```text
?biunivers_locale=zh-CN&biunivers_theme=dark
```

应用可以读取，但不能要求它们一定存在：

```js
const query = new URLSearchParams(window.location.search);
const locale = query.get("biunivers_locale") ?? "en";
const theme = query.get("biunivers_theme") ?? "system";
```

应用必须忽略不认识的 `biunivers_` 参数。

## 宿主负责什么

Biunivers 负责：

- 从 GitHub 获取指定版本；
- 安装并提供静态文件；
- 提供安装配置；
- 创建 iframe 和桌面窗口；
- 处理标题栏、拖动、缩放、最小化、最大化和关闭；
- 更新、停用和卸载应用。

支持 File Service 的宿主还可以选择提供独立的
[`biunivers.resource-session/1`](BIUNIVERS_RESOURCE_SESSION_PROTOCOL_V1.md)。新应用应
优先使用它完成文件选择、重复读取、Range 读取、续租和保存。使用时把
`BIUNIVERS_RESOURCE_SESSION_PROTOCOL_V1.md` 原文复制到应用仓库根目录，并先调用
`resource.getCapabilities`。不使用文件能力的应用无需接入。

可以从
[`resource-session-client.example.js`](resource-session-client.example.js)
复制最小客户端，并用
[`biunivers.resource-session.message.schema.json`](biunivers.resource-session.message.schema.json)
检查请求信封。示例覆盖启动资源领取、主动选取、完整/Range GET、PUT、续租与释放。

旧应用仍可使用冻结兼容接口
[`biunivers.host-api/1`](<../../protocols/Biunivers Host API v1.md>)，但新应用不应基于其
一次性完整 transfer 模型设计大文件或媒体播放功能。

## 声明可以打开文件

需要从文件管理器接收文件的应用可以选择接入
[`biunivers.open-resource/1`](BIUNIVERS_OPEN_RESOURCE_PROTOCOL_V1.md)。它不会自动授予
文件权限，也不会自动把应用设为默认程序。领取文件后，新应用使用 Resource Session；
旧应用仍可使用 Host API。

仓库根目录另外放置：

```text
BIUNIVERS_OPEN_RESOURCE_PROTOCOL_V1.md
biunivers.open-resource.json
```

不要改写协议原文。声明可以从
[`biunivers.open-resource.example.json`](biunivers.open-resource.example.json) 开始，并用
[`biunivers.open-resource.schema.json`](biunivers.open-resource.schema.json) 校验。

例如文本编辑器：

```json
{
  "protocol": "biunivers.open-resource/1",
  "handlers": [
    {
      "id": "text-editor",
      "actions": ["open", "edit"],
      "extensions": [".txt", ".md"],
      "mediaTypes": ["text/plain", "text/markdown"],
      "access": "read-write"
    }
  ]
}
```

新应用启动后先调用 `resource.getCapabilities`，再调用 `resource.claimLaunch`。普通桌面
启动返回 `NO_LAUNCH_CONTEXT` 时，继续显示欢迎页或自己的“打开”按钮。资源启动成功后，
应用取得可续租 session，通过返回的内容 URL 完成 GET、Range GET 或 PUT，并约每 60 秒
调用 `resource.renew`。关闭资源时调用 `resource.release`。

应用不得把 `sessionId`、实例凭据或内容 URL 放入日志、URL、本地持久化或分析事件，也不能
转交给其他应用。完整起点见
[`template/resource-app`](template/resource-app/)。

只有维护必须兼容旧宿主的应用时，才按冻结的 Open Resource 原文使用
`launch.getContext` 和 Host API handle。不要在同一个资源生命周期中混用两套传输。

应用负责：

- iframe 内部界面；
- 业务逻辑；
- 自身客户端状态；
- 浏览器兼容性检测；
- 外部 API 的可用性和 CORS 配置。

## V1 没有什么

Static App Protocol v1 本身不定义：

- 应用之间互相调用；
- 未经宿主授权的文件关联或跨应用资源传递；
- secret 管理；
- 应用专属后端；
- 自动更新；
- Biunivers 内部 store 或父页面 DOM。

文件处理器声明由 Open Resource Protocol v1 定义；新应用的文件选择、读取、续租和保存由
Resource Session Protocol v1 定义。Host API v1 只作为旧应用兼容底座。不要自行设计私有
的父页面调用方式。

## 给 AI 开发代理

如果由 AI 创建或修改应用，先完整阅读：

1. [AI 开发指令](AI_DEVELOPER_GUIDE.md)；
2. [协议原文](BIUNIVERS_APP_PROTOCOL_V1.md)；
3. [Manifest 规范](<../../protocols/Biunivers App Manifest v1.md>)。

AI 不得猜测文件摘要、Host API 或未定义字段，也不得为了“增强兼容性”修改协议原文。
如果应用接入资源打开能力，还必须完整阅读
[`BIUNIVERS_OPEN_RESOURCE_PROTOCOL_V1.md`](BIUNIVERS_OPEN_RESOURCE_PROTOCOL_V1.md)。
新应用还必须阅读
[`BIUNIVERS_RESOURCE_SESSION_PROTOCOL_V1.md`](BIUNIVERS_RESOURCE_SESSION_PROTOCOL_V1.md)。

## 遇到问题

- 安装失败或入口打不开：查看 [故障排查](TROUBLESHOOTING.md)；
- 发布前确认：使用 [发布检查表](PUBLISH_CHECKLIST.md)；
- 想理解完整平台安装行为：阅读 [App Management Protocol](<../../protocols/Biunivers App Management Protocol v1.md>)。

第三方日常开发通常不需要阅读管理协议、内部 ADR 或 Nassau 参考文档。
