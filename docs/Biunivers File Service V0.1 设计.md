# Biunivers File Service V0.1 设计

## 1. 文档状态

- 状态：规范评审有条件通过
- 目标版本：Biunivers File Service V0.1
- 底层协议：PVLogS3Lite 修订设计
- 首个验证应用：第三方静态记事本

本文定义 Biunivers 桌面文件服务的最小产品与技术边界。File Service 为用户提供文件和目录
语义，为第三方 iframe 应用提供受控文件能力，并使用 PVLogS3Lite 把不可变对象保存到
S3 兼容后端。

本设计不把 S3、FID、Head、Segment、Manifest 或 Chunk 暴露给第三方应用。

施工准入项：

- [x] 冻结 Deterministic CBOR 字段编号和黄金向量；
- 实现并验证严格 WORM ObjectStore 适配器合约；
- 完成每应用独立 origin 设计与本地开发方案；
- 确定 SQLite RefStore 备份和恢复操作；
- [ ] 冻结 PVLog Core WASM ABI、内存上限和基准测试方法（ABI v1 候选与
  128 MiB 线性内存上限已经落地，待解码/回放接口和基准结果）。

## 2. 目标

V0.1 必须完成以下闭环：

```text
新建文档
  → 编辑
  → 另存为
  → 关闭应用
  → 从文件选择器重新打开
  → 修改
  → 保存
  → 容器重启后再次打开
```

系统必须保证：

1. 文件内容形成真实的桌面文件，而不是应用私有缓存；
2. 文件在重命名、移动和内容更新后保持稳定身份；
3. 第三方应用只能访问用户明确授权的文件；
4. 大文件内容不通过 JSON 或普通 `postMessage` 搬运；
5. 文件写入失败不得破坏当前版本；
6. S3 后端不保存可变 Ref；
7. S3 协议对象创建后不能覆盖；
8. 当前 Head 由本地事务型 RefStore 原子发布；
9. 容器重启后文件系统状态可以恢复；
10. File Service 不向应用暴露 S3 凭据或内部对象地址；
11. 获得文件能力的第三方应用具有独立浏览器 origin。

## 3. 非目标

V0.1 不包含：

- 多用户和 ACL；
- POSIX 权限、owner、mode、符号链接和硬链接；
- 桌面挂载宿主机任意目录；
- WebDAV、NAS 或其他外部存储 Provider；
- 多设备实时协作；
- 自动三方合并；
- 回收站；
- 全文搜索；
- 文件版本历史 UI；
- 共享链接；
- 应用间任意消息总线；
- 自动删除不可达 S3 对象；
- 浏览器端离线同步；
- secret 存储。

## 4. 分层

```text
第三方静态应用
        |
        | postMessage 控制请求
        v
File Host API Bridge
        |
        +----> 宿主文件选择器 / 保存对话框
        |
        | 不透明 handle + 短期传输凭据
        v
File HTTP API
        |
        v
Biunivers File Service
        |
        +----> SQLite RefStore / 授权 / 本地索引
        |
        v
PVLogS3Lite Client
        |
        v
S3 Immutable Object Store
```

职责边界：

- Host API Bridge 负责识别 iframe、校验 origin、显示宿主 UI 和分发句柄；
- File HTTP API 负责流式内容传输；
- File Service 负责文件语义、授权、冲突和事务；
- RefStore 负责当前 Head、快照和本地控制状态；
- PVLogS3Lite 负责不可变版本对象；
- S3 只负责不可变对象保存和读取。

### 4.1 应用 origin 前置条件

V0.2 使用一个共享 App Origin 托管所有第三方应用。该模型不能作为文件能力的安全边界：
同源应用可能访问彼此的 Web 状态或浏览上下文。File Host API 启用前必须为每个已安装应用
分配独立 origin，例如：

```text
https://<app-origin-key>.apps.desktop.example.com
```

宿主必须：

