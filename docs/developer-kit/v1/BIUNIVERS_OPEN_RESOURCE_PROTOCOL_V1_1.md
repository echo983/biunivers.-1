# Biunivers Open Resource Protocol v1.1

协议标识：`biunivers.open-resource/1.1`

状态：草案

固定协议原文文件名：`BIUNIVERS_OPEN_RESOURCE_PROTOCOL_V1_1.md`

## 1. 用途

本协议允许已安装的 Biunivers 静态应用声明自己能够打开哪些文件，并在用户明确选择后取得
一个或一组文件的 Resource Session。

v1.1 是 Open Resource v1 的向后兼容增量版本，增加：

- 应用主动请求多选文件；
- Handler 明确声明批量处理资格；
- 文件管理器把同一目录中的多个文件一次性交付给一个应用。

每个文件仍使用独立的 Biunivers Resource Session v1。本协议不定义组会话，不允许应用
枚举文件系统，也不改变内容读取、Range、续租和释放规则。

应用声明 `biunivers.open-resource/1.1` 时，必须把本文件原文不加修改地放在公开 GitHub
仓库根目录。它不替代静态应用协议原文；使用 Resource Session 时仍须携带
`BIUNIVERS_RESOURCE_SESSION_PROTOCOL_V1.md`。

## 2. 与 v1 的关系

- 宿主应继续支持 `biunivers.open-resource/1`；
- v1 原文和单资源语义保持不变；
- 应用在 `biunivers.open-resource.json` 中只能声明一个 Open Resource 版本；
- v1.1 Handler 在没有 `multiple: true` 时与 v1 Handler 行为相同；
- v1 应用不能收到批量 Launch；
- v1.1 应用仍可收到单资源 Launch；
- Resource Session 的协议标识继续是 `biunivers.resource-session/1`。

宿主不应把 v1.1 声明静默降级成 v1。宿主不支持 v1.1 时，应在安装或更新检查阶段明确
拒绝，而不是安装一个无法兑现能力的应用。

## 3. 安全边界

- 只能交付用户在宿主界面明确选择的普通文件；
- 不允许选择或交付目录；
- Handler 声明只是候选资格，不授予任何文件；
- 多选不能扩大为同目录、同类型或相邻文件的枚举权限；
- 每个资源具有独立、不透明的 Session ID、权限、租约和内容版本；
- Session ID、实例凭据和内容 URL 不得转交其他应用；
- 应用停用、卸载或更新时，批量取得的全部会话按现有规则撤销；
- 宿主重启后，全部会话失效；
- 批量第一版只授予 `read`，即使 Handler 的单文件上限为 `read-write`。

## 4. Handler 声明

应用仓库根目录可提供：

```text
biunivers.open-resource.json
```

示例：

```json
{
  "protocol": "biunivers.open-resource/1.1",
  "handlers": [
    {
      "id": "image-gallery",
      "actions": ["open"],
      "extensions": [".png", ".jpg", ".jpeg", ".webp"],
      "mediaTypes": ["image/png", "image/jpeg", "image/webp"],
      "access": "read",
      "multiple": true
    }
  ]
}
```

`multiple`：

- 可省略；
- 省略或 `false` 表示只接受单资源；
- `true` 表示同一个 Handler 可以一次接受多个普通文件；
- 为 `true` 时 `actions` 必须包含 `open`；
- 不表示应用可以遍历、搜索或自动取得其他匹配文件。

Handler 的其余字段、安装固定和默认关联规则沿用 v1。

## 5. 批量匹配

一组文件只有在以下条件全部成立时才能交付：

1. 数量至少为 2；
2. 数量不超过宿主硬上限；
3. 全部项目都是普通文件；
4. 同一个 Handler 声明 `multiple: true`；
5. 该 Handler 的扩展名或媒体类型规则匹配每一个文件；
6. Handler 的 `actions` 包含 `open`；
7. 应用处于启用状态。

混合扩展名可以被同一 Handler 接受。例如一个图片 Handler 可以同时接受 `.png` 和
`.jpg`。不能把多个不同 Handler 拼接成一次批量资格。

文件管理器只在共同候选存在时提供批量“打开”或“打开方式”。批量第一版不建立或修改
默认关联，不提供 `edit`。

## 6. 应用主动多选

v1.1 应用可以通过现有 `biunivers.resource-session/1` 消息通道请求：

```json
{
  "protocol": "biunivers.resource-session/1",
  "requestId": "request-1",
  "method": "resource.openMany",
  "params": {
    "access": "read",
    "maximum": 100
  }
}
```

规则：

- `access` 第一版必须为 `read`，可省略；
- `maximum` 可省略，默认 100；
- `maximum` 必须是 2 到 500 的整数；
- 宿主可以采用小于请求值的部署上限；
- 选择器只允许在当前目录选择普通文件；
- 至少选择 2 个文件才能确认；
- 所选文件必须共同匹配一个 `multiple: true` Handler；
- 用户取消返回 `USER_CANCELLED`，不创建会话。

成功返回：

