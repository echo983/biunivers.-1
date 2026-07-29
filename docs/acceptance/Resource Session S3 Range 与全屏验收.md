# Resource Session S3 Range 与全屏验收

- 日期：2026-07-29
- 结果：通过
- 分支：`fix/iframe-fullscreen-permission`
- 验收应用：`echo983/biunivers-wildplay`
- 存储：Cloudflare R2 S3 兼容对象存储

## 已验证

1. 受管第三方 iframe 获得显式 fullscreen 权限；
2. WildPlay 可由用户手势进入和退出全屏；
3. Resource Session 单区间请求返回准确的 206、`Content-Range` 和 `Content-Length`；
4. 文件 Range 被映射到 Manifest 中相交的 Chunk 局部区间；
5. S3 ObjectStore 使用精确的 `GetObject Range: bytes=start-end`；
6. S3 返回的 `Content-Range`、`Content-Length` 和实际字节长度均经过校验；
7. 跨 64 MiB 边界的四字节读取只读取前后两个 Chunk 中各两字节；
8. 真实 R2 上约 100 MiB MP4 的多次 Seek 延迟明显下降，不再按每次 64 MiB 下载。

## 完整性边界

完整对象读取继续按 XXH3-128 FID 验证。局部 Range 无法单独重算完整对象 FID，因此依赖：

- 已验证 Manifest 或直接 Chunk 引用中的已知长度；
- 不可变对象 Key；
- 受信任 S3/TLS 边界；
- 精确响应范围和长度校验；
- 备份恢复、完整读回与审计路径中的完整 FID 复核。

该边界不改变持久格式、FID 或 64 MiB Chunk 规则。