- 通过 app ID 映射稳定且合法的 `app-origin-key`；
- 根据请求 Host 只提供该应用的已安装文件；
- 不允许一个应用 origin 读取另一个应用路径；
- 为 wildcard DNS 和 TLS 提供明确部署方案；
- 在本地开发环境提供等价的 origin 隔离；
- File HTTP API 的 CORS 精确允许发起授权的应用 origin。

在每应用 origin 完成前，File Host API 必须保持关闭。Sandbox opaque origin 可以继续研究，
但 V0.1 不以尚未验证的 sandbox/CORS 组合替代独立 origin。

## 5. 文件系统与资源模型

### 5.1 Lineage 和 Ref

V0.1 创建一个主 lineage 和一个主 Ref：

```text
lineage_id = 随机 128 位
ref_id = "main"
```

Lineage 标识共享历史谱系；Ref 选择当前 Head。Ref 只保存在 SQLite。

### 5.2 Entry

文件和目录统一为 Entry：

```ts
interface FileEntry {
  entryId: string;
  parentId: string | null;
  name: string;
  kind: "file" | "directory";
  mediaType?: string;
  size: number;
  createdAt: string;
  updatedAt: string;
  revision: number;
}
```

规则：

- `entryId` 由服务端操作系统 CSPRNG 生成，是随机 128 位稳定身份；
- 根目录有固定保留 Entry ID；
- 新建 Entry 时分配 ID，删除后永不复用；
- 重命名、移动和内容更新不改变 ID；
- 复制文件生成新 Entry ID，但可以复用相同内容 FID；
- 路径由父目录和名称推导，不是资源身份。

### 5.3 文件句柄

第三方应用只能获得不透明句柄：

```ts
interface FileHandleGrant {
  handle: string;
  entry: FileEntry;
  permissions: Array<"read" | "write">;
  expiresAt: string;
}
```

句柄必须绑定：

- 应用 ID；
- 当前 iframe 窗口实例；
- Entry ID；
- 允许操作；
- 创建时间和过期时间；
- 可选的文件内容版本。

句柄不是 FID、路径、S3 Key 或凭据。其他应用不能复用该句柄。

V0.1 的句柄只保存在服务端内存中。窗口关闭、应用停用、卸载、服务重启或过期都会使句柄失效。

每个受管 iframe 在 Host API 握手后获得独立、随机、仅存内存的 `appInstanceToken`。该 token
绑定应用 ID 和窗口实例，用于后续 File HTTP API 请求；它不是管理员 token，不进入 URL、
Cookie、localStorage 或应用持久配置。

## 6. 本地状态

File Service 使用独立 SQLite 数据库：

```text
/data/file-service/file-service.sqlite
```

最小表：

```sql
CREATE TABLE filesystem_refs (
  ref_id TEXT PRIMARY KEY,
  lineage_id BLOB NOT NULL,
  head_fid BLOB NOT NULL,
  revision INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE filesystem_snapshots (
  snapshot_id BLOB PRIMARY KEY,
  ref_id TEXT NOT NULL,
  name TEXT NOT NULL,
  head_fid BLOB NOT NULL,
  revision INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  pinned INTEGER NOT NULL
);

CREATE TABLE file_service_meta (
  key TEXT PRIMARY KEY,
  value BLOB NOT NULL
);
```

V0.1 可以在内存中保存由 Head 回放得到的 Entry 索引。该索引不是权威状态，必须能从
PVLogS3Lite 对象重建。

SQLite 必须：

- 使用事务；
- 位于持久数据卷；
- 启用适合单进程服务的 WAL；
- 提供一致性备份命令；
- 在 RefStore 损坏或缺失时停止文件系统写入和 GC；
- 不以 S3 LIST 猜测当前 Head。

## 7. S3 配置与权限

File Service 通过部署环境配置 S3：

```text
BIUNIVERS_FILE_S3_ENDPOINT
BIUNIVERS_FILE_S3_REGION
BIUNIVERS_FILE_S3_BUCKET
BIUNIVERS_FILE_S3_PREFIX
BIUNIVERS_FILE_S3_ACCESS_KEY_ID
BIUNIVERS_FILE_S3_SECRET_ACCESS_KEY
BIUNIVERS_FILE_S3_FORCE_PATH_STYLE
```

