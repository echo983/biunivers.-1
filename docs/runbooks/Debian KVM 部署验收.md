# Debian KVM 部署验收

状态：V0.16 验收夹具已就绪，等待真实 Release
日期：2026-08-06

## 目标

在不接触开发机现有 Docker、RefStore 和 S3 本地状态的前提下，用官方 Debian cloud image 和
KVM 验收正式 Release：

- Debian 12、Debian 13；
- checksum 固定的干净 cloud image；
- 安装器依赖安装和首次 genesis；
- Host/Runtime systemd 启停顺序；
- Host 容器非 root、非 privileged 且没有 Docker socket；
- File Service ready；
- 系统重启后服务和 Ref 状态恢复；
- 后续 BWA/PVLogFS 真实 Run 与更新事务。

Docker 容器不能替代这项验收：Compute Runtime 的 FUSE mount 必须位于宿主可见的 mount
namespace，并且需要验证真实 systemd reboot。

## 开发机依赖

Debian/Ubuntu 开发机安装：

```bash
sudo apt update
sudo apt install qemu-system-x86 qemu-utils cloud-image-utils
```

当前用户还必须能读写 `/dev/kvm`。夹具不会使用当前 Docker daemon。

## 准备干净虚拟机

Debian 12：

```bash
bash scripts/prepare-debian-deployment-vm.sh 12
```

Debian 13：

```bash
bash scripts/prepare-debian-deployment-vm.sh 13
```

脚本从 `cloud.debian.org` 下载 `latest` 目录中的 genericcloud amd64 镜像，但在使用前必须按同一
目录的 `SHA512SUMS` 验证，并输出实际 SHA-512 作为验收记录。磁盘使用 qcow2 backing overlay，
默认 4 vCPU、4 GiB 内存和 32 GiB 虚拟容量。

状态、SSH 私钥、cloud-init seed、overlay 和串口日志位于已忽略的：

```text
secret/debian-deployment-vm-12/
secret/debian-deployment-vm-13/
```

需要重复“干净安装”时，应使用新的 `BIUNIVERS_VM_STATE_ROOT`，不要复用已经安装过的 overlay。

## 验收正式 Release

准备一个只供 disposable VM 使用的 File Service 环境文件，不得指向生产 namespace。然后运行：

```bash
bash scripts/verify-debian-deployment-vm.sh \
  12 \
  v0.16.0 \
  ./release \
  ./secret/biunivers-vm.env
```

脚本把固定 Release 资产和环境文件复制到 VM，运行正式安装器，校验权限与服务，然后真实 reboot
并比较重启前后的 File Service 状态。成功后会删除 VM `/tmp` 中的 Release 和环境文件；正式
配置仍按设计保存在 VM `/etc/biunivers`。

Debian 13 使用相同命令，把第一个参数改为 `13`。

## 停止虚拟机

```bash
bash scripts/stop-debian-deployment-vm.sh 12
bash scripts/stop-debian-deployment-vm.sh 13
```

停止脚本只请求 guest 正常关机。60 秒内没有退出时会报错并保留 QEMU 进程，不会自动强杀或
删除磁盘。

## 当前验收边界

夹具的安装、权限、双端口健康、File Service 和 reboot 检查已通过静态门禁。真实执行必须等
固定 tag 的 GHCR 镜像和 GitHub Release 资产存在。BWA/PVLogFS 真实 Run 和成功/失败更新将
在同一 disposable VM 上继续验收，并写入 V0.16 里程碑记录。
