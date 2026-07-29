# Biunivers Resource Session Protocol v1

协议标识：`biunivers.resource-session/1`

状态：v1

固定协议原文文件名：`BIUNIVERS_RESOURCE_SESSION_PROTOCOL_V1.md`

## 1. 用途

本协议允许已安装且启用的 Biunivers 静态应用，在用户明确选择或打开一个文件后，持续读取
或保存该文件。它支持重复完整读取、单区间 HTTP Range 读取和可续租会话，适合文本编辑器、
音视频播放器等应用。

应用使用本协议时，必须把本文件原文不加修改地放在 GitHub 仓库根目录。文件存在只表示
应用已适配协议，不会自动授予任何文件。

## 2. 安全边界

- 应用必须从 Biunivers 分配给自身 app ID 的 Origin 运行；
- 请求必须来自应用 iframe，并由宿主按 `event.source` 和 Origin 校验；
- 应用只能取得用户交付或选择的具体文件；
- Handler 声明只是处理资格，不允许枚举同类型文件；
- `sessionId`、实例凭据和内容版本都是不透明值，不得解析、转交或写入 URL；
- 应用停用、卸载或更新后，会话立即撤销；
- 宿主重启后，会话失效。

## 3. 消息信封

应用通过 `window.parent.postMessage` 请求宿主。请求格式：

```json
{
  "protocol": "biunivers.resource-session/1",
  "requestId": "request-1",
  "method": "resource.getCapabilities",
  "params": {}
}
```

成功响应：

```json
{
  "protocol": "biunivers.resource-session/1",
  "requestId": "request-1",
  "ok": true,
  "result": {}
}
```

失败响应：

```json
{
  "protocol": "biunivers.resource-session/1",
  "requestId": "request-1",
  "ok": false,
  "error": {
    "code": "REQUEST_INVALID",
    "message": "请求无效"
  }
}
```

应用必须校验响应的 `protocol`、`requestId` 和发送方 Origin。单条消息 UTF-8 JSON 大小
不得超过 64 KiB。未知字段不能用于改变协议语义。

## 4. 方法

### `resource.getCapabilities`

`params` 必须为空对象。返回宿主的稳定 v1 能力和租约时间：

```json
{
  "protocol": "biunivers.resource-session/1",
  "renewAfterSeconds": 60,
  "expiresAfterSeconds": 300,
  "fullRead": true,
  "singleRangeRead": true,
  "fullWrite": true
}
```

### `resource.claimLaunch`

`params` 必须为空对象。用于领取文件管理器、桌面或“打开方式”交付给当前应用窗口的一个
待领取文件。没有待领取文件时返回 `NO_LAUNCH_CONTEXT`。

### `resource.open`

让用户选择一个文件：

```json
{ "access": "read" }
```

`access` 可以是 `read` 或 `edit`，省略时为 `read`。请求 `edit` 时应用 Handler 必须允许
`edit` 和 `read-write`。取消选择返回 `USER_CANCELLED`。

### `resource.saveAs`

让用户选择保存位置和文件名：

```json
{ "suggestedName": "untitled.txt" }
```

返回的会话在第一次成功 PUT 前不创建文件。第一版不覆盖已有同名文件。

### `resource.getMetadata`

```json
{ "sessionId": "<opaque-session-id>" }
```

返回当前会话、权限、过期时间和公开元数据，并隐式续租。

### `resource.renew`

```json
{ "sessionIds": ["<opaque-session-id>"] }
```

应用应约每 60 秒批量续租仍在使用的会话。宿主返回独立的 `renewed` 和 `rejected` 数组；
一个失败不影响其他会话。超过 300 秒未续租的会话不能复活。

### `resource.release`

```json
{ "sessionIds": ["<opaque-session-id>"] }
```

主动释放一个或多个会话。重复释放视为成功。

## 5. 会话结果

创建、领取或读取元数据时返回：

```json
{
  "sessionId": "<opaque-session-id>",
  "access": "edit",
  "expiresAt": "2026-07-29T18:05:00.000Z",
  "metadata": {
    "name": "movie.mkv",
    "size": 123456789,
    "mtimeMs": 1785290000000,
    "mediaType": "video/x-matroska",
    "contentVersion": "<opaque-version>"
  },
  "content": {
    "url": "https://desktop.example/api/v1/resource-content",
    "sessionHeader": "Biunivers-Resource-Session",
    "authorization": "Biunivers-Instance",
    "instanceToken": "<opaque-instance-token>"
  }
}
```

`resource.claimLaunch` 的结果外层还包含 `action`，其值为 `open` 或 `edit`。

## 6. 内容读取

对 `content.url` 发起 GET，并同时携带：

```http
Authorization: Biunivers-Instance <content.instanceToken>
Biunivers-Resource-Session: <sessionId>
```

不带 `Range` 返回 `200` 和完整内容。单区间请求示例：

```http
Range: bytes=1048576-2097151
```

合法区间返回 `206`、`Accept-Ranges: bytes`、准确的 `Content-Range` 和
`Content-Length`。不可满足的区间返回 `416` 和 `Content-Range: bytes */<total>`。
第一版不支持多区间请求。

成功读取会隐式续租。应用必须自行处理网络中断、会话过期和重新打开。

## 7. 完整保存

对同一 `content.url` 发起 PUT，携带与 GET 相同的两个凭据请求头，并把完整新文件作为
请求体。只有 `access: edit` 的会话可以保存。

第一版只支持完整替换，不支持局部写入。保存使用会话创建或上次成功保存时的内容版本做
冲突检查；文件被其他会话修改时返回 `FILE_VERSION_CONFLICT`，不会静默覆盖。成功后同一
会话前进到新版本并隐式续租，可以继续读取和保存。

默认最大单次 PUT 为 4 GiB；宿主可以采用更低部署上限并返回
`RESOURCE_TRANSFER_TOO_LARGE`。

## 8. 生命周期与错误

请求开始时会话必须有效。已经接受的传输可以在租约到期点之后完成；应用被停用、卸载或
更新时，进行中的传输可被中止且不能发布新的文件系统 Ref。

应用至少应处理：

- `USER_CANCELLED`
- `NO_LAUNCH_CONTEXT`
- `RESOURCE_SESSION_NOT_FOUND`
- `RESOURCE_SESSION_EXPIRED`
- `RESOURCE_SESSION_REVOKED`
- `RESOURCE_ACCESS_DENIED`
- `FILE_VERSION_CONFLICT`
- `RESOURCE_TRANSFER_TOO_LARGE`
- `RESOURCE_SESSION_LIMIT_REACHED`
- `NETWORK_ERROR`

## 9. v1 非目标

v1 不定义目录会话、文件枚举、多文件原子事务、多区间响应、局部写入、跨应用转让、
跨重启恢复、S3 URL 或凭据暴露，以及无需自定义请求头的原生 `<video src>` URL。