这些值属于服务端 secret：

- 不进入第三方应用配置；
- 不发送到浏览器；
- 不写入日志；
- 不写入 PVLog 对象。

正常服务凭据只允许：

- 获取指定 namespace 对象；
- create-only 写入指定 namespace 对象。

正常服务不拥有覆盖和 `DeleteObject` 权限。V0.1 GC Scanner 只读并生成报告。

服务启动时必须执行能力检查；后端无法满足 create-only 语义时，File Service 进入不可写状态，
不能静默使用覆盖写。

## 8. PVLogS3Lite 映射

File Service 的用户操作映射为 PVLogS3Lite Operation：

| 用户操作 | PVLog Operation |
|---|---|
| 新建目录 | `CreateDirectory` |
| 新建文件 | `CreateFile` |
| 保存文件 | `SetFileContent` |
| 重命名或移动 | `MoveEntry` |
| 删除 | `RemoveEntry` |

一次用户动作可以生成一个包含多个 Operation 的 Segment。例如“另存为并创建缺失父目录”
可以在一个事务中创建目录和文件。

### 8.1 内容写入

```text
文件 <= 64 MiB
  → 单 Chunk

文件 > 64 MiB
  → 固定 64 MiB 分片
  → 每片计算 XXH3-128
  → 上传 Chunk
  → 生成 Deterministic CBOR Manifest
  → 计算 Manifest FID
```

所有对象由 File Service 写前计算 FID，读后重新校验。

### 8.2 发布

```text
读取 Ref A
  → 写入全部内容对象
  → 写入 Segment B
  → 写入 Head B
  → 验证新增对象可读
  → SQLite CAS：A → B
```

SQLite CAS 必须同时比较：

- `ref_id`；
- expected Head FID；
- expected revision。

只影响一行时发布成功。CAS 失败时不能覆盖最新 Ref。

## 9. File Host API

### 9.1 消息信封

控制面使用父窗口与 iframe 之间的 `postMessage`：

```ts
interface HostRequest {
  protocol: "biunivers.host-api/1";
  requestId: string;
  method: string;
  params: unknown;
}

interface HostResponse {
  protocol: "biunivers.host-api/1";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}
```

宿主必须同时校验：

- `event.origin` 等于 App Origin；
- `event.source` 等于目标窗口当前 iframe；
- 消息对应已安装且 active 的应用；
- `requestId` 格式和大小合法；
- `method` 位于宿主白名单；
- payload 不超过控制面大小限制。

### 9.2 V0.1 方法

只提供：

```text
file.open
file.saveAs
file.readTransfer
file.writeTransfer
file.getMetadata
file.release
```

#### file.open

宿主显示文件选择器。用户选择后返回绑定当前应用的读写句柄。

```json
{
  "accept": ["text/plain", "text/markdown"],
  "writable": true
}
```

#### file.saveAs

宿主显示保存位置与文件名对话框，确认后创建待提交句柄，但不立即创建空文件。只有对应
`file.writeTransfer` 完整上传并成功发布 PVLog 事务后，新文件才出现在目录中。

```json
{
  "suggestedName": "未命名.md",
  "mediaType": "text/markdown"
}
```

#### file.readTransfer

为已有句柄创建一次性或短期读取传输。

#### file.writeTransfer

为已有可写句柄创建短期写入传输，并绑定预期内容版本。

#### file.getMetadata

读取句柄当前 Entry 元数据，不返回内部 ContentRef。

#### file.release

主动释放句柄和未使用的传输凭据。

## 10. 数据传输

文件内容不进入 Host API JSON 消息。Host API 只返回传输描述：

```ts
interface FileTransfer {
  transferId: string;
  url: string;
  method: "GET" | "PUT";
  authorization: "Biunivers-Instance";
  expiresAt: string;
  maxBytes: number;
}
```

URL 必须：

- 位于 Desktop Origin；
- 使用不可预测随机 transfer ID；
- 绑定应用 ID、窗口实例和文件句柄；
- 短期有效；
- 限制请求方法；
- 读取可支持 Range；
- 写入限制最大字节数；
- 成功或过期后失效。

