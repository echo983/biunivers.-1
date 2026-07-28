# Biunivers Static App Protocol v1

状态：草案

协议标识：`biunivers.static-app/1`

固定文件名：`BIUNIVERS_APP_PROTOCOL_V1.md`

规范性质：第三方适配时必须原文复制

## 1. 目标

本协议定义第三方静态 Web 应用接入 Biunivers 所需的最小约定。

一个 Biunivers V1 应用就是一组可以由浏览器直接运行的静态文件。Biunivers 安装并提供这些文件，通过 iframe 在桌面窗口中打开根目录的 `index.html`。

应用内部可以使用原生 JavaScript、任意前端框架、Canvas、WebGL、WebAssembly、Web Worker 或其他浏览器能力。Biunivers 不解析应用实现。

## 2. 适配声明

应用仓库根目录必须包含本文件的完整原文：

```text
BIUNIVERS_APP_PROTOCOL_V1.md
```

仓库根目录的 `biunivers.app.json` 必须同时声明：

```json
{
  "protocol": "biunivers.static-app/1"
}
```

Biunivers 安装时必须确认 manifest 声明、协议文件名和协议正文与宿主支持的版本一致。

协议正式发布后正文不再修改。需要改变规范时发布新的协议版本和文件名。

## 3. 必需文件

仓库根目录至少包含：

```text
/
├── index.html
├── biunivers.app.json
├── BIUNIVERS_APP_PROTOCOL_V1.md
└── LICENSE
```

`index.html` 是 V1 唯一入口。应用可以包含 JS、CSS、图片、字体、WASM 等其他静态文件。

## 4. 静态运行要求

应用必须是已经构建完成、可由浏览器直接打开的静态 Web 应用。

Biunivers 不会：

- 安装 npm 或其他语言依赖；
- 执行仓库中的构建命令或脚本；
- 启动应用专属的 Node.js、Python 或其他服务；
- 为应用提供数据库；
- 调用应用内部初始化函数。

需要编译的项目必须把可运行产物提交到仓库。

应用可以访问外部 API，但这些服务不属于应用包，也不由 Biunivers 安装或管理。

## 5. 路径要求

应用会被托管在子路径下，例如：

```text
/apps/io.github.example.calculator/<commit-sha>/index.html
```

包内资源必须使用相对路径：

```html
<script type="module" src="./assets/app.js"></script>
```

应用不得假定自己位于域名根路径，也不得通过 `..` 访问应用目录之外的资源。

需要客户端路由的 V1 应用应使用 hash 路由。Biunivers V1 不保证为应用内部路径提供 SPA fallback。

## 6. 窗口约定

Biunivers 负责外层窗口的：

- 标题和图标；
- 拖动和缩放；
- 最小化；
- 最大化和还原；
- 聚焦；
- 关闭；
- 任务栏状态。

应用负责 iframe 内的内容和业务状态。

应用必须：

- 适应 manifest 声明的最小尺寸到最大化尺寸；
- 随 iframe 视口变化重新布局；
- 避免无必要的横向滚动；
- 不绘制控制 Biunivers 外层窗口的按钮；
- 不依赖访问父页面 DOM、JavaScript、Cookie 或 localStorage。

Biunivers 可以销毁并重新创建 iframe。应用不能假定关闭窗口、刷新页面或宿主重启后运行内存仍然存在。

## 7. 安装配置

静态应用没有真正的进程环境变量。Manifest 中声明的配置是安装时填写的公开客户端配置。

Biunivers 通过固定虚拟地址提供最终配置：

```text
./.biunivers/config.json
```

应用可以读取：

```js
const config = await fetch("./.biunivers/config.json", {
  cache: "no-store",
}).then((response) => response.json());
```

这些配置会发送到用户浏览器，不能用于保存：

- 密码；
- 私钥；
- 数据库凭据；
- 长期访问令牌；
- 其他需要对浏览器用户保密的值。

## 8. 启动上下文

Biunivers 可以在入口 URL 中提供：

```text
index.html?biunivers_locale=zh-CN&biunivers_theme=dark
```

V1 仅保留：

- `biunivers_locale`：宿主语言；
- `biunivers_theme`：`light`、`dark` 或 `system`。

应用必须忽略不认识的 `biunivers_` 查询参数。

## 9. 浏览器能力

应用可以使用浏览器 API，但必须自行检测兼容性。

摄像头、麦克风、剪贴板、通知、全屏、跨域网络和部分高性能 API 仍可能受浏览器权限、iframe、CORS、CSP 或部署方式限制。本协议不承诺这些能力一定可用。

## 10. 宿主接口边界

V1 不提供 Host API，也不定义：

- 应用调用其他应用；
- 文件类型关联；
- 跨应用资源传递；
- 动态控制宿主窗口；
- 读取桌面或其他应用状态。

这些能力以后通过独立、版本化的协议增加，不改变本协议的静态 `index.html` 入口。

## 11. 双方责任

第三方开发者负责：

- 提供可以直接运行的静态应用；
- 正确使用相对资源路径；
- 测试窗口尺寸适配；
- 在根目录提供与 manifest 一致的开源许可证；
- 不要求 secret 配置；
- 维护应用自身业务逻辑。

Biunivers 负责：

- 校验协议和 manifest；
- 固定安装来源版本；
- 提供应用静态文件和公开配置；
- 注册 iframe 应用；
- 管理安装、更新、停用和卸载。

## 12. V1 非目标

V1 不包含：

- 应用商店和发布者审核；
- 私有仓库；
- 安装时构建；
- 应用专属服务端；
- secret 管理；
- Host API；
- 应用间资源交换；
- 权限申请系统；
- 自动更新。
