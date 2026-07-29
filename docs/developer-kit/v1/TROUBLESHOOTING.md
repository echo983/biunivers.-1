# Biunivers Static App v1 故障排查

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

Open Resource Protocol v1 只定义宿主从文件管理器向已声明 Handler 的应用交付文件，不是
通用应用间调用。

不要通过访问 `window.parent` 或自行约定私有消息绕过限制。通用应用间调用仍属于未来能力。

## GitHub 仓库已经更新，但应用没有变化

Biunivers 安装后固定到具体 commit，不会持续跟随 branch 或 tag。

请在 Biunivers 中显式发起更新，并选择包含新内容的 ref。
# Open Resource 常见问题

## 应用安装成功但不出现在“打开方式”

检查：

- 根目录是否同时存在 `BIUNIVERS_OPEN_RESOURCE_PROTOCOL_V1.md` 和
  `biunivers.open-resource.json`；
- 协议原文是否逐字一致；
- `protocol` 是否为 `biunivers.open-resource/1`；
- 扩展名是否使用小写和前导点；
- 应用是否已启用；
- Handler 是否声明了当前动作。

## 普通启动返回 `NO_LAUNCH_CONTEXT`

这是正常行为，表示用户直接从桌面启动应用，而不是用文件打开。应用应显示空白文档、欢迎页
或自己的打开按钮。

## 已打开应用收到 `launch.contextAvailable`

这表示用户又选择了一个文件。先处理当前未保存内容，再调用 `launch.getContext`。通知本身
不携带资源信息。

## 能读取但不能保存

检查 Launch Context 返回的实际 `permissions`。`read-write` Handler 只是最大能力声明；
只读文件或只读打开仍只会得到 `read`。

## 保存返回 `FILE_VERSION_CONFLICT`

文件已被其他窗口修改。保留当前编辑内容，提示重新打开或另存为，不要自动重试覆盖。
