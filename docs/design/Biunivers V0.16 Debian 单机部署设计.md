# Biunivers V0.16 Debian 单机部署设计

状态：发布候选
日期：2026-08-06
目标版本：V0.16

## 1. 目标

为一台新安装的 Debian 主机提供一条可重复、可诊断、可升级的 Biunivers 正式安装路径。
部署者应能从 GitHub 的稳定 Release 安装固定版本，并由 systemd 管理 Host 与 Compute
Runtime；升级失败不得破坏原版本或用户数据。

第一版只支持：

- Debian 12、Debian 13；
- x86_64；
- 单机、单一主人、单个 Biunivers 实例；
- Docker、FUSE 3 与 `fuse-overlayfs`；
- 外部已有的 S3 兼容对象存储；
- 由部署者另行提供的 HTTPS、域名和入口访问控制。

不支持多节点、HA、Kubernetes、私有镜像仓库登录、自动 DNS/TLS、无人值守自动升级和
Debian 以外发行版。它们不是当前产品闭环的必要条件。

## 2. 保持现有执行边界

正式部署沿用已经实测的拓扑，不把 Compute Runtime 改成普通 sidecar：

```text
systemd
├── biunivers-runtime.service
│   └── 宿主 Compute Runtime
│       ├── PVLogFS / fuse-overlayfs
│       ├── Docker CLI → Docker daemon
│       └── /run/biunivers/runtime.sock
└── biunivers-host.service
    └── 无特权 Host 容器
        ├── Desktop / File Service / BWA Manager
        ├── 相同绝对路径 bind mount
        └── Unix socket + 随机 256 位令牌
```

Host 容器不得获得 Docker socket、`/dev/fuse`、`SYS_ADMIN` 或 privileged。Compute Runtime
作为专用宿主用户运行，只有它能创建 FUSE mount 和 BWA 容器。Host 与 Runtime 通过 Unix
socket 通信，继续使用随机令牌做双重约束。

## 3. 主机目录

```text
/opt/biunivers/
├── current -> releases/v0.16.0
└── releases/
    └── v0.16.0/
        ├── node/bin/node
        ├── app/                 # Runtime 所需 JS 与 production node_modules
        ├── bin/biunivers-pvlogfs
        ├── bin/biunivers-workspace-cow-scan
        └── release.json

/etc/biunivers/
├── biunivers.env               # 普通部署配置与 S3 凭据，0640 root:biunivers
├── release                     # 当前固定版本和 Host 镜像 digest
└── runtime-token               # 随机 256 位令牌，0640 root:biunivers

/var/lib/biunivers/
├── data/                       # RefStore、BWA secret、桌面状态
└── runtime/runs/               # Run manifest、Upper、挂载工作目录

/var/cache/biunivers/chunks/    # 可重建的 PVLogFS chunk cache
/run/biunivers/runtime.sock     # 重启可丢弃的控制 socket
```

`/opt/biunivers/releases/<version>` 安装完成后不可变。版本切换只原子替换 `current` 软链接。
`data`、`runtime/runs` 和配置不放进版本目录，升级不得删除。生产标准路径足够短，Run 下的
`gateway.sock` 不会超过 Linux Unix socket 路径上限。

首版使用系统用户 `biunivers`。安装器把它加入 `docker` 组，并只为所需目录授予读写权限。
这是 Compute Runtime 使用宿主 Docker daemon 所需的高权限边界，文档必须明确说明；普通
Host 容器仍以同一数值 UID/GID 的非 root 用户运行。

配置和令牌必须让以 `biunivers` 身份运行的包装器读取，因此使用 `root:biunivers 0640`，而不是
不可读的 `root:root 0600`；其他本地用户没有读取权限。

## 4. systemd 拓扑

### 4.1 `biunivers-runtime.service`

- `Requires=docker.service`，并在 Docker 和网络就绪后启动；
- 使用 `/opt/biunivers/current/node/bin/node` 启动 Compute Runtime CLI；
- 从 `/etc/biunivers/biunivers.env` 和 `runtime-token` 读取配置；
- 使用固定的 data、runs、cache、socket 和两个 Runtime 二进制路径；
- `Restart=on-failure`，但限速重启；
- `TimeoutStopSec` 至少 45 秒，使运行中的 BWA 有机会受控停止、提交或保留 Upper；
- 超时不静默删除 Run、Upper 或 Workspace 改动。

### 4.2 `biunivers-host.service`

- `Requires=biunivers-runtime.service` 且 `After=biunivers-runtime.service`；
- 以固定 digest 的 Host 镜像运行固定名称容器；
- bind mount `/var/lib/biunivers` 与 `/run/biunivers` 到容器内完全相同的绝对路径；
- 不挂载 Docker socket，不添加 capability；
- 只发布配置指定的 Desktop 与 Apps 端口；
- `ExecStop` 先正常停止 Host 容器。

