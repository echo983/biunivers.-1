# Biunivers Host API v1

- 协议标识：`biunivers.host-api/1`
- 状态：实现中；已有文件的打开、读取、覆盖保存、元数据和释放可用
- 传输：受管 iframe 与父窗口之间的 `postMessage`

Host API 是可选宿主能力，不是静态应用安装协议的一部分。应用必须能处理
`HOST_API_UNSUPPORTED`，且不能假设文件能力始终存在。

## 1. 请求与响应

```js
const requestId = crypto.randomUUID();
window.parent.postMessage(
  {
    protocol: "biunivers.host-api/1",
    requestId,
    method: "file.open",
    params: { writable: true },
  },
  "*",
);
```

应用可以用 `*` 向未知宿主发送首个请求，但接收响应时必须校验：

- `event.source === window.parent`；
- `event.data.protocol === "biunivers.host-api/1"`；
- `requestId` 等于未完成请求；
- 同一请求只处理一次。

成功响应：

```json
{
  "protocol": "biunivers.host-api/1",
  "requestId": "...",
  "ok": true,
  "result": {}
}
```

失败响应：

```json
{
  "protocol": "biunivers.host-api/1",
  "requestId": "...",
  "ok": false,
  "error": {
    "code": "USER_CANCELLED",
    "message": "用户取消了文件选择"
  }
}
```

## 2. 当前方法

### `file.open`

显示宿主文件选择器。只有明确的用户选择才会签发句柄。

```json
{ "writable": true }
```

返回不透明 `handleId`、读写权限、过期时间及不包含 FID/路径/S3 Key 的文件元数据。

### `file.readTransfer`

```json
{ "handleId": "..." }
```

返回一次性 GET 传输描述。

### `file.writeTransfer`

```json
{ "handleId": "..." }
```

返回一次性 PUT 传输描述。只读句柄会被拒绝。

### `file.getMetadata`

```json
{ "handleId": "..." }
```

返回当前文件名、大小、修改时间、revision、权限和 `changed` 状态。

### `file.release`

```json
{ "handleId": "..." }
```

释放句柄并级联撤销尚未使用的传输。

### `file.saveAs`

方法名已保留，但当前返回 `HOST_API_UNSUPPORTED`。应用必须保留自身内容并允许用户稍后重试。

## 3. 使用传输

传输描述包含 `url`、`method`、`instanceToken`、`expiresAt` 和 `maxBytes`。请求示例：

```js
await fetch(transfer.url, {
  method: transfer.method,
  headers: {
    Authorization: `Biunivers-Instance ${transfer.instanceToken}`,
    ...(transfer.method === "PUT"
      ? { "Content-Type": "application/octet-stream" }
      : {}),
  },
  ...(transfer.method === "PUT" ? { body: bytes } : {}),
});
```

传输只能由当前应用的独立 Origin 发起，并同时绑定应用、窗口实例、句柄、HTTP 方法和大小
上限。它是短期一次性能力：失败、完成、过期或窗口关闭后应重新请求，不得持久化
`instanceToken`、`handleId` 或 transfer。

## 4. 错误处理

应用至少应处理：

- `HOST_API_UNSUPPORTED`：宿主或方法不可用；
- `USER_CANCELLED`：用户取消，不作为程序错误；
- `REQUEST_INVALID`：请求参数错误；
- `HANDLE_NOT_FOUND` / `HANDLE_EXPIRED`：清除本地句柄；
- `PERMISSION_DENIED`：当前句柄没有所需权限；
- `TRANSFER_EXPIRED`：重新申请传输；
- `TRANSFER_TOO_LARGE`：提示用户缩小内容；
- `REF_CONFLICT`：文件系统已被其他写入推进，应重新打开或重试。

应用不得根据错误差异探测其他应用、窗口或未授权文件。
