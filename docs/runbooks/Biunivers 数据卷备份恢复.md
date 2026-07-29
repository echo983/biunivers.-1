# Biunivers 数据卷备份与恢复

适用版本：`v0.7.0`

## 1. 备份范围

`/data` 是宿主本地权威状态，至少包含：

- 已安装应用的注册表和静态文件；
- Desktop Surface SQLite；
- File Service RefStore SQLite、备份和 GC 报告。

S3 只保存不可变对象，不能替代 `/data` 备份。部署使用的环境变量或 secret 文件不在数据卷
中，应通过独立的 secret 管理方式备份，不能写入本归档或提交到 Git。

## 2. 一致性备份

以下示例假设容器名为 `biunivers`，数据卷名为 `biunivers-data`。先停止写入，再创建归档：

```bash
docker stop biunivers
docker run --rm \
  -v biunivers-data:/data:ro \
  -v "$PWD":/backup \
  alpine:3.22 \
  tar -czf /backup/biunivers-data-v0.7.0.tar.gz -C /data .
docker start biunivers
```

确认归档可读：

```bash
tar -tzf biunivers-data-v0.7.0.tar.gz >/dev/null
```

应把归档复制到宿主之外，并按照实际风险加密保存。备份期间 S3 不需要暂停；不可变对象不会被
原地改写。

## 3. 非破坏性恢复演练

不要覆盖当前卷。创建新卷并恢复：

```bash
docker volume create biunivers-data-restored
docker run --rm \
  -v biunivers-data-restored:/data \
  -v "$PWD":/backup:ro \
  alpine:3.22 \
  tar -xzf /backup/biunivers-data-v0.7.0.tar.gz -C /data
```

然后用不同容器名和端口启动恢复实例，并传入与原实例一致的 File Service namespace、S3
位置和凭据。先检查两个 `/health` 端点和管理员 File Service 状态，再进行文件读取验证。

同一个 File Service namespace 只能有一个写者。原实例仍在运行时，恢复演练实例必须使用
只读/隔离凭据，或者保持 File Service 关闭；不能让两个实例同时写入同一 lineage。

## 4. 正式切换原则

1. 停止原实例；
2. 保留原数据卷，不删除；
3. 使用恢复卷和原配置启动新实例；
4. 验证应用注册表、桌面布局、目录树和文件内容；
5. 验证完成后再切换反向代理；
6. 原卷至少保留到新实例经过一个完整备份周期。

File Service RefStore 的独立诊断、在线备份和内容扫描见
[File Service RefStore 备份恢复](<File Service RefStore 备份恢复.md>)。
