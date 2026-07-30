# 浏览器云端个人桌面 Open Resource v1.1 技术设计

状态：设计基线候选

日期：2026-07-30

## 1. 目标

在不修改 Open Resource v1 和 Resource Session v1 原文的前提下，为第三方应用增加：

- 主动一次选择多个文件；
- 从文件管理器一次领取多个文件；
- 继续使用现有的独立 Resource Session 读取、Range、续租和释放。

架构原则：

```text
Open Resource v1.1
负责批量选择、共同 Handler 与 Launch

Resource Session v1
负责每个文件的持续访问
```

## 2. 当前实现缺口

当前代码具有：

- 一个应用实例可以同时持有多个 Resource Session；
- `resource.renew` 和 `resource.release` 已接受 `sessionIds[]`；
- 文件管理器已有 Ctrl/Shift 多选和稳定的 `selectedEntries` 顺序；
- EntryIndex 可以在同一 revision 解析多个 Entry。

当前限制：

- `HostFilePicker.onSelect` 只返回一个 Entry ID；
- `resource.open` 只签发一个 Session；
- Open Resource Resolver 输入是一个 Entry ID；
- Pending Launch 保存一个 Entry ID；
- 每个目标应用只允许一个待领取 Launch；
- `resource.claimLaunch` 只返回一个 Session；
- 文件管理器“打开方式”只对单选启用；
-安装器只接受 v1 Schema 和 v1 原文字节。

因此不需要改内容服务，只需要把资源获取路径从单值扩展为有序集合。

## 3. 版本安装

### 3.1 Validator Registry

把单一 `OpenResourceValidator` 扩展为按协议标识选择的 Validator Registry：

```ts
type SupportedOpenResourceProtocol =
  | "biunivers.open-resource/1"
  | "biunivers.open-resource/1.1";
```

安装检查顺序：

1. 读取 `biunivers.open-resource.json`，只解析足够判断 `protocol` 的顶层结构；
2. 根据白名单选择对应 Schema 和固定协议原文；
3. 严格校验完整声明；
4. 要求仓库根目录存在对应版本的固定原文；
5. 逐字比较；
6. 把协议版本和 Handler 一起写入安装记录。

不得在 v1 Schema 中增加 `multiple`，不得让 v1.1 声明通过 v1 Validator。

### 3.2 类型

```ts
interface OpenResourceHandler {
  id: string;
  actions: Array<"open" | "edit">;
  extensions: string[];
  mediaTypes?: string[];
  access: "read" | "read-write";
  multiple?: boolean;
}
```

`multiple` 只在协议版本为 v1.1 时可能为 `true`。运行时代码不得仅检查字段而忽略版本。

## 4. 共同 Handler 解析

新增集合解析器：

```ts
resolveMany({
  entryIds,
  expectedRevision,
  requestedAction: "open"
})
```

处理：

1. 数量必须为 2 到宿主上限；
2. 按首次出现去重；
3. 在一个 EntryIndex 上解析全部 Entry；
4. 拒绝目录和不存在的 Entry；
5. 对每个启用的 v1.1 应用，筛选 `multiple: true` Handler；
6. 同一个 Handler 必须匹配每个 Entry；
7. 只产生 `open`、`read` 候选；
8. 结果携带有序 Entry 摘要和共同候选。

集合匹配复杂度上限为：

```text
选择数 × 已安装 Handler 数
```

选择硬上限 500、每应用 Handler 上限 16，第一版无需建立额外索引。

## 5. 多选文件选择器

保留现有单选 `HostFilePicker`，增加 `multiple` 模式，而不是复制另一套目录浏览器。

状态：

```ts
selectedEntryIds: Set<string>
```

行为：

- 只在一个当前目录内选择；
- 目录双击进入，不可加入选择；
- 文件支持单击、Ctrl/Command 和 Shift；
- 导航目录时清空选择；
- 确认按钮显示数量；
- 少于 2 项时禁用；
- 超过 `maximum` 时拒绝新增并提示；
- 返回按当前目录显示顺序排列的 Entry ID；
- 取消返回 `null`，不签发 Session。

Iframe 同时只能存在一个 open/save/multi picker。沿用现有 pending resolver 互斥，防止对话框
覆盖。

## 6. 批量 Session 签发

`ResourceSessionService` 增加：

```ts
issueFiles(instanceToken, entryIds, "read")
```

签发步骤：

1. 验证应用实例和 v1.1 资格；
2. 同一 EntryIndex revision 解析并固定全部文件；
3. 验证共同 Handler 和数量；
4. 预检 Registry 容量；
5. 为每项创建独立 Session；
6. 全部成功后投影公开结果。

