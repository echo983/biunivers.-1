# Biunivers Static App v1 发布检查表

发布或更新前逐项确认。

## 仓库

- [ ] 仓库位于 `github.com`
- [ ] 仓库是 public
- [ ] 根目录存在 `LICENSE`
- [ ] `LICENSE` 与 manifest 的 `license` 一致
- [ ] 发布 commit 已经包含可直接运行的构建产物
- [ ] 推荐的 release tag 已指向准备安装的 commit

## 协议和 Manifest

- [ ] 根目录存在 `BIUNIVERS_APP_PROTOCOL_V1.md`
- [ ] 协议文件是官方原文，没有改写
- [ ] 根目录存在 `biunivers.app.json`
- [ ] `formatVersion` 是 `1`
- [ ] `protocol` 是 `biunivers.static-app/1`
- [ ] `appId` 符合 `io.github.<owner>.<application>`
- [ ] `appId` 中的 owner 与 GitHub 仓库 owner 一致
- [ ] `version` 是有效 SemVer
- [ ] icon 是存在的包内相对路径
- [ ] Manifest 通过 `biunivers.app.schema.json`
- [ ] 更新版本没有改变 `appId`

## 应用入口

- [ ] 根目录存在 `index.html`
- [ ] 不需要执行安装或构建命令即可运行
- [ ] HTML、CSS、JS、图片、字体、Worker 和 WASM 使用正确相对路径
- [ ] 应用不假定部署在域名根目录
- [ ] 应用不依赖 Biunivers 提供 SPA fallback
- [ ] 应用不依赖访问父页面

## 窗口体验

- [ ] 默认尺寸下核心功能可用
- [ ] 最小尺寸下核心功能可用
- [ ] 最大化后布局正常
- [ ] 没有无意义的横向滚动条
- [ ] 没有重复的外层窗口控制按钮
- [ ] 键盘焦点可见

## 配置和数据

- [ ] 所有读取的安装配置都在 manifest 中声明
- [ ] 可选配置有默认行为
- [ ] 配置读取失败有合理处理
- [ ] 配置不包含密码、私钥或长期 token
- [ ] 仓库代码和历史中没有真实凭据

## 最终验证

- [ ] 使用 HTTP 静态服务器打开根目录 `index.html`
- [ ] 浏览器控制台没有阻断运行的错误
- [ ] 网络面板没有 404 的包内资源
- [ ] 已在 Biunivers 测试安装
- [ ] 安装后可以打开、调整尺寸、最小化、还原和关闭
- [ ] 更新失败时没有破坏原已安装版本

## 可选：Open Resource v1

仅在应用声明文件处理能力时检查：

- [ ] 根目录存在 `BIUNIVERS_OPEN_RESOURCE_PROTOCOL_V1.md`
- [ ] Open Resource 协议文件是官方原文，没有改写
- [ ] 根目录存在 `biunivers.open-resource.json`
- [ ] 声明通过 `biunivers.open-resource.schema.json`

## 使用 Resource Session 时

- [ ] 根目录存在 `BIUNIVERS_RESOURCE_SESSION_PROTOCOL_V1.md`
- [ ] 协议文件与开发包原文逐字节一致
- [ ] 应用先检测 `resource.getCapabilities`
- [ ] 应用约每 60 秒批量续租仍使用的会话
- [ ] 应用在关闭资源时调用 `resource.release`
- [ ] GET/PUT 同时携带实例凭据和资源会话请求头
- [ ] 应用处理 206、416、会话过期、撤销和版本冲突
- [ ] 大文件和媒体读取使用单区间 Range，而不是一次读取全部内容
- [ ] Handler ID 在应用内唯一且更新时保持稳定
- [ ] 扩展名为小写且带前导点
- [ ] 声明 `edit` 的 Handler 使用 `read-write`
- [ ] 普通启动的 `NO_LAUNCH_CONTEXT` 被当作正常路径
- [ ] 应用只使用实际返回的 `permissions`
- [ ] 文件 handle 不进入 URL、日志、分析事件或持久化存储
- [ ] 保存冲突不会静默覆盖用户文件
- [ ] 完成或关闭文档时调用 `file.release`
