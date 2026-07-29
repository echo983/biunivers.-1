# Biunivers File Service V0.1 首轮验收

- 日期：2026-07-29
- 结果：通过
- 宿主分支：`agent/file-service-v0-1-design`
- 验收应用：[`echo983/biunivers-notepad`](https://github.com/echo983/biunivers-notepad)
- 初始验收应用版本：`0.1.0`（commit `9157e32336cfdd7026eade10fa4410f26742c9f3`）
- 最终验收应用版本：`0.1.1`（commit `63c7b94abd3a209c397e8a486cc10eaa6686c72a`）

## 环境

- Node.js 24 Docker 运行时；
- Desktop Origin：`http://localhost:8080`；
- App Origin 基域：`http://localhost:8081`；
- Cloudflare R2 S3 兼容对象存储；
- Docker 持久卷中的 SQLite RefStore；
- File Service 正常恢复模式：`BIUNIVERS_FILE_INITIALIZE=false`。

凭据、Access Key、Secret 和管理员 token 不记录在本文。

## 已验证链路

1. 显式初始化空文件系统，状态为 `ready`、revision 0；
2. 停止初始化容器，以相同持久卷和 `INITIALIZE=false` 正常恢复；
3. 从公开 GitHub 仓库 inspect、安装并启动第三方静态记事本；
4. 第三方应用在独立 Origin 内通过 `biunivers.host-api/1` 请求保存；
5. 宿主显示保存对话框，用户选择根目录并输入 `first-note.txt`；
6. 待保存句柄完成一次性 PUT 后才创建可见文件，revision 推进到 1；
7. 修改文本并通过原句柄覆盖保存，revision 推进到 2；
8. 新建空白文档后通过宿主文件选择器重新打开文件，内容与第二次保存一致；
9. 关闭并重新打开 iframe 窗口后再次读取成功；
10. 重启整个 Docker 宿主进程后，状态仍为 revision 2；
11. 重启后再次打开 `first-note.txt`，内容保持一致。
12. 通过真实 Host API 和 File HTTP API 流式上传 `large-boundary.bin`，大小为
    67,108,865 字节（64 MiB + 1），revision 推进到 3；
13. 使用新的只读句柄和一次性 GET 从 R2 读回该文件，响应长度精确为 67,108,865 字节，
    验证 Chunk/Manifest 边界路径可用。
14. 运行中的宿主通过受管理员鉴权的备份接口生成在线一致性 SQLite 备份；备份报告
    revision 3、根 Entry ID 与在线状态一致；
15. 将该备份复制到全新的 Docker 持久卷，以 `INITIALIZE=false` 启动独立恢复实例；
16. 恢复实例成功从 R2 验证 Ref → Head → checkpoint 链，并报告 revision 3；
17. 从恢复实例逐个读取所有可达文件并重新校验对象 FID：`first-note.txt` 读取 17 字节；
    `large-boundary.bin` 通过 Manifest 读取两个 Chunk，共 67,108,865 字节；全部验证通过。
18. 在真实 R2 命名空间执行只读 GC 扫描：4 个 Head、3 个 Segment、4 个 Checkpoint、
    1 个 Manifest 和 4 个 Chunk 全部可达；候选对象为 0，且报告明确
    `deletionAllowed: false`。

最终观测状态：

```json
{
  "mode": "ready",
  "writable": true,
  "revision": 3,
  "rootEntryIdHex": "90cf06b0e2b9aabde9caeb5c7f3ecab0"
}
```

## 验收中发现并修复

- `hash-wasm` 原被错误归类为开发依赖，生产镜像无法启动；现已改为运行时依赖，并在
  Docker 构建阶段执行 import 检查。
- iframe 在窗口实例引导完成前立即请求 Host API 时曾收到错误的“不支持”响应；现改为
  等待引导结果。
- 应用静态资源的 CORP 曾阻止 Desktop Origin 加载图标；现允许宿主跨 Origin 嵌入，同时
  保持每应用独立 Origin 和 Host 路由绑定。
- File Service 管理状态曾缓存启动时 revision；现每次查询都重新验证当前 Ref、Head 和
  Checkpoint。

## 后续增强（不阻断 V0.1）

- 多窗口人工冲突交互；核心旧句柄保护、`FILE_VERSION_CONFLICT` 和应用可见提示已有自动化覆盖；
- 浏览器 UI 发起的大文件交互；64 MiB + 1 字节已通过真实 HTTP 流式上传和读回；
- 真实网络断开、超时和部分上传故障注入；对象存储失败不发布 Ref 已有自动化覆盖；
- 保存对话框中的覆盖已有文件交互；
- 文件 MIME/扩展名筛选。

这些项目不影响不可变存储、受控句柄、原子发布、恢复与只读维护闭环，留给后续体验和
故障工程迭代。