请求必须通过 `Authorization: Biunivers-Instance <appInstanceToken>` 证明窗口实例，并同时匹配
transfer ID。URL 本身不是完整授权。V0.1 不把长期 Bearer token 交给 iframe，传输授权只
允许一次具体操作。

Desktop Origin 的传输端点只允许该应用的独立 origin 发起 CORS 请求，不允许 credentialed
Cookie 请求，并限制允许的方法和 `Authorization` header。服务端仍须验证实例 token 与
transfer、应用和窗口的绑定，不能只依赖 `Origin`。

### 10.1 流式写入

```text
iframe 请求 file.writeTransfer
  → 宿主返回 PUT URL
  → iframe 携带实例 token，使用 fetch 上传 ReadableStream / Blob
  → File Service 流式分片和计算 FID
  → 完成 PVLog 事务
  → 返回新的 Entry revision
```

服务端必须限制：

- 单次写入最大文件大小；
- 请求超时；
- 并发传输数；
- 内存缓冲；
- 临时文件生命周期。

## 11. 文件选择器

V0.1 文件选择器属于宿主 UI，不属于第三方应用。

需要支持：

- 浏览目录；
- 面包屑；
- 文件名、类型、大小和修改时间；
- MIME 和扩展名过滤；
- 新建目录；
- 选择一个文件；
- 另存为文件名输入；
- 同名冲突提示；
- 取消操作。

暂不支持多选、拖放、搜索、预览和复杂排序。

应用只能看到用户最终选择的 Entry，不能在选择器打开期间枚举用户没有授权的目录内容。

## 12. 记事本验证场景

第三方记事本只依赖公开 Host API：

1. 用户打开记事本；
2. 新建草稿保存在应用内存；
3. 点击“另存为”；
4. 调用 `file.saveAs`；
5. 用户在宿主对话框选择 `Documents/notes.md`；
6. 记事本获得可写句柄；
7. 调用 `file.writeTransfer` 并上传 UTF-8 文本；
8. 关闭并重新打开记事本；
9. 调用 `file.open`；
10. 用户选择 `notes.md`；
11. 记事本通过 `file.readTransfer` 读取；
12. 修改后携带预期版本再次保存。

验收必须覆盖：

- `.txt` 和 `.md`；
- UTF-8 文本；
- 空文件；
- 重命名后旧句柄仍指向同一 Entry；
- 保存冲突；
- 句柄越权；
- 传输过期；
- 容器重启；
- S3 请求失败；
- RefStore CAS 失败；
- 上传失败后旧内容仍可读。

## 13. 冲突语义

写入授权记录打开时的：

```text
entry_id
entry_revision
content_fid
```

保存时默认要求：

```text
current content_fid == expected content_fid
```

不一致返回：

```text
FILE_VERSION_CONFLICT
```

应用必须提示重新加载或由用户明确发起覆盖。V0.1 Host API 不提供静默强制覆盖。

RefStore CAS 失败但目标 Entry 未变化时，File Service 可以在重新回放最新 Head 后安全重试；
目标 Entry、父目录或名称发生相关变化时返回冲突。

## 14. 错误模型

最小错误码：

```text
HOST_API_UNSUPPORTED
REQUEST_INVALID
USER_CANCELLED
HANDLE_NOT_FOUND
HANDLE_EXPIRED
PERMISSION_DENIED
ENTRY_NOT_FOUND
NAME_CONFLICT
FILE_VERSION_CONFLICT
TRANSFER_NOT_FOUND
TRANSFER_EXPIRED
TRANSFER_TOO_LARGE
STORAGE_UNAVAILABLE
STORAGE_INTEGRITY_ERROR
FID_COLLISION
REF_CONFLICT
```

错误消息面向用户说明下一步；日志可以包含内部诊断 ID，但不得包含 S3 secret、文件内容或
完整传输凭据。

## 15. 安全边界

