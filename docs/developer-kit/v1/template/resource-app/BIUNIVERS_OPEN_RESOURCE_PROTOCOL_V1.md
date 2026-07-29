# Biunivers Open Resource Protocol v1

协议标识：`biunivers.open-resource/1`

状态：V1 冻结候选，进入实现验证后不原地扩大范围

固定协议文件名：`BIUNIVERS_OPEN_RESOURCE_PROTOCOL_V1.md`

固定声明文件名：`biunivers.open-resource.json`

## 1. 目标

本协议允许 Biunivers 第三方静态应用声明自己可以打开或编辑哪些文件，并允许宿主在用户选择
该应用后，把一个窗口专属的不透明文件句柄作为 Launch Context 交给应用。

本协议是可选扩展，不改变 `biunivers.static-app/1`、App Manifest v1 或
`biunivers.host-api/1`。文件内容读取、写入、元数据和释放仍使用 Host API。

## 2. 仓库文件

接入本协议的应用仓库根目录必须同时包含：

```text
BIUNIVERS_OPEN_RESOURCE_PROTOCOL_V1.md
biunivers.open-resource.json
```

协议 Markdown 必须与宿主支持的本版本原文逐字一致。声明存在而协议原文缺失、被修改或版本
不受支持时，宿主必须拒绝安装或更新。

不接入资源打开能力的应用不得伪造声明，也不需要携带这两个文件。

## 3. Handler 声明

声明的顶层格式：

```json
{
  "protocol": "biunivers.open-resource/1",
  "handlers": []
}
```

`handlers` 必须包含一至十六个 Handler。同一应用中的 Handler ID 必须唯一。

文本编辑器示例：

```json
{
  "protocol": "biunivers.open-resource/1",
  "handlers": [
    {
      "id": "text-editor",
      "actions": ["open", "edit"],
      "extensions": [".txt", ".md"],
      "mediaTypes": ["text/plain", "text/markdown"],
      "access": "read-write"
    }
  ]
}
```

### `id`

应用内部稳定的 Handler 身份。必须由小写字母开头，只包含小写字母、数字和短横线，长度
1 至 64。应用更新时，同一处理能力应保持 ID 不变。

### `actions`

非空且无重复的数组，只支持：

- `open`：应用可以消费该资源，不承诺修改原资源；
- `edit`：应用可以修改并保存回原资源。

声明 `edit` 的 Handler 必须使用 `access: "read-write"`。声明 `open` 不等于只读；
例如编辑器可以同时声明 open 和 edit。

### `extensions`

非空且无重复的文件扩展名数组，最多 64 项。每项：

- 长度 2 至 16；
- 以 `.` 开头；
- 其余字符只允许小写 ASCII 字母和数字；
- 不能包含路径、通配符、空格或多个点。

V1 根据文件名最后一个扩展名进行不区分大小写的匹配。应用必须在声明中使用小写。

### `mediaTypes`

可选的媒体类型数组，最多 64 项。它只能辅助宿主匹配，不能代替 `extensions`。V1 不要求
宿主嗅探文件内容，也不保证文件一定具有持久化媒体类型。

媒体类型必须使用小写 `type/subtype` 形式；V1 不支持参数或通配符。

### `access`

Handler 期望的最大访问能力：

- `read`；
- `read-write`。

这是上限声明，不是授权。宿主可以签发更低权限的句柄，也可以拒绝打开。应用不能因为声明
某扩展名或访问级别而枚举或读取任何文件。

## 4. 安装与生命周期

宿主安装或更新应用时必须：

1. 先完成 Static App 和 App Manifest 校验；
2. 检查协议原文字节完全一致；
3. 严格校验 `biunivers.open-resource.json`；
4. 拒绝未知字段、重复值和不支持的动作；
5. 把已验证 Handler 作为安装记录的一部分原子发布。

应用运行时不能新增、删除或修改已注册 Handler。

停用应用后，其 Handler 立即不再是有效候选。更新应用时以新 commit 的声明替换旧声明。
卸载应用时移除其候选 Handler，并撤销活动窗口和 capability。

Handler 声明不能未经用户确认设置或抢占默认关联。

## 5. 处理器选择

宿主可以根据扩展名和已有媒体类型产生候选集合。默认关联属于用户或宿主设置，不属于应用包。

推荐行为：

- 有有效默认关联时使用默认应用；
- 只有一个有效候选时直接打开；
- 有多个候选时显示打开方式；
- 没有候选时提示用户没有可用应用。

处理器选择本身不授予文件权限。

## 6. Launch Context 请求

本协议运行时使用受管 iframe 与父窗口之间的 `postMessage`。

应用在加载完成并注册响应监听器后发送：

```js
const requestId = crypto.randomUUID();
window.parent.postMessage(
  {
    protocol: "biunivers.open-resource/1",
    requestId,
    method: "launch.getContext",
    params: {}
  },
  "*"
);
```

应用可以用 `*` 向未知宿主发送请求，但接收响应时必须验证：

