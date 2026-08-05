# Biunivers Workspace Application v1 开发指南

本文是第三方开发者交付 BWA 的最短完整路径。规范原文是
[`Biunivers Workspace Application Protocol v1`](BIUNIVERS_WORKSPACE_APPLICATION_PROTOCOL_V1.md)；
冲突时以规范原文为准。

## 1. 何时使用 BWA

BWA 适合需要容器后端、长期后台进程、服务端 secret、原生工具链，或需要把项目目录作为
可 Fork、可提交状态的应用。纯浏览器计算和由用户逐个授权的文件处理应优先使用 Static App。
BWA 不是获取宿主文件系统、Docker socket 或特权容器的捷径。

## 2. 交付物与身份

第一版交付发布到 OCI registry 的一个容器镜像。当前宿主没有私有 registry 登录流程，因此
镜像必须可匿名拉取，推荐使用公开 GHCR：

```text
ghcr.io/<owner>/<image>:<tag>
```

应用长期身份是去掉 tag/digest 后的规范 repository；实际安装由宿主固定为不可变 digest。
BWA 不使用 `biunivers.app.json`，也不要求把协议 Markdown 放入镜像。

开发时必须完整阅读开发包中的协议原文。该文件是冻结副本，不能改写；它用于开发与审查，
但不需要复制进最终容器镜像。

建议从开发包复制到源码仓库：

```text
BIUNIVERS_WORKSPACE_APPLICATION_PROTOCOL_V1.md
BWA_AGENTS.md  → AGENTS.md
BWA_PUBLISH_CHECKLIST.md
```

将这些开发文档加入 `.dockerignore`，避免无意义地增加镜像内容。

镜像必须包含协议 label，并应提供标准 OCI 元信息：

```text
io.biunivers.workspace-application.protocol=1
org.opencontainers.image.title
org.opencontainers.image.description
org.opencontainers.image.source
org.opencontainers.image.version
org.opencontainers.image.revision
org.opencontainers.image.licenses
```

`source` 应指向用户可访问和审查的源码仓库。label 不能包含 secret。

## 3. 运行契约

容器必须：

- 在 `0.0.0.0:8080` 提供 HTTP UI；
- `GET /` 返回图形界面，`GET /health` 无副作用且就绪时返回 `2xx`；
- 把主要持久数据写入 `/workspace`，临时文件写入 `/tmp`；
- 支持宿主指定的非 root UID/GID 和只读 root filesystem；
- 不要求 published port、host network、Docker socket、privileged 或 Linux capabilities。

宿主注入：

```text
BIUNIVERS_HTTP_PORT=8080
BIUNIVERS_WORKSPACE=/workspace
```

不要把容器 ID、IP、Run ID 或浏览器 bootstrap URL 当作身份或持久配置。

应用在启动阶段发现必需配置缺失或其他不可恢复条件时，应在退出前向标准错误输出：

```text
BWA_STARTUP_ERROR: <不含 secret、面向用户的简短修复说明>
```

Manager 会优先把最后一条该前缀作为启动失败摘要，并提供受限日志尾部。未提供该行的应用仍
可运行，失败时回退到宿主通用说明。瞬时的运行期依赖错误应由应用界面处理，不应伪装成启动
失败。不要在摘要或其他日志中输出环境变量值、凭据或请求头。

## 4. 最小 Dockerfile

以下 Node 示例只展示契约，语言和框架不受限制：

```dockerfile
FROM node:24-alpine

LABEL io.biunivers.workspace-application.protocol="1" \
      org.opencontainers.image.title="Example Workspace App" \
      org.opencontainers.image.description="Minimal BWA example" \
      org.opencontainers.image.source="https://github.com/example/bwa-example" \
      org.opencontainers.image.version="1.0.0" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY --chown=65532:65532 . /app
USER 65532:65532
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.mjs"]
```

服务应读取 `BIUNIVERS_HTTP_PORT` 并确保 `SIGTERM` 到达真正的主进程。不要用吞掉信号的
shell wrapper 作为 PID 1。

## 5. UI 与反向代理

UI 在独立 Instance Origin 的 iframe 中呈现。应用应响应 iframe 尺寸变化，不重复绘制宿主
窗口按钮，不访问父页面 DOM/Cookie，不设置阻止嵌入的 `X-Frame-Options` 或 CSP。

