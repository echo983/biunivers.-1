# AI 开发指令：Biunivers Static App v1

本文件供创建或修改第三方 Biunivers 应用的 AI 开发代理使用。

## 目标

产出一个公开 GitHub 仓库可直接交付的静态 Web 应用。Biunivers 将固定仓库 commit、提供静态文件，并在 iframe 窗口中打开根目录 `index.html`。

## 开始工作前

必须完整阅读：

1. `BIUNIVERS_APP_PROTOCOL_V1.md`；
2. `biunivers.app.json`；
3. 当前仓库中的 `README.md` 和 `LICENSE`；
4. 所有现有构建配置。

如果协议文件缺失、文件名不正确或内容被修改，应报告问题并恢复官方原文，不能根据记忆重写。

## 固定事实

- 协议标识是 `biunivers.static-app/1`；
- 入口固定为仓库根目录 `index.html`；
- Manifest 固定为仓库根目录 `biunivers.app.json`；
- 协议原文固定为仓库根目录 `BIUNIVERS_APP_PROTOCOL_V1.md`；
- 开源许可证固定放在仓库根目录 `LICENSE`；
- Biunivers 不执行第三方构建命令；
- Static App Protocol v1 不定义文件 API；新应用需要文件能力时优先按独立的
  `biunivers.resource-session/1` 接入，并处理不支持、会话过期和版本冲突；
- 只有兼容旧应用时才使用冻结的 `biunivers.host-api/1`；
- 需要从文件管理器接收文件时，只能按可选的 `biunivers.open-resource/1` 或
  `biunivers.open-resource/1.1` 声明 Handler 并领取启动资源；
- 配置会暴露给浏览器，不能包含 secret。

不要向用户重复询问这些已经由协议确定的事项。

## 实施顺序

1. 检查根目录必需文件；
2. 检查 `appId` 与 GitHub owner 是否一致；
3. 检查 manifest 字段和类型；
4. 确认生产入口是根目录 `index.html`；
5. 确认所有包内 URL 使用相对路径；
6. 实现用户要求的应用功能；
7. 处理配置缺失和浏览器能力不可用；
8. 在最小尺寸、默认尺寸和较大尺寸下测试；
9. 检查浏览器控制台和网络请求；
10. 按发布检查表完成交付。

## 构建型项目

可以使用前端构建工具，但最终 GitHub commit 必须已经包含可运行产物。

如果项目构建产物默认进入 `dist/`：

- 可以调整构建输出，使最终 `index.html` 位于仓库根目录；
- 或在发布流程中把完整构建产物复制到发布仓库根目录；
- 不能假定 Biunivers 安装时会执行构建；
- 不能只提交源码和 `package.json`。

不要把开发服务器 URL 写入 manifest。

## 路径检查

优先使用：

```text
./app.js
./assets/icon.svg
assets/style.css
```

不要使用：

```text
/app.js
/assets/icon.svg
file:///...
../other-app/...
```

检查 JavaScript 中的 `fetch`、动态 import、Worker、WASM 和字体 URL，它们也必须能在子路径下正确解析。

## 配置处理

读取：

```js
async function loadConfig() {
  try {
    const response = await fetch("./.biunivers/config.json", {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch {
    return {};
  }
}
```

必须为可选配置提供默认值。不要：

- 把 secret 写进 manifest；
- 在代码中硬编码真实凭据；
- 要求服务端环境变量自动出现在浏览器；
- 使用未在 manifest 中声明的配置 key。

## 窗口界面

应用内容应填满 iframe：

```css
html,
body,
#app {
  width: 100%;
  height: 100%;
  margin: 0;
}
```

使用响应式布局，不依赖固定屏幕坐标。不要绘制外层窗口控制按钮。

## 禁止自行发明

除非用户明确要求设计未来协议，否则不要实现或假定：