- 第三方应用运行在独立 App Origin；
- File Host API 只接受当前受管 iframe 的消息；
- 应用安装声明不自动授予文件权限；
- 每次选择由宿主 UI 和用户动作产生授权；
- 句柄绑定应用和窗口；
- 管理员 token 与文件句柄完全分离；
- S3 secret 只在服务端；
- 任意 FID 读取接口不对浏览器公开；
- 文件名和 MIME 都视为不可信输入；
- 文本预览必须转义；
- 上传内容不能在 File Service 进程中执行；
- App Origin 不能直接访问 SQLite 或 `/data`。
- V0.2 共享 App Origin 不是应用间安全边界，不能为其启用文件能力；
- V0.1 文件能力要求每应用独立 origin；
- 文件能力不得依赖共享 Cookie、localStorage 或仅凭 origin 授权；
- 文件实例 token 和 transfer ID 只保存在应用当前内存，不能持久化；
- 受控 sandbox profile 可以作为后续纵深防御，但不替代 V0.1 每应用 origin。

## 16. 降级与可用性

File Service 未配置或不可用时：

- 桌面和普通静态应用继续运行；
- Host API 返回 `STORAGE_UNAVAILABLE`；
- 文件选择器显示明确状态；
- 不产生损坏的 Entry 或 Ref；
- 已安装应用管理不依赖 File Service。

S3 暂时不可用时：

- 可以读取本地已完整缓存且通过 FID 校验的对象；
- 不允许在无法完成对象上传和验证时发布新 Head；
- 不把本地临时内容伪装成已保存文件。

## 17. 可观测性与备份

需要记录但不包含内容的指标：

- 当前 Head revision；
- Segment 回放数量；
- 各对象类型读写数量和字节；
- FID 校验失败；
- Ref CAS 冲突；
- 传输失败；
- Checkpoint 生成耗时；
- GC 候选数量和字节。

备份至少包含：

- SQLite RefStore；
- File Service 配置的非 secret 部分；
- S3 Bucket/namespace 标识；
- 恢复说明。

恢复流程必须先恢复 RefStore，再验证其引用的 Head；验证通过前 File Service 保持只读或离线。

## 18. PVLog Core WASM

V0.1 建议把 PVLogS3Lite 的确定性纯计算核心实现为 Rust，并编译为受限 WASM 模块。采用
WASM 的主要目的不是替代服务端，而是统一规范实现、减少 JavaScript 数值和编码差异，并加速
XXH3、CBOR 和回放验证。

### 18.1 WASM 范围

WASM 内只包含：

- XXH3-128 单次和增量计算；
- Deterministic CBOR 编码与解码；
- Head、Segment、Checkpoint 和 Manifest 验证；
- Entry 名称和 ID 验证；
- Segment 应用；
- Checkpoint 构建与状态一致性检查；
- Manifest 分片边界和长度验证；
- 黄金测试向量执行。

WASM 不包含：

- S3 请求；
- SQLite；
- RefStore 事务；
- HTTP server；
- Host API 消息；
- 文件选择器；
- 应用授权；
- secret；
- 日志和部署配置。

这些 I/O、权限和生命周期能力继续由 Node.js 宿主负责。

### 18.2 接口原则

WASM ABI 必须版本化，并提供结构化错误，不允许 panic 穿透宿主。建议的逻辑接口：

```text
fid_once(bytes) -> Fid
fid_stream_new() -> HasherHandle
fid_stream_update(handle, bytes)
fid_stream_finish(handle) -> Fid

encode_head(value) -> bytes
decode_head(bytes) -> Head
encode_segment(value) -> bytes
decode_segment(bytes) -> Segment
encode_manifest(value) -> bytes
decode_manifest(bytes) -> Manifest
encode_checkpoint(value) -> bytes
decode_checkpoint(bytes) -> Checkpoint

apply_segment(state, segment) -> state
validate_checkpoint(checkpoint)
```

实现必须：

