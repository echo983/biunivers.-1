# Debian 更新与失败回滚

状态：V0.16 施工期运行手册
日期：2026-08-06

## 更新命令

安装器会安装：

```text
/usr/local/sbin/biunivers-update
```

更新到 GitHub 最新稳定 SemVer Release：

```bash
sudo biunivers-update
```

更新到明确版本：

```bash
sudo biunivers-update --version v0.16.1
```

用已经下载的 Release 资产离线更新：

```bash
sudo biunivers-update \
  --version v0.16.1 \
  --release-dir ./release
```

`--release-dir` 必须与明确版本一起使用。更新器拒绝 prerelease、版本倒退、checksum 错误、镜像
digest 不一致、架构不兼容和不接受当前 RefStore schema 的 Release。

## 更新事务

所有有风险的操作都发生在 Host 和 Compute Runtime 受控停止后：

1. 下载并校验 Runtime，预拉取两个 digest 固定的 OCI 镜像；
2. 检查本地 data 大小和保守的可用空间要求；
3. 受控停止 Host，再停止 Runtime；
4. 把当前 `data` 原子移动到本次备份目录；
5. 使用 reflink（文件系统支持时）或普通复制产生新版本工作副本；
6. 切换 release record、systemd unit、更新器和 `current` symlink；
7. 启动新 Runtime 与 Host；
8. 检查 Host `/health` 和 File Service `ready`；
9. 通过后写入 `COMMITTED`。

备份位于：

```text
/var/lib/biunivers/backups/<UTC>-<旧版本>-to-<新版本>/
├── config/
├── data/
└── result
```

更新不会复制 S3 不可变对象，也不会移动或删除 `/var/lib/biunivers/runtime/runs` 中的未决 Upper。

## 自动失败回滚

健康门禁前的任一事务错误会：

1. 停止新 Host 与 Runtime；
2. 把新版本 data 移到本次备份的 `failed-data/`；
3. 原子恢复升级前 data；
4. 恢复旧 release record、unit 和 `current` symlink；
5. 尝试重新启动旧版本；
6. 写入 `ROLLED_BACK`。

失败副本被保留而不是删除，便于检查迁移或启动期间发生的变化。S3 在门禁期间产生的新不可变
对象不会覆盖旧对象；恢复旧 RefStore 后，它们只是未来 GC 候选。

查看结果：

```bash
sudo find /var/lib/biunivers/backups -mindepth 2 -maxdepth 2 -name result -print -exec cat {} \;
sudo journalctl -u biunivers-runtime -u biunivers-host --no-pager -n 200
```

## 边界

- 自动回滚只适用于尚未通过健康门禁的更新事务；
- 新版本已经成功使用并产生用户写入后，不提供一键数据倒退；
- 更新器只接受更高 SemVer，不把“降级程序”和“恢复旧数据”混成一个按钮；
- 旧备份不会被更新器自动清理；确认新版本稳定后再由主人显式归档或删除；
- 空间检查按完整 data 副本计算，即使底层文件系统支持 reflink 也不降低门槛；这是有意的保守策略。
