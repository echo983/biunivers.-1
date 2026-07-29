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

### 第一步：复制最小示例

从 [`template/minimal-app`](template/minimal-app/) 复制全部文件到一个新的 GitHub 仓库根目录。

不要删除或改写：

```text
BIUNIVERS_APP_PROTOCOL_V1.md
```

它必须与本开发包根目录的协议原文完全一致。

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
[`biunivers.host-api/1`](<../../protocols/Biunivers Host API v1.md>)。它不属于静态应用
安装协议，应用必须先检测能力，并能处理 `HOST_API_UNSUPPORTED`。不使用文件能力的应用无需
接入 Host API。

应用负责：

- iframe 内部界面；
- 业务逻辑；
- 自身客户端状态；
- 浏览器兼容性检测；
- 外部 API 的可用性和 CORS 配置。

## V1 没有什么

Static App Protocol v1 本身不定义：

- 应用之间互相调用；
- 文件关联；
- 跨应用资源传递；
- secret 管理；
- 应用专属后端；
- 自动更新；
- Biunivers 内部 store 或父页面 DOM。

文件打开与保存已经由独立、可选的 Host API v1 定义；其他未来能力也会使用独立、带版本的
协议。不要自行设计私有的父页面调用方式。

## 给 AI 开发代理

如果由 AI 创建或修改应用，先完整阅读：

1. [AI 开发指令](AI_DEVELOPER_GUIDE.md)；
2. [协议原文](BIUNIVERS_APP_PROTOCOL_V1.md)；
3. [Manifest 规范](<../../protocols/Biunivers App Manifest v1.md>)。

AI 不得猜测文件摘要、Host API 或未定义字段，也不得为了“增强兼容性”修改协议原文。

## 遇到问题

- 安装失败或入口打不开：查看 [故障排查](TROUBLESHOOTING.md)；
- 发布前确认：使用 [发布检查表](PUBLISH_CHECKLIST.md)；
- 想理解完整平台安装行为：阅读 [App Management Protocol](<../../protocols/Biunivers App Management Protocol v1.md>)。

第三方日常开发通常不需要阅读管理协议、内部 ADR 或 Nassau 参考文档。