- `event.source === window.parent`；
- `event.data.protocol === "biunivers.open-resource/1"`；
- `requestId` 对应当前未完成请求；
- 同一请求只处理一次。

应用不能把本协议消息发送给其他 iframe，也不能接受其他窗口伪造的上下文。

## 7. Context Available 通知

当前 Biunivers 桌面中一个应用只有一个运行窗口。应用已运行时，用户可以从文件管理器再打开
另一个匹配文件。宿主为同一窗口建立新的待领取上下文后发送：

```json
{
  "protocol": "biunivers.open-resource/1",
  "event": "launch.contextAvailable"
}
```

通知不包含文件名、handle 或其他资源信息。应用验证 `event.source` 和 `protocol` 后，再
调用 `launch.getContext` 领取。

应用收到新上下文时负责处理当前未保存内容，例如提示保存、放弃或取消切换。V1 不要求应用
同时编辑多个资源。

## 8. Launch Context 响应

成功响应：

```json
{
  "protocol": "biunivers.open-resource/1",
  "requestId": "...",
  "ok": true,
  "result": {
    "action": "edit",
    "resource": {
      "handleId": "opaque-value",
      "name": "note.txt",
      "mediaType": "text/plain",
      "permissions": ["read", "write"]
    }
  }
}
```

`mediaType` 可省略。`permissions` 是实际授权而不是 Handler 声明。`handleId` 只能交给
`biunivers.host-api/1` 的文件方法，应用不得解析、持久化或转交它。

V1 一个上下文恰好包含一个资源，不支持批量打开。

失败响应：

```json
{
  "protocol": "biunivers.open-resource/1",
  "requestId": "...",
  "ok": false,
  "error": {
    "code": "NO_LAUNCH_CONTEXT",
    "message": "当前窗口不是通过资源打开启动"
  }
}
```

应用至少处理：

- `OPEN_RESOURCE_UNSUPPORTED`：宿主不支持本协议；
- `NO_LAUNCH_CONTEXT`：普通启动，没有资源上下文；
- `LAUNCH_CONTEXT_EXPIRED`：上下文领取前已经过期；
- `REQUEST_INVALID`：消息格式错误。

`NO_LAUNCH_CONTEXT` 是正常启动路径，不应显示为致命错误。应用应继续提供自己的空白页面、
打开按钮或其他普通入口。

## 9. 生命周期

每个 Launch Context：

- 绑定目标应用、App Origin 和窗口实例；
- 只能由目标 iframe 领取；
- 首次成功响应后立即消费；
- 未领取时最多保留五分钟；
- 窗口关闭时立即撤销；
- 不能放入 iframe URL、公开配置、日志或页面持久化存储。

一个窗口同一时刻最多有一个未领取上下文。已有上下文尚未领取时，宿主必须拒绝新的打开
请求，不能覆盖已有上下文。已消费后，窗口可以接收后续 `launch.contextAvailable`。

应用取得上下文后可以在当前页面内存中保存 `handleId`。页面刷新后，如果没有新的待领取
上下文，`launch.getContext` 返回 `NO_LAUNCH_CONTEXT`；用户可以从文件管理器重新打开文件。

文件 handle 和 transfer 的生命周期由 Host API v1 定义。应用完成工作或关闭文档时应调用
`file.release`。

## 10. 权限与冲突

宿主为目标窗口重新签发 handle，不能转交来源应用或 internal 文件管理器的原 handle。

实际权限不得超过：

- 来源操作允许的权限；
- Handler 的 `access` 上限；
- 文件当前允许的权限；
- 用户本次确认的权限。

声明 `edit` 或 `read-write` 不保证写权限。应用必须读取实际 `permissions` 并提供只读降级。

保存原文件时继续遵守 Host API 的版本冲突语义。收到 `FILE_VERSION_CONFLICT` 时，应用必须
保留未保存内容，不得静默覆盖，并应提供重新打开或另存为。

## 11. 安全要求

应用不得：

- 根据 Handler 声明扫描、枚举或猜测其他文件；
- 请求没有由宿主交付的 Entry、FID、S3 Key、Ref 或路径；
- 将 handle、instance token 或 transfer 发送给其他应用或外部服务；
- 把 capability 写入 URL、日志、分析事件或长期存储；
- 绕过宿主自行设置默认关联；
- 使用私有父页面 DOM 或未定义消息调用。

宿主不得：

- 因应用声明某扩展名而授予目录或同类文件的批量权限；
- 在用户没有打开意图时主动交付文件；
- 让一个 app、origin 或窗口领取另一个窗口的上下文；
- 通过错误差异泄露未授权文件或其他应用状态。

## 12. V1 非目标

V1 不定义：

- 多文件打开；
- 拖放；
- 后台应用调用；
- 通用应用间消息；
- 应用直接转让句柄；
- 内容嗅探；
- URL scheme、命令行或 Shell；
- 媒体 Range/Seek；
- 流水线、stdin/stdout 或共享内存；
- 多用户默认关联同步。

这些能力如有实际需求，应发布独立或后续版本，不得通过私有字段扩展 V1。
