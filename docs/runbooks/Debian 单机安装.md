# Debian 单机安装

状态：V0.16 施工期运行手册  
日期：2026-08-06

## 支持范围

- Debian 12 或 Debian 13；
- x86_64；
- systemd；
- 单机、单一主人；
- 可访问的 S3 兼容对象存储。

正式 Release 发布前，本手册用于验证安装产物。不要把开发分支安装器当成已发布稳定版本。

## 构建本地 Release 产物

构建机需要 Node.js 24、npm、Rust/Cargo、`zstd` 和与 Debian 兼容的 glibc x86_64 环境：

```bash
BIUNIVERS_RELEASE_VERSION=v0.16.0 \
BIUNIVERS_RELEASE_HOST_DIGEST=sha256:<Host digest> \
BIUNIVERS_RELEASE_DIAGNOSTIC_DIGEST=sha256:<诊断执行器 digest> \
npm run build:debian-release
```

产物默认进入 `release/`。安装器拒绝缺少两个 digest、版本不一致或 checksum 不正确的产物。

## 准备配置

复制模板并填写：

```bash
cp deploy/biunivers.env.example biunivers.env
chmod 600 biunivers.env
```

必须替换 S3 endpoint、bucket、namespace、access key 和 secret key。公网部署还必须把两个 origin
改为真实 HTTPS origin，并由反向代理、VPN 或 Cloudflare Access 保护 Desktop Origin。

## 从本地 Release 安装

```bash
sudo bash deploy/install.sh \
  --version v0.16.0 \
  --release-dir release \
  --env-file ./biunivers.env
```

安装器将：

1. 检查 Debian 和架构；
2. 安装 Docker、FUSE 和必要工具；
3. 验证 Runtime checksum、Release 元数据和两个 OCI digest；
4. 创建 `biunivers` 系统用户及标准目录；
5. 对空数据目录执行一次 create-only File Service genesis；
6. 安装并启动 Host、Compute Runtime systemd 服务；
7. 检查 `/health` 与 File Service `ready`。

未传 `--env-file` 时，安装器只安装程序并生成 `/etc/biunivers/biunivers.env` 模板，不会用占位
凭据初始化。编辑模板后，使用相同版本重新执行安装器即可继续；同一不可变版本的续装是幂等的。
如果已有另一个活动版本，安装器会拒绝覆盖，必须走后续的 `biunivers-update` 更新事务。

## 管理与诊断

```bash
sudo systemctl status biunivers-runtime biunivers-host
sudo systemctl restart biunivers-host
sudo systemctl stop biunivers-host
sudo journalctl -u biunivers-runtime -u biunivers-host --no-pager -n 200
curl http://127.0.0.1:8080/health
sudo biunivers-update --version v0.16.1
```

Host 依赖 Runtime。正常关机时 systemd 先停 Host、后停 Runtime；Runtime 会受控处置运行中的
BWA。不要手工删除 `/var/lib/biunivers/runtime/runs` 中的 Upper。

Compute Runtime unit 有意不启用 `PrivateMounts`、`ProtectSystem`、`PrivateTmp` 或
`NoNewPrivileges`：PVLogFS/overlay mount 必须对宿主 Docker daemon 可见，`fusermount3` 也可能
需要发行版安装的权限转换。Host 容器仍不获得 Docker socket、FUSE、`SYS_ADMIN` 或 privileged。

## 隔离验证

安装器支持不接触系统的 staging 验证：

```bash
bash deploy/install.sh \
  --version v0.16.0 \
  --release-dir release \
  --root /tmp/biunivers-install-check \
  --stage-only
```

`--root` 只能与 `--stage-only` 一起使用，不能用于正式 chroot 安装。

更新事务、离线状态副本和失败自动回滚见
[Debian 更新与失败回滚](<Debian 更新与失败回滚.md>)。