- 设置 WASM 最大线性内存；
- 对输入对象、数组、字符串和递归深度设限；
- 使用增量 FID 接口处理流，避免一次复制整个大文件；
- 不在 WASM 内保存跨请求 secret 或长期授权状态；
- 所有返回缓冲区有明确所有权和释放规则；
- 任何相同输入在支持的平台上产生完全相同的 CBOR 和 FID；
- Rust 原生测试和 WASM 测试运行同一套黄金向量。

ABI v1 候选规定单次跨 ABI 输入最大 4 MiB，大输入必须分段调用增量接口；编码对象最大
32 MiB；WASM 最大线性内存为 128 MiB。三个上限必须在基准和恶意输入测试后才能正式冻结。

### 18.3 性能与鲁棒性判断

WASM 对 XXH3、规范编码和大规模 Segment 回放预计有收益，也能把高风险二进制解析放入无
网络、无文件系统权限的线性内存边界。但 WASM 本身不自动保证正确性：

- 仍需要输入上限和黄金测试；
- JS 与 WASM 间复制可能抵消小对象性能收益；
- SQLite 和 S3 I/O 仍是宿主责任；
- 授权错误不能由 WASM 沙箱补救。

因此 V0.1 把 WASM 作为规范核心实现，而不是把完整 File Service 封装成 WASM。施工阶段
必须用基准测试比较纯 TypeScript 调用开销、WASM 增量处理和实际 S3 I/O，不能仅凭假设优化。

## 19. 实施阶段

### 阶段 0：格式基线

- 冻结 Deterministic CBOR 字段编号；
- 建立 Rust PVLog Core；
- 编译版本化 WASM 模块；
- 实现 XXH3-128 单次和增量 FID；
- 建立黄金测试向量；
- 实现 Entry ID 和名称校验；
- 建立 WASM 内存、输入上限和基准测试。

### 阶段 1：不可变对象和 RefStore

- S3 ObjectStore；
- Chunk、Manifest、Segment 和 Head；
- SQLite RefStore；
- CAS 发布；
- 创世文件系统；
- 完整回放和验证工具。

### 阶段 2：文件服务

- Entry 索引；
- 新建、读取、保存、移动、重命名和删除；
- 流式分片；
- Checkpoint；
- 冲突和重试。

### 阶段 3：Host API 与宿主 UI

- 每应用独立 origin；
- 安全消息桥；
- 文件句柄；
- 传输 URL；
- 文件选择器；
- 保存对话框；
- File HTTP API。

### 阶段 4：记事本验收

- 独立第三方记事本；
- 打开、保存和另存为；
- 冲突提示；
- 重启恢复；
- 失败链路；
- Docker 人工验收。

### 阶段 5：维护

- SQLite 备份；
- GC 扫描和只读报告；
- 损坏检查；
- 性能与容量测试。

## 20. 完工定义

V0.1 只有同时满足以下条件才完成：

- S3 中没有可变 Ref；
- 所有协议对象 create-only；
- 写前计算、读后校验 XXH3-128；
- 64 MiB 分片边界有黄金测试；
- SQLite Ref CAS 和故障恢复有集成测试；
- Entry ID 在移动、重命名和更新后稳定；
- 第三方应用不能绕过句柄访问文件；
- 文件能力只向独立应用 origin 开放；
- 大文件不经过控制面 JSON；
- 记事本完成新建、另存为、打开和保存闭环；
- 上传失败和并发冲突不破坏旧版本；
- 容器重启后文件可恢复；
- V1 GC 不删除对象；
- 文档、实现和测试向量一致。
- Rust 原生核心与 WASM 核心通过同一组黄金向量；
- WASM 不拥有网络、文件系统、SQLite 或授权能力。

## 21. 结论

Biunivers File Service V0.1 不是把 S3 API 暴露给桌面，而是在不可变对象存储之上建立：

```text
稳定 Entry 身份
本地原子 Ref
受控文件句柄
宿主文件选择器
流式内容传输
失败不破坏旧版本
```

PVLogS3Lite 负责保存事实版本；本地 RefStore 负责选择当前现实；File Service 负责把桌面文件
语义安全地提供给应用。记事本是第一条验证链路，但该边界能够继续支持播放器、图片编辑器、
下载器和未来的外部存储 Provider。