systemd 按依赖关系逆序停止，因此 Host 先停，Runtime 后停。这与现有产品测试的受控关闭
顺序一致。首版不增加自定义 target；启停 Host unit 即可由依赖关系带动 Runtime，少维护一个
没有独立语义的部署部件。

安装器首次启动前必须确保 `/etc/fuse.conf` 恰好存在一条 `user_allow_other`，并建立专用
Docker bridge。所有操作均应幂等。

## 5. GitHub Release 交付物

稳定 Release 的 tag 必须是完整 SemVer，例如 `v0.16.0`。安装器不从 `main` 构建，也不使用
浮动镜像 tag。

每个 Release 至少包含：

```text
biunivers-runtime-v0.16.0-linux-x64.tar.zst
biunivers-install-v0.16.0.sh
SHA256SUMS
```

同时发布并记录：

```text
ghcr.io/echo983/biunivers:v0.16.0
ghcr.io/echo983/biunivers@sha256:<digest>
ghcr.io/echo983/biunivers-runtime-diagnostic:v0.16.0
ghcr.io/echo983/biunivers-runtime-diagnostic@sha256:<digest>
```

Runtime 压缩包在与 Debian 兼容的 glibc x86_64 构建环境中产生，包含固定 Node 24 runtime、
已经构建的 server 产物、generated 产物、production dependencies（包括原生模块）、PVLogFS
和 COW scanner。目标机器不需要 npm、Cargo、Rust 或 wasm-pack。Host 与 Runtime 诊断执行器
镜像进入 GHCR，安装时拉取 tag 后核对 Release 声明的 digest，实际 systemd 配置固定使用
digest。诊断执行器也是 Compute Runtime 的必需依赖，不能留给部署者临时构建。

`release.json` 至少记录版本、架构、Node 版本、Host digest、诊断执行器 digest、RefStore schema
范围和构建 commit。它是安装和诊断元数据，不再引入另一套应用清单协议。

初始脚本下载仍有信任引导问题。正式文档优先给出“下载固定 tag 的安装器、核对
`SHA256SUMS`、再以 root 执行”的三步命令；可同时提供 `curl | sudo bash` 作为明确标注风险的
便捷路径，但不把它写成唯一方法。

## 6. 首次安装流程

安装器：

1. 拒绝不支持的 Debian 版本和架构；
2. 检查 root 权限、磁盘空间、systemd、内核 FUSE 和 CPU 架构；
3. 通过 Debian apt 安装 `docker.io`、`fuse3`、`fuse-overlayfs`、`curl`、`ca-certificates`、
   `zstd` 等必要包；
4. 下载指定稳定版本的 Runtime 包和校验文件并验证 SHA-256；
5. 拉取 Host 与诊断执行器 tag、核对两个 digest；
6. 创建系统用户、目录、令牌和 systemd unit；
7. 若用户传入 `--env-file`，校验权限后安装为 `biunivers.env`；否则生成不含真实 secret 的模板，
   明确提示填写后再启动；
8. 新数据目录在服务启动前执行一次显式 genesis 初始化，完成后固定改回
   `BIUNIVERS_FILE_INITIALIZE=false`；已有 RefStore 不得再次初始化；
9. 执行 `systemctl daemon-reload`，启动两个服务；
10. 等待 `/health` 和 File Service 状态；失败时输出对应 `journalctl` 命令并返回非零。

默认只监听 loopback，避免一个没有入口访问控制的桌面被意外暴露到公网。部署者完成反向代理、
HTTPS 和访问控制后，才按配置扩大监听范围。

安装器不通过写入测试对象探测 S3。Host 的真实只读初始化与 File Service 状态已经能发现多数
配置和读取故障；永久写入探测不是首版高必要项目。

## 7. 更新与失败回滚

提供 `sudo biunivers-update [--version v0.16.1]`。不传版本时只解析 GitHub 最新稳定 SemVer
Release，忽略 prerelease、draft 和 `main`。

更新事务：

1. 下载并验证新 Release，不触碰当前版本；
2. 拉取并核对新 Host 与诊断执行器 digest；
3. 拒绝不兼容的架构或显式不支持的 RefStore schema；
4. 受控停止 Host，再受控停止 Runtime；
5. 离线备份 `/var/lib/biunivers/data` 与 `/etc/biunivers` 的相关状态，并保留 Runtime Upper；
6. 安装新 release 目录，原子切换 `current` 和 release 记录；
7. 启动 Runtime、Host，执行有时限的健康门禁；
8. 通过后提交升级事务并保留上一版本及本次备份；
9. 失败时停止新版本，恢复旧软链接、旧 release 记录和升级前的本地状态，再启动旧版本。

S3 内容不可变，新版本在失败门禁期间留下的孤立对象不会覆盖旧对象；恢复 RefStore 后它们只是
未来 GC 候选。健康门禁通过之前不对外宣布升级成功。

自动回滚只属于“尚未成功的更新事务”。成功运行后再降级可能遇到 schema 演进和新写入，首版
不提供一键数据倒退。管理员可显式选择旧版本做兼容性降级，但工具不得自动恢复旧 RefStore、
不得静默丢弃升级后的文件或 Workspace 改动。