- `window.parent` 私有调用；
- 未在 `biunivers.host-api/1` 中定义的私有 `postMessage` Host API；
- `internal` 应用注册；
- 动态窗口控制；
- 应用间资源句柄；
- 任意 manifest 扩展字段；
- 安装期 Node、Python 或 shell 脚本；
- secret 配置。

如果需求必须依赖这些能力，应明确说明它超出 Static App Protocol v1，而不是静默制造非标准实现。

已经接入 Open Resource Protocol v1 或 v1.1 的应用可以接收宿主明确交付的资源；这不允许
应用遍历文件系统、把 session 传给另一个应用或扩展私有方法。

## 可选资源能力

只有用户要求应用能从文件管理器打开文件时才接入：

1. 单资源应用完整复制 `BIUNIVERS_OPEN_RESOURCE_PROTOCOL_V1.md`；需要多资源时改用
   `BIUNIVERS_OPEN_RESOURCE_PROTOCOL_V1_1.md`，两者不能同时携带；
2. 完整复制 `BIUNIVERS_RESOURCE_SESSION_PROTOCOL_V1.md`；
3. 根据所选版本对应的 `biunivers.open-resource.schema.json` 或
   `biunivers.open-resource-v1.1.schema.json` 创建 Handler 声明；
4. 只声明应用实际支持的扩展名、动作和最大权限；
5. 消息监听器就绪后先请求 `resource.getCapabilities`；
6. 请求 `resource.claimLaunch`，将 `NO_LAUNCH_CONTEXT` 作为普通启动；
7. 主动选择文件使用 `resource.open`，另存为使用 `resource.saveAs`；
8. 按返回的 session access 提供只读或编辑界面；
9. GET/PUT 必须同时携带实例凭据和资源会话请求头；
10. 大文件随机读取使用单区间 Range，并处理 `206`、`416`；
11. 每约 60 秒续租仍在使用的 session，关闭文档时主动释放；
12. 保存冲突时保留未保存内容，不静默覆盖。

需要多资源时还必须：

1. 使用 `biunivers.open-resource-v1.1.schema.json`；
2. 把声明协议改为 `biunivers.open-resource/1.1`；
3. 仅在确实支持集合语义的只读 Handler 上声明 `multiple: true`；
4. 先确认 capabilities 中的 `openMany`，再调用 `resource.openMany`；
5. 同时处理 `resource.claimLaunch` 返回的单数 `resource` 与复数 `resources`，两者互斥；
6. 保持 `resources` 顺序，批量续租，并在替换或关闭集合时批量释放；
7. 不猜测或自动取得同目录的其他文件。

优先复制 `template/resource-app` 或 `resource-session-client.example.js`，不要凭记忆重写消息
格式。不要把 `sessionId`、实例凭据、内容 URL 写入 URL、localStorage、IndexedDB、日志
或远程分析服务。

只有用户明确要求兼容旧宿主时，才额外实现 Host API v1 fallback。两套协议必须分别检测，
同一个资源生命周期固定使用一种 transport。

## 验证要求

至少验证：

- `biunivers.app.json` 是合法 JSON；
- Manifest 通过 `biunivers.app.schema.json`；
- 根目录必需文件存在；
- `index.html` 能通过 HTTP 静态服务器加载；
- 页面没有引用不存在的根路径资源；
- 最小尺寸下核心功能可用；
- 配置文件缺失时应用仍能给出合理行为；
- 没有把凭据提交到仓库。

如果项目已有测试和构建命令，在不改变交付模型的前提下运行它们。

## 完成时报告

最终报告应简洁列出：

- 实现了什么；
- Manifest 中的 `appId`、版本和协议；
- 使用了哪些公开配置；
- 执行了哪些验证；
- 是否仍有需要用户提供的信息；
- 是否存在超出 V1 协议的依赖。

不要声称“兼容 Biunivers”，除非根目录文件、Manifest、入口、相对路径和窗口适配均已检查。