```json
{
  "resources": [
    {
      "sessionId": "<opaque-session-id>",
      "access": "read",
      "expiresAt": "2026-07-30T12:05:00.000Z",
      "metadata": {
        "name": "a.jpg",
        "size": 123,
        "mtimeMs": 1785326400000,
        "mediaType": "image/jpeg",
        "contentVersion": "<opaque-version>"
      },
      "content": {
        "url": "https://desktop.example/api/v1/resource-content",
        "sessionHeader": "Biunivers-Resource-Session",
        "authorization": "Biunivers-Instance",
        "instanceToken": "<opaque-instance-token>"
      }
    },
    {
      "sessionId": "<another-opaque-session-id>",
      "access": "read",
      "expiresAt": "2026-07-30T12:05:00.000Z",
      "metadata": {
        "name": "b.jpg",
        "size": 456,
        "mtimeMs": 1785326400000,
        "mediaType": "image/jpeg",
        "contentVersion": "<another-opaque-version>"
      },
      "content": {
        "url": "https://desktop.example/api/v1/resource-content",
        "sessionHeader": "Biunivers-Resource-Session",
        "authorization": "Biunivers-Instance",
        "instanceToken": "<opaque-instance-token>"
      }
    }
  ]
}
```

`resources` 按宿主选择器中的显示顺序排列。结果中不得出现重复 Entry；重复选择应在签发前
去重并保留第一次出现的位置。

## 7. 文件管理器批量 Launch

文件管理器从同一目录多选文件并选择一个共同 Handler 后，宿主创建一个 Pending Launch。
这个 Launch 包含有序 Entry ID 集合，但通知仍不包含资源信息：

```json
{
  "protocol": "biunivers.open-resource/1.1",
  "event": "launch.contextAvailable"
}
```

应用随后通过 `biunivers.resource-session/1` 调用既有：

```json
{
  "method": "resource.claimLaunch",
  "params": {}
}
```

单资源 Launch 成功结果保持：

```json
{
  "action": "open",
  "resource": {}
}
```

批量 Launch 成功结果：

```json
{
  "action": "open",
  "resources": [{}, {}]
}
```

约束：

- `resource` 与 `resources` 不能同时存在；
- `resources` 至少包含 2 项；
- 每一项都是完整的 Resource Session v1 公开结果；
- 顺序采用文件管理器当前可见排序；
- 同一应用窗口仍只保留一个待领取 Launch；
- 新的 Launch 不能静默覆盖尚未领取的 Launch；
- Launch 领取后只能消费一次；
- 应用负责决定如何把新批次加入、替换或拒绝当前工作集。

## 8. 批量签发原子性

宿主必须把一次批量获取视为一个授权决策：

1. 在同一个 EntryIndex revision 上解析全部 Entry；
2. 去重并验证数量；
3. 验证全部文件和共同 Handler；
4. 为每一项准备独立 Session；
5. 全部准备成功后才向应用公开结果。

任一项失败时：

- 整批失败；
- 已准备但未公开的 Session 必须撤销；
- 不返回部分 `resources`；
- 不改变任何文件；
- 不留下可续租的孤立会话。

批量签发不要求跨文件内容快照具有同一个 FID 版本事务。每个 Session 固定自己签发时观察到
的内容版本。

## 9. 会话使用

批量返回后，应用继续使用 Resource Session v1：

- 每个 Session 独立 GET 和单 Range；
- `resource.renew` 使用现有 `sessionIds[]` 批量续租；
- `resource.release` 使用现有 `sessionIds[]` 批量释放；
- 一个 Session 读取失败不自动撤销其他 Session；
- 第一版批量 Session 没有写权限。

应用应在不再使用某项时主动释放，不应为了保留整个列表而无限续租所有文件。

## 10. 能力发现

v1.1 宿主在 `resource.getCapabilities` 现有结果中增加：

```json
{
  "openMany": true,
  "batchLaunch": true,
  "maximumOpenMany": 500
}
```

旧宿主没有这些字段。应用必须把缺失视为不支持，并回退到单文件 `resource.open`，不能仅
根据版本字符串假设能力存在。

## 11. 错误

除 Resource Session v1 错误外，应用应处理：

- `MULTIPLE_UNSUPPORTED`：应用、Handler 或宿主不支持批量；
- `SELECTION_TOO_SMALL`：选择少于 2 个文件；
- `SELECTION_TOO_LARGE`：超过请求或宿主上限；
- `NO_COMMON_HANDLER`：没有一个 Handler 匹配全部文件；
- `BATCH_ISSUE_FAILED`：宿主未能完整签发整批会话；
- `LAUNCH_CONTEXT_BUSY`：目标应用已有尚未领取的 Launch。

错误响应不得泄露未授权 Entry、目录内容或其他应用状态。

## 12. 非目标

v1.1 不提供：

- 目录 capability；
- 文件系统遍历或搜索；
- 多目录选择篮；
- 组 Session ID；
- 多文件原子读写或批量保存；
- 文件夹拖放、操作系统拖放或剪贴板协议；
- 后台同步；
- 跨应用转交 Session；
- 自动取得同类型、相邻或新创建文件。

## 13. 最小兼容要求

支持 v1.1 的宿主必须：

- 安装时逐字校验本协议原文；
- 严格校验 v1.1 Handler Schema；
- 继续兼容 v1 应用；
- 不向 v1 或未声明 `multiple` 的应用交付批量 Launch；
- 对 `resource.openMany` 执行真实用户多选；
- 以独立 Resource Session v1 交付每个文件；
- 保证批量签发全成或全败；
- 在停用、卸载、更新和宿主重启时撤销全部相关能力。
