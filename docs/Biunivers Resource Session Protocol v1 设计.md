# Biunivers Resource Session Protocol v1 设计

状态：设计草案，逻辑闭环评审通过，待施工评审

日期：2026-07-29

建议协议标识：`biunivers.resource-session/1`

## 1. 目标

本协议为合法、已启用的 Biunivers 第三方应用提供持续使用已交付资源的简单机制，解决
Host API v1 一次性完整传输不适合大型文件、随机读取和长期编辑的问题。

核心规则只有四条：

1. 已安装且启用的应用，可以接收其已注册 Handler 匹配的对象；
2. 宿主实际把某个对象交给应用时创建资源会话；
3. 应用建议每 60 秒批量续租，超过 300 秒未续租则会话终止；
4. 会话有效期间允许按权限反复读取、Range 读取和保存，不为每次请求重新签发授权。

本协议是 Host API v1 和 Open Resource Protocol v1 之外的独立扩展，不修改两个 V1 原文，
也不改变静态应用安装协议。

## 2. 非目标

第一版不定义：

- 目录授权或文件系统枚举；
- 因 Handler 声明而批量授予全部同类型文件；
- 后台常驻应用；
- 跨应用转让会话；
- 多文件原子事务；
- 原生 `<video src>` 的无请求头 URL capability；
- S3 URL、对象 Key、FID、Ref 或凭据暴露；
- 跨宿主重启恢复资源会话；
- 多用户和跨设备授权同步。

## 3. 资格、路由与对象授权

### 3.1 合法应用

能够使用资源会话的应用必须同时满足：

- 通过 Biunivers 管理流程安装；
- 当前状态为 `active`；
- 从宿主分配给该 app ID 的独立 Origin 运行；
- 声明并通过校验的 Handler 与本次对象和操作匹配；
- 使用宿主签发、可识别该 app ID 的运行凭据。

传统 `apps.json` iframe、external 页面和任意远程网页不能取得资源会话。internal 应用使用
内部接口，不冒充第三方协议客户端。

### 3.2 Handler 是资格，不是枚举权限

应用启用后，视为用户允许它处理已注册类型。Handler 决定宿主能否把对象路由给该应用，
但不允许应用：

- 枚举所有匹配类型的文件；
- 根据 Entry ID、名称、扩展名或错误差异猜测文件；
- 主动领取尚未由宿主交付的对象；
- 通过声明通配类型扩大文件系统可见范围。

### 3.3 会话创建入口

只有以下两类既有入口可以创建初始资源会话：

1. 用户在文件管理器、桌面或“打开方式”中把具体对象交给匹配应用；
2. 应用发起宿主文件选择，用户明确选择具体对象或保存目标。

路由打开时不再把一次性文件 handle 视为长期模型；宿主直接为目标 app ID 创建待领取的
资源会话。成功领取后，应用可在租约内持续使用该对象。

## 4. 会话模型

资源会话至少包含以下服务端状态：

```text
sessionId
appId
resourceType
resourceHandle
access
contentVersion
createdAt
lastRenewedAt
expiresAt
```

其中：

- `sessionId` 是不可猜测的不透明标识；
- `resourceHandle` 是宿主内部稳定对象引用，不能向应用暴露 Entry ID；
- `access` 第一版为 `read` 或 `edit`；
- `contentVersion` 是创建时的不可变内容快照；
- `expiresAt = lastRenewedAt + 300 秒`，以宿主时钟为准。

会话只保存在服务端内存，不写入浏览器长期存储、应用配置、URL、日志或 `/data`。宿主重启
后全部失效。

资源会话不依赖窗口显示、最小化、活动或关闭状态。应用停止续租后，宿主最多保留 300 秒；
应用主动释放时立即回收。

数据请求使用固定宿主端点，并把 `sessionId` 放在专用请求头而不是 URL。例如：

```http
GET /api/v1/resource-content
Authorization: Biunivers-Instance <app-runtime-token>
Biunivers-Resource-Session: <session-id>
Range: bytes=0-1048575
```

资源会话标识与应用运行凭据必须同时有效；只有其中一个不能访问数据。

