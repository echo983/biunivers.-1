# BWA Host 与 Compute Runtime 部署

日期：2026-07-31

## 1. 第一版部署拓扑

Biunivers Workspace Application 使用以下 Linux 拓扑：

```text
Biunivers Host 容器
├── Desktop / Manager / Runtime Proxy
├── bind mount：绝对 DATA_ROOT → 相同绝对路径
└── Unix socket：/var/tmp/biunivers-bwa-<uid>/runtime.sock

Linux 宿主 Compute Runtime
├── PVLogFS / fuse-overlayfs
├── Docker CLI → 宿主 Docker daemon
├── 同一个 DATA_ROOT
├── 短路径状态根：/var/tmp/biunivers-bwa-<uid>
└── 创建无 published port 的 BWA 容器
```

Host 容器不获得 Docker socket、`SYS_ADMIN`、`/dev/fuse` 或 privileged 权限。Compute Runtime
作为系统执行部件运行在宿主，使用随机 256 位令牌保护 Unix socket 控制面。

## 2. 为什么不使用普通 sidecar

Compute Runtime 创建 FUSE mount 后，宿主 Docker daemon 必须能把同一路径挂载进 BWA
容器。普通 sidecar 的 mount namespace 和命名卷路径对宿主 daemon 不可见，会出现：

- 容器内路径与宿主路径不一致；
- FUSE mount 未传播到宿主；
- BWA 得到空目录或无法创建 bind mount。

除非部署者显式设计相同绝对 bind 路径和 shared mount propagation，否则不要把 Runtime
改成普通 Compose sidecar。第一版选择宿主 Runtime，边界更窄也更容易审计。

## 3. 产品测试启动

前置条件：

- Node.js 24；
- Rust/Cargo；
- Docker 与当前用户的 Docker 权限；
- `fuse-overlayfs`、FUSE 3 和 `fusermount3`；
- 已配置 `secret/biunivers-test.env`；
- 一个已有且可备份的 File Service RefStore。

运行：

```bash
bash scripts/run-bwa-product-test.sh
```

脚本会：

1. 首次运行时优先从当前 `biunivers-v02-test` 获取在线一致性 RefStore 备份；容器已正常停止时，回退到只读迁移 `biunivers-v02-test-data` 数据卷；
2. 在 `secret/bwa-product-data` 建立宿主可见的数据根；
3. 构建 PVLogFS、COW scanner、Host 镜像和诊断镜像；
4. 生成并持久保存 Runtime 控制令牌；
5. 启动宿主 Compute Runtime；
6. 把 Host 容器加入 `biunivers-bwa` 私有 bridge；
7. 以当前宿主 UID/GID 启动 Host，使其能够访问 `0600` Unix socket。

停止：

```bash
bash scripts/stop-bwa-product-test.sh
```

停止脚本先关闭 Host，再向 Runtime 发送 `SIGTERM`。Runtime 会对仍在运行的 BWA 执行受控
停止和提交；超过 30 秒不会强制杀死，而是要求管理员检查日志，避免静默丢弃 Upper。

## 4. 数据与凭据

默认本地状态均位于已忽略的：

```text
secret/bwa-product-data/
├── file-service/file-service.sqlite
├── private/bwa-secrets.json
└── compute-runtime/
    ├── auth-token
    └── runtime.log

/var/tmp/biunivers-bwa-<uid>/
├── runtime.sock
├── runs/
└── chunk-cache/
```

Run manifest、异常 Upper、mount point 和 gateway socket 使用短状态根，是为了满足 Linux
Unix socket 107 字节路径上限。Upper 仍需保留到正常提交或显式丢弃，不能在 Runtime 运行中
手工删除。可用 `BIUNIVERS_BWA_RUNTIME_STATE` 指定另一个足够短的绝对路径。

不得提交该目录、环境文件、Runtime token、S3 key 或 BWA secret。备份仍以 File Service
RefStore 备份和 S3 不可变对象为准；Runtime cache、socket 和容器本身不是持久数据。

## 5. 故障检查

```bash
docker logs biunivers-v02-test
tail -n 100 secret/bwa-product-data/compute-runtime/runtime.log
curl http://localhost:8080/health
curl -H 'Authorization: Bearer <admin-token>' \
  http://localhost:8080/api/v1/admin/bwa
```

如果 Host 能启动但 BWA 无法打开，依次检查：

1. `biunivers-bwa` 网络存在；
2. Host 容器已加入该网络；
3. Runtime socket 的属主与 Host 容器 UID 一致；
4. `/health` 是否在 BWA 容器内监听 `0.0.0.0:8080`；
5. Runtime 日志是否报告 FUSE、Docker 或 RefStore 错误。