首版保留当前版本、上一个成功版本及最近一次升级前备份；更老版本清理由独立的显式命令完成，
不能在安装或更新成功路径中递归删除不明目录。

## 8. 配置、备份与卸载边界

- `biunivers.env` 和 `runtime-token` 不进入 Git、Release、日志或命令行参数；
- File Service RefStore、BWA secret 和环境配置都必须进入部署者的备份范围；
- S3 不可变对象不能替代本地控制状态备份；
- Runtime cache、socket 和可重建容器不是备份对象；
- 未决 Upper 是用户尚未处置的工作，应保留；
- `biunivers-uninstall` 默认只停服务并移除程序与 unit，保留 `/etc/biunivers` 和
  `/var/lib/biunivers`；删除数据必须使用独立、明确、二次确认的命令。

## 9. 闭环审查

### 9.1 已闭环

- Release 固定版本、校验和与镜像 digest 共同解决“装到什么”的确定性；
- 宿主 Runtime 与容器 Host 的启动、停止和依赖顺序明确；
- 同路径 bind mount、短 socket 路径和 UID/GID 一致性满足当前 BWA 实现；
- 配置、程序、持久数据、运行状态和缓存的目录边界明确；
- 首装缺配置、启动失败和更新失败都有统一诊断出口；
- 更新在新旧程序与本地 schema 状态之间形成有边界的事务；
- 卸载默认保留数据，不会把“移除程序”误做成“销毁个人文件系统”。

### 9.2 施工前仍需用自动测试固定的细节

- Runtime Release 包在干净 Debian 12/13 上的动态库依赖；
- Docker Debian 包的最低可用版本；
- systemd 停止超时与 BWA 受控提交的真实最坏耗时；
- 离线状态备份所需空间不足时的提前拒绝；
- Host 健康与 File Service ready 两级门禁的脚本返回码。

这些是实现验收项，不需要继续拆成新协议。

## 10. 明确推迟

- ARM64 和其他 Linux 发行版；
- apt 仓库、`.deb` 包和签名仓库；
- Cosign/Sigstore 镜像签名；
- 无人值守自动更新和自动清理；
- Nginx/Caddy、域名、证书、Cloudflare Access 的自动配置；
- 多实例、多用户、远程集群 Runtime；
- 在线 schema 降级和任意历史版本回滚。

V0.16 先交付一个可重复安装、systemd 可管理、失败可恢复的 Debian 单机路径。已有真实需求
出现后，再决定是否把相同 Release 产物包装成 `.deb` 或扩展到其他平台。

## 11. 当前施工进度

第一段已经落地：

- `scripts/build-debian-release.sh` 构建固定 Node 24、production dependencies、PVLogFS、COW
  scanner、Runtime server 和 `release.json`；
- 构建时在包内真实加载 `better-sqlite3` 与 `hash-wasm`，阻止原生模块 ABI 不匹配的包发布；
- `deploy/bin` 提供 Runtime 与 Host 启动包装器，token 不进入 unit 和命令行；
- `deploy/systemd` 固定 Host 先停、Runtime 后停的依赖关系；
- `scripts/verify-debian-release.sh` 检查 shell、systemd unit 和 Host 特权边界。

第二段也已落地：安装器会验证 checksum、双镜像 digest 与 RefStore schema，创建系统用户和
标准目录，通过内部 create-only CLI 完成首次 genesis，安装 systemd unit，并执行 Host 与 File
Service 两级健康门禁。安装器支持隔离 staging 验收和同一不可变版本续装；发现不同活动版本时
会拒绝覆盖，留给更新事务处理。

第三段也已落地：稳定 SemVer tag 驱动双 GHCR 镜像构建，在匿名环境按 digest 验证公开可拉取，
再进入 Debian 12 容器构建 Runtime 和 checksum，最后创建 GitHub Release。Release 重跑可以
补齐中断的资产，但正式交付后禁止用不同源码覆盖同名 tag。

第四段也已落地：`biunivers-update` 只接受更高稳定 SemVer，在停服后把旧 data 原子移入备份，
复制出新版本工作副本，并切换 unit、release record 和 symlink。健康门禁失败会恢复旧 data 和
程序控制状态，同时保留 `failed-data`；成功则保留升级前 data 和 `COMMITTED` 证据。

最后一段是在干净 Debian 12/13 虚拟机完成真实安装、重启、更新和失败回滚验收，再决定合并与
V0.16 里程碑发布。

KVM 验收夹具已经落地，使用 Debian 官方 genericcloud 镜像和同目录 SHA-512，隔离保存在
`secret/`。Debian 12 与 Debian 13 VM 已真实完成镜像校验、KVM 启动、cloud-init 和 SSH 基线；
正式 GHCR 镜像与 GitHub Release 尚未产生。因此最后阶段保持“等待真实 Release”，不以 VM
启动成功冒充 Biunivers 已完成干净安装验收。