## 5. 续租协议

### 5.1 批量续租

应用建议每 60 秒声明仍需使用的全部资源：

```json
{
  "protocol": "biunivers.resource-session/1",
  "method": "resource.renew",
  "params": {
    "sessionIds": ["opaque-session-1", "opaque-session-2"]
  }
}
```

成功响应返回宿主计算的新过期时间：

```json
{
  "renewed": [
    {
      "sessionId": "opaque-session-1",
      "expiresAt": "2026-07-29T18:05:00.000Z"
    }
  ],
  "rejected": []
}
```

续租必须满足：

- 调用方 app ID 与会话 app ID 一致；
- 应用仍处于启用状态；
- 会话尚未过期；
- 同一批次重复声明保持幂等；
- 一个会话失败不阻止同批其他合法会话续租；
- 过期会话不能通过续租复活，必须重新走对象交付流程。

`rejected` 只返回调用方提交的 session ID 及统一原因，不泄露其他应用或对象是否存在。

### 5.2 资源活动隐式续租

每次成功的元数据读取、完整读取、Range 读取或保存也更新 `lastRenewedAt`。显式续租用于应用
长时间编辑、暂停或持有资源但没有数据请求的场景。

请求开始时会话必须有效。已经接受的流式读取或写入可以在会话到期点之后完成，完成时若应用
仍启用则把该次活动记为续租；停滞连接仍受服务器传输超时限制。

### 5.3 释放与撤销

`resource.release` 接受一个或多个 session ID，重复释放已经不存在的会话视为成功。

以下事件立即撤销应用的全部资源会话：

- 应用被停用；
- 应用被卸载；
- 应用更新到新 commit。

重新启用或更新完成不会恢复旧会话。宿主重启同样使全部会话失效。

## 6. 通用读取

### 6.1 元数据

应用可在会话有效期内读取名称、大小、修改时间、媒体类型提示、权限和不透明内容版本。
不得返回路径、FID、S3 Key、Ref 或其他实现细节。

### 6.2 完整与区间 GET

同一资源会话允许多次 GET：

- 不带 `Range`：返回 `200 OK` 和完整内容；
- 合法单区间 `Range`：返回 `206 Partial Content`；
- 不满足的区间：返回 `416 Range Not Satisfiable`；
- 第一版拒绝多区间请求，不生成 `multipart/byteranges`。

区间响应必须包含：

```http
Accept-Ranges: bytes
Content-Range: bytes <start>-<end>/<total>
Content-Length: <returned-bytes>
Content-Type: <known-media-type-or-application/octet-stream>
Cache-Control: no-store
```

`416` 响应包含：

```http
Content-Range: bytes */<total>
```

CORS 必须允许 `Range` 请求头，并向目标应用 Origin 暴露 `Accept-Ranges`、`Content-Range`
和 `Content-Length`。CORS 同时允许 `Authorization` 和
`Biunivers-Resource-Session` 请求头。每次请求仍须同时验证应用运行凭据、app ID、Origin
和资源会话。

### 6.3 不可变快照

读取始终绑定会话创建时的 `contentVersion`。其他应用随后保存新版本、移动、重命名或删除
当前 Entry，不改变正在读取的字节：

- 移动和重命名不影响会话；
- 外部保存后旧会话继续读取旧内容；
- 删除后已授权会话仍可读到租约终止，行为等同已打开文件；
- 删除或外部修改后，原会话不能把编辑结果静默覆盖回当前文件系统。

底层根据 Manifest 和固定 64 MiB Chunk 计算请求覆盖范围，只读取必要 Chunk，并裁剪首尾，
不下载完整大文件。

## 7. 保存与冲突

`edit` 会话在租约内允许多次完整 PUT。每次保存：

1. 接收并流式写入新的不可变 Chunk/Manifest；
2. 使用会话当前预期内容版本执行文件事务 CAS；
3. 成功后发布新 Ref，并把会话推进到新内容版本；
4. 失败时保留旧 Ref 和应用提交前的会话版本；
5. 外部修改、删除或 Ref 竞争返回 `FILE_VERSION_CONFLICT`。