站内 URL、表单和 WebSocket 应保持在当前 origin；必要时读取 `X-Forwarded-Proto`、
`X-Forwarded-Host` 和 `X-Forwarded-Prefix`。不得把容器私有地址返回浏览器。iframe 关闭不
等于容器停止，后台任务不能依赖页面持续存在。

## 6. Workspace 状态模型

每个 Instance 独占绑定一个 Workspace，运行时挂载为可写 `/workspace`。写入先进入 COW
Upper；只有宿主成功提交后才产生新的 Workspace HEAD。

应用必须接受：保存重启和正常停止可以提交状态；Fork 会产生独立平行状态；异常退出不会
自动发布改动；用户可以发布或丢弃异常 Upper；宿主重启不会恢复内存、PID 或 socket。

需要一致性时，应用先 flush/commit 自身数据库，再让用户执行宿主保存或停止。一次成功的
文件写调用不等于 Workspace HEAD 已发布。

## 7. 配置与 secret

用户可以在 Application 上保存公共的默认普通变量和 secret，Instance 只配置差异项；同名
Instance 配置优先。最终环境在下一次启动或保存重启时合并并固定注入，已经运行的容器不会
热更新。应用 README 应列出变量名称、是否必需、是否敏感、非 secret 示例和生效时机。

应用不能感知某个值来自 Application 默认项还是 Instance 覆盖项，也不应依赖该来源。
删除 Instance 覆盖后，宿主会在下次启动时重新使用 Application 默认值。

secret 不得进入页面、日志、健康响应、Workspace、OCI label 或诊断输出；应用不得要求宿主
管理凭据或任意宿主环境变量。

## 8. 网络边界

V1 默认允许容器访问网络路由可达的外部目标，但不承诺可用性、DNS、隐私或稳定性。入站只
通过 Runtime Proxy 到 8080，容器端口不直接发布。不要假设其他 BWA 的 IP、容器名或服务
发现可用。多容器、Compose、任意端口和宿主 shell 不属于 V1。

## 9. 发布到 GHCR

构建并发布示例：

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <owner> --password-stdin
docker build -t ghcr.io/<owner>/<image>:1.0.0 .
docker push ghcr.io/<owner>/<image>:1.0.0
```

不要把 token 写入仓库、Dockerfile、镜像层或命令历史。GitHub Actions workflow 需要
`packages: write`；推荐同时发布 SemVer tag 和 commit SHA tag，并确保 package visibility
允许目标部署拉取。

## 10. 安装、实例与更新

用户在“工作空间应用”中输入镜像 tag。宿主读取 labels、解析 digest 后注册应用。随后创建
Instance，可从空白 Workspace 或已有 Workspace 的 Fork 开始，继承 Application 默认环境，
按需填写 Instance 覆盖后启动。用户还可以在可信文件管理器中把 main 的明确选择集添加到
已有 Workspace；这不会让 BWA 获得 main 的目录枚举或主动文件选择能力。

发布新镜像后由用户显式更新；正在运行或存在未处置异常 Upper 时宿主可以拒绝更新。tag
漂移不会静默替换已经安装的 digest。

## 11. 最小验收

按 [`BWA_PUBLISH_CHECKLIST.md`](BWA_PUBLISH_CHECKLIST.md) 检查，至少实测：

1. 非 root、只读 root filesystem 启动；
2. `/health`、`/`、静态资源和 WebSocket（若使用）；
3. `/workspace` 写入后保存重启仍存在；
4. Fork 后两个 Instance 独立；
5. 正常停止能提交，异常退出不会自动污染 HEAD；
6. secret 不进入日志、页面、镜像和 Workspace；
7. SIGTERM 能在宿主终止窗口内完成。
8. Application 默认环境可供新 Instance 直接使用，Instance 覆盖不污染其他状态。

## 12. V1 不提供

V1 不提供 Static App 的 Resource Session/Open Resource、宿主文件遍历、父页面 API、窗口
控制、自动提交、跨 Instance 合并、多容器编排、私有 registry 凭据流程或任意宿主权限。
遇到这些需求时应记录为协议外依赖，不要发明私有兼容字段。