Registry 增加批量方法，在一次同步临界区内预检容量并创建全部记录。由于 Session Registry
是进程内同步 Map，不需要数据库事务。若未来签发出现异步失败，必须撤销本批已经创建的
记录后再返回错误。

返回值：

```ts
PublicResourceSession[]
```

不增加 Set ID，不改变 Session 结构。

## 7. `resource.openMany`

现有 `biunivers.resource-session/1` dispatcher 增加一个条件方法：

```text
resource.openMany
```

它只对安装声明为 Open Resource v1.1 且存在 `multiple: true` Handler 的应用开放。

调用链：

```text
iframe request
→ capability / declaration check
→ multi picker
→ resolveMany
→ issueFiles
→ resources[]
```

`resource.getCapabilities` 根据当前应用声明返回：

```json
{
  "openMany": true,
  "batchLaunch": true,
  "maximumOpenMany": 500
}
```

v1 应用看到字段缺失或 `false`。

现有 Resource Session v1 固定原文不修改。Open Resource v1.1 原文作为启用这些条件方法的
附加安装契约。

## 8. 批量 Pending Launch

把 Pending Launch 的单值：

```ts
entryId: string
```

改为内部统一集合：

```ts
entryIds: string[]
```

单资源 Launch 保存长度为 1 的数组。这样 Registry 仍只有一套生命周期：

- 每个目标应用最多一个 pending Launch；
- 不覆盖未领取 Launch；
- TTL 不变；
- 领取一次后删除；
- 目标关闭、停用或更新时撤销。

批量 Launch 额外保存：

- `protocol: "biunivers.open-resource/1.1"`；
- `handlerId`；
- `action: "open"`；
- 一个共同 `expectedRevision`；
- 有序 Entry ID。

## 9. Claim 投影

`resource.claimLaunch`：

- 长度 1：保持 `{ action, resource }`；
- 长度至少 2：返回 `{ action: "open", resources }`。

批量 claim 在 Session Registry 中一次签发全部 Session。任一 Entry 在创建 Launch 后被
删除、替换类型或不再匹配时，整批 claim 失败，不产生部分结果。

旧的 `biunivers.open-resource/1` `launch.getContext` + Host API handle 路径保持单资源。
批量 Launch 只通过 Resource Session `resource.claimLaunch` 领取。v1.1 应用必须实现该
主路径，宿主不为旧 Host API 增加 handle 数组。

## 10. 文件管理器

当 `selectedEntries.length >= 2`：

1. “打开方式”调用 `resolveMany`；
2. 对话框仅列共同的 `multiple: true` Handler；
3. 用户选择后创建一个批量 Launch；
4. 启动或激活目标应用；
5. 应用收到 v1.1 `launch.contextAvailable`；
6. 应用通过 `resource.claimLaunch` 领取。

单选流程完全沿用当前实现。批量第一版不记忆默认关联，避免一个集合动作覆盖单扩展名默认
应用。

## 11. 并发与失败

- Resolver 使用 `expectedRevision` 拒绝过时列表；
- Launch 创建前再次确认目标应用仍启用；
- 一个应用已有 pending Launch 时返回 `LAUNCH_CONTEXT_BUSY`；
- 批量 picker 打开期间应用窗口关闭则取消；
- issue 前 EntryIndex 已变化时整批失败；
- Session Registry 容量不足时签发前失败；
- 响应发出前实例撤销时整批 Session 撤销；
- 任何失败不修改文件系统。

第一版不自动重试 revision 冲突。用户刷新后重新选择，语义更明确。

## 12. 上限

- 请求默认上限：100；
- 协议允许请求：2–500；
- 宿主硬上限：500；
- 部署可以采用更低上限；
- 一条 postMessage 仍不超过 64 KiB；
- 返回 500 个 Session 可能接近消息上限，施工时必须用最长合法元数据验证；
- 如果最坏投影超过 64 KiB，应把实际硬上限下调并在 capabilities 中报告，不能突破消息上限。

建议施工时根据真实 JSON 投影测得安全上限；500 是协议上限，不是必须支持值。

## 13. 不修改的部分

- File Service、PVLog、FID 和 Entry ID；
- resource-content GET/PUT/Range；
- Session 单项租约和版本冲突；
- `resource.renew` / `resource.release`；
- Open Resource v1 原文和 Schema；
- Resource Session v1 原文；
- 第三方应用文件系统不可枚举边界。

## 14. 迁移

已安装 v1 应用保持原记录。应用更新到 v1.1 时必须：

1. 提交 v1.1 声明和固定原文；
2. 通过 v1.1 Schema；
3. 更新成功后原子替换 Handler 投影；
4. 撤销旧应用实例、Pending Launch 和 Session；
5. 新窗口重新声明并领取 v1.1 能力。

应用从 v1.1 降回 v1 使用同样的更新和撤销流程。