第一版不定义区间写入。随机读取不意味着随机覆盖，避免把不可变内容模型变成块设备。

保存目标会话在首次 PUT 成功前不创建可见空文件。租约到期、应用停用或上传失败都不留下
可见文件；首次成功后转为普通文件资源会话。

## 8. 错误

应用至少处理：

- `RESOURCE_SESSION_NOT_FOUND`：会话不存在或不属于当前应用；
- `RESOURCE_SESSION_EXPIRED`：超过租约，重新走打开/选择流程；
- `RESOURCE_SESSION_REVOKED`：应用状态变化或管理员撤销；
- `RESOURCE_ACCESS_DENIED`：会话不允许本次操作；
- `RANGE_INVALID`：Range 语法、多区间或上限不受支持；
- `FILE_VERSION_CONFLICT`：保留应用内容，重新打开或另存为；
- `HOST_API_UNSUPPORTED`：宿主未实现本扩展。

错误不能区分“属于其他应用”“未授权对象”和“随机 session ID”，避免成为探测接口。

## 9. 兼容与发现

- Host API v1 的 handle 和一次性 transfer 保持原样；
- Open Resource Protocol v1 的 Launch Context 保持原样；
- 新应用可以优先请求 `biunivers.resource-session/1`，不支持时回退 Host API v1 完整传输；
- 宿主不得用私有字段改变两个既有 V1 协议；
- 正式施工前应把能力发现方式和消息 Schema 固定到开发者包。

## 10. 闭环评审

### 10.1 记事本

用户打开 TXT 后获得 `edit` 会话；长时间编辑由 60 秒续租保持，重复保存使用同一会话。
外部修改触发 CAS 冲突，旧版本不被覆盖。关闭文档时主动释放；崩溃后最多 300 秒自动释放。

结论：闭环。

### 10.2 WASM 视频播放器

用户打开 MKV 后获得 `read` 会话；播放器读取文件头和索引，再使用单区间 Range 按需取
Chunk。拖动进度条只读取目标时间附近字节，连续数据访问自动续租，暂停时显式续租。

本协议支持 JavaScript fetch、WASM ffmpeg 和 Media Source Extensions。原生
`<video src>` 不能携带自定义认证头，明确不在第一版承诺内。

结论：WASM 播放器闭环；原生 video URL 另案设计。

### 10.3 应用状态变化

停用、卸载或更新立即撤销全部会话；新的应用版本必须重新领取对象。应用保持启用时，只要
按期续租，就不因窗口显示状态变化丢失授权。

结论：闭环。

### 10.4 浏览器冻结、休眠和断网

短暂网络故障只要在 300 秒内恢复即可续租。冻结、休眠或断网超过 300 秒后会话过期，恢复
后的首次请求得到明确错误，应用提示重新打开资源。会话不能静默复活。

结论：闭环，代价明确。

### 10.5 文件生命周期

稳定对象引用保证移动和重命名不打断会话；不可变内容快照保证播放期间字节不变化；删除后
允许已打开会话读到租约结束，但禁止重新领取和保存覆盖；外部保存触发编辑冲突。

结论：闭环。

### 10.6 授权边界

应用启用与 Handler 匹配只授予接收资格，宿主交付具体对象才创建会话。应用不能通过续租、
类型声明或 Range 请求扩大到其他对象。每次请求重新核对应用状态和会话归属。

结论：闭环。

## 11. 评审结论

本设计用一个应用级资源租约替代请求级一次性授权，避免依赖窗口显示状态，同时保留对象范围
和应用隔离。60 秒建议续租、300 秒硬过期、批量声明、资源活动隐式续租和应用状态即时撤销
覆盖了正常使用与失败回收。

第一版施工前没有阻断性的业务或安全疑问。仍需在技术设计中确定的实现细节只有：

- 消息和 HTTP Schema 的最终字段名；
- Range 到 Chunk 的边界测试矩阵；
- 服务端会话数量和并发的运维上限；
- 现有 Host API v1 客户端的渐进迁移顺序。

这些事项不改变协议核心语义，不需要引入窗口生命周期、一次性读取或媒体专用权限模型。
