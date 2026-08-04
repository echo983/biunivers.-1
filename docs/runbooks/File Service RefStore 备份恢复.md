# File Service RefStore 备份与恢复

## 适用范围

RefStore 默认位于 `/data/file-service/file-service.sqlite`。它保存当前 Head、快照和发布点，
不保存文件内容。S3 不保存可变 Ref，因此丢失 RefStore 后不得用 S3 LIST 猜测当前状态。

## 备份

运行中的服务必须通过 `SqliteRefStore.backupTo(destination)` 创建在线一致性备份，不能直接
复制 WAL 模式下的 `.sqlite` 主文件。备份实现会：

1. 使用 SQLite Online Backup API 写入同目录临时文件；
2. 对临时备份执行 `quick_check`、schema version 和必需表校验；
3. 校验通过后原子重命名到目标路径。

可信桌面可以在服务运行时触发受控备份；命令行运维需显式声明桌面同源请求：

```sh
curl -X POST \
  -H 'Origin: http://localhost:8080' \
  -H 'Sec-Fetch-Site: same-origin' \
  http://localhost:8080/api/v1/control/file-service/backups
```

宿主不接受调用方提供的文件路径，只会原子更新
`/data/file-service/backups/latest.sqlite`。接口返回备份的 revision、根 Entry ID、大小和生成时间；
返回成功前还会独立打开备份，并从对象存储验证其 Ref → Head → checkpoint 链。`latest.sqlite`
是滚动备份；需要保留历史版本时，由运维在成功后复制到独立备份介质。

备份介质还应记录非 secret S3 endpoint、region、bucket 和 prefix。Access Key 与 Secret
应通过独立 secret 管理恢复，不写入备份说明或日志。

## 恢复

1. 停止 Biunivers，确认没有进程持有 RefStore。
2. 保留损坏数据库及其 `-wal`、`-shm` 文件用于诊断，不在原位修改。
3. 将最近一次已验证备份复制到新的持久卷路径。
4. 使用 `SqliteRefStore.openExisting(path)` 校验备份；禁止调用 `initialize`。
5. 读取每个 Ref，并从不可变对象存储获取对应 Head。
6. 验证 Head FID、lineage ID 和 revision 与 Ref 完全一致。
7. 全部验证通过后才允许 File Service 写入；失败时保持离线或只读。

从恢复实例启动后，可在项目根目录运行只读内容扫描：

```sh
docker exec -i <恢复容器名> node --input-type=module \
  < scripts/verify-file-service-recovery.mjs
```

该脚本遍历当前 checkpoint 中的所有文件，从对象存储读取 Manifest 和 Chunk，并通过正常的
Repository 读取路径重新校验每个对象的 XXH3-128 FID。只有全部文件的实际读取长度与元数据
一致时，`allVerified` 才为 `true`。

恢复备份可能回到较早 Head。备份之后上传到 S3、但从未被恢复 Ref 引用的对象是不可达对象；
V1 只报告，不自动删除。

## 只读 GC 报告

可信桌面可触发一次完整可达性扫描：

```sh
curl -X POST \
  -H 'Origin: http://localhost:8080' \
  -H 'Sec-Fetch-Site: same-origin' \
  http://localhost:8080/api/v1/control/file-service/gc-reports
```

扫描根包括当前 `main` Ref 和其快照。扫描器沿父 Head 历史遍历 Head、Segment、Checkpoint、
Manifest 与 Chunk，并与对象存储 inventory 比较。响应中的 `candidates` 仅表示本次完整扫描
不可达；根集合在同一个 SQLite 读事务中取得。候选总数和字节数始终完整，FID 明细每类最多
返回 1,000 条，超出时 `candidateFidsTruncated` 为 `true`。`deletionAllowed` 永远为
`false`。V0.1 没有删除接口，也不要求对象存储凭据拥有 `DeleteObject` 权限。
