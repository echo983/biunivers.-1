# PVLogS3Lite 设计规范

## 1. 文档状态

- 名称：PVLogS3Lite
- 状态：规范评审通过；CBOR V1 格式基线候选已冻结
- 目标后端：Amazon S3 及兼容 S3 API 的对象存储
- 目标场景：单用户或少量设备使用的个人文件系统
- 核心原则：不可变内容寻址、日志式状态演进、低成本快照与 Fork、有限复杂度

本文定义一个不依赖 NBSS 的轻量文件系统存储协议。它保留原 PVLog 中不可变 Head、
不可变 Segment 和内容复用的核心设计，同时缩减记录类型，将文件内容组织与目录状态日志解耦。

S3 后端只保存不可变对象，不保存 Ref、快照名称或其他可变控制状态。当前 Head、快照和
CAS 发布点属于使用本协议的上层系统。PVLogS3Lite 统一使用无 seed 的 XXH3-128 FID；
受信任的存储客户端写前计算 FID、读后重新校验。文件超过固定 64 MiB 时分片。

PVLogS3Lite 不试图成为分布式数据库，也不在初始版本中实现自动分支合并、目录 Merkle DAG、永久全量审计或复杂在线垃圾回收。

## 2. 设计目标

PVLogS3Lite 应满足以下目标：

1. 一个 Head FID 能唯一标识一个完整、一致的文件系统版本。
2. S3 中所有协议对象均不可变并按内容寻址。
3. 一次事务中的多个文件系统操作原子可见。
4. 提交失败不得破坏或部分更新当前文件系统。
5. 快照和 Fork 不复制文件内容。
6. 文件内容、Manifest、日志和 Checkpoint 可以在不同版本间复用。
7. 挂载时不必永久从创世日志开始回放。
8. 上层 RefStore 的单写者路径保持简单，多写者冲突必须被检测，不能静默覆盖。
9. 协议必须能够演进，已发布对象的解释不能随实现升级而改变。
10. 初始实现应适合个人系统的开发、运行和维护成本。

## 3. 非目标

初始版本不包含：

- 多主实时协作；
- 自动三方合并；
- POSIX 分布式锁；
- 目录级 Merkle Tree、HAMT 或 B-tree；
- 每次文件读取的永久审计；
- 跨 Bucket 的原子事务；
- 对象创建后立即进行精确 GC；
- 无限层 Base/Overlay 文件表示；
- 依赖 S3 LIST 推导文件系统当前状态。
- 在 S3 中保存可变 Ref 或快照名称；
- 向第三方应用暴露 S3 凭据或原始对象 Key；
- 使用 FID 提供针对主动攻击者的密码学完整性证明。

S3 LIST 仅可用于诊断、恢复辅助和 GC 报告，不能作为挂载和正常读取的权威索引。

## 4. 总体模型

PVLogS3Lite 由五类核心对象组成：

```text
上层本地 RefStore
   |
   v
不可变 Head
   |
   +----> 不可变 Checkpoint（可选）
   |
   v
不可变 Segment 链
   |
   v
不可变 Manifest / Chunk
```

各层职责如下：

| 对象 | 可变性 | 职责 |
|---|---|---|
| RefStore 记录 | 上层可变状态，不在 S3 | 发布某个分支当前指向的 Head |
| Head | 不可变 | 唯一标识一个文件系统版本 |
| Segment | 不可变 | 表示一次原子文件系统事务 |
| Checkpoint | 不可变 | 保存某个 revision 的完整路径状态，加速回放 |
| Manifest / Chunk | 不可变 | 表示文件内容 |

权威文件状态由 `Head + Checkpoint + Head 之后的 Segment` 共同确定。上层 RefStore
只负责选择当前 Head，不参与文件系统状态计算。

## 5. S3 Key 布局

建议在一个独立前缀下保存全部不可变对象：

```text
{namespace}/
  objects/heads/xxh3-128/{prefix}/{digest}
  objects/segments/xxh3-128/{prefix}/{digest}
  objects/checkpoints/xxh3-128/{prefix}/{digest}
  objects/manifests/xxh3-128/{prefix}/{digest}
  objects/chunks/xxh3-128/{prefix}/{digest}
```

其中：

- `namespace` 用于租户、用户或应用隔离；
- `prefix` 可取 digest 的前两个或前四个十六进制字符；
- 对象类别必须位于不同前缀，避免类型混淆；
- 对象 Key 不依赖原始文件路径；
- 文件路径不得直接成为 S3 Key。
- S3 中不得出现正常运行所依赖的可变 Key。
- GC 报告、上传状态和维护事务保存在本地控制平面，不写入对象 namespace。

示例：

```text
users/alice/objects/heads/xxh3-128/ab/abcdef...
users/alice/objects/segments/xxh3-128/42/4219ef...
users/alice/objects/chunks/xxh3-128/91/91a8d2...
```

## 6. FID 与内容寻址

### 6.1 FID

所有不可变对象统一使用 XXH3-128：

```rust
struct Fid {
    digest: [u8; 16],
}
```

逻辑文本形式：

```text
xxh3-128:<32 个小写十六进制字符>
```

参数固定为：

```text
algorithm = XXH3-128
seed = 0
```

FID 必须由最终持久字节计算：

```text
fid = XXH3_128(seed=0, persisted_bytes)
```

Chunk 的持久字节就是原始文件字节。Head、Segment、Checkpoint 和 Manifest 必须先完成
规范编码，再计算 FID。

读取方必须验证：

1. Key 中的对象类型与期望类型一致；
2. 下载内容重新计算的 XXH3-128 与请求 FID 一致；
3. 对象内部类型和格式版本受到支持；
4. 对象引用的子对象类型正确；
5. 所有长度、数量和偏移不超过实现限制。

XXH3-128 用于高性能寻址、去重和意外损坏检测，不提供针对主动攻击者的密码学抗碰撞保证。
S3、网络和 File Service 必须位于受信任边界内；未来不可信分发应另加签名或密码学摘要层，
不得改变已发布 FID 的含义。

本文中的“客户端”是受信任的 Biunivers File Service 或等价存储实现，不是第三方 iframe
应用。第三方应用不能自行提交可信 FID、访问任意对象或获得 S3 凭据。

仓库内 `ImmutableObjectRepository` 是强制完整性边界：调用方 PUT 时不能提供 FID，Repository
根据最终字节计算 FID 后才调用 ObjectStore；GET 后重新计算并在不匹配时返回
`OBJECT_INTEGRITY_FAILURE`。ObjectStore 的 `FID_COLLISION` 只表示同 Key 已存在不同字节，
两类错误不能混用。

V1 的精确字段编号、确定性编码规则和黄金向量由
[`protocols/PVLogS3Lite CBOR v1.md`](./protocols/PVLogS3Lite%20CBOR%20v1.md) 定义。

### 6.2 不可变写入

不可变对象上传必须使用 create-only 语义，避免意外覆盖同 Key 对象。具体 S3 实现可使用
条件创建或等价的不可覆盖策略，但不得静默退化为普通覆盖写。

当相同 Key 已存在时：

- 先比较对象长度；
- 长度相同后比较已有对象与待上传对象的完整字节；
- 只有字节完全一致才视为幂等去重成功；
- FID 相同但字节不同必须返回 `FID_COLLISION`；
- 不得覆盖已有不可变对象。

S3 ETag 不能作为 FID，也不能替代字节比较；协议不解释不同后端的 ETag 语义。

### 6.3 严格 WORM ObjectStore 合约

PVLogS3Lite 的后端抽象只要求：

```text
create(key, complete_bytes)
get(key)
head(key)
list(prefix)  // 仅诊断和 GC 报告
```

仓库内 `server/files/objectStore.ts` 是该合约的 TypeScript 边界；
`LocalWormObjectStore` 使用同文件系统硬链接完成 create-only 原子发布，仅用于本地开发和
合约测试。`S3WormObjectStore` 使用 `If-None-Match: *` 条件创建，并在对象已存在时完整
比对字节。生产 S3 适配器必须通过同一套合约测试，不能因为后端不同而放宽不可变语义。

2026-07-29 已在 Cloudflare R2 的真实隔离前缀上验证 create-only、幂等去重、冲突拒绝、
get、head 和 list。真实测试只从环境变量读取配置；`secret/` 目录整体被 Git 忽略。

其中 `create` 必须满足：

- 一个 Key 最多成功创建一次；
- 创建成功前对象不能被正常读取方观察为完整对象；
- 成功返回后完整字节可读；
- 已存在 Key 返回明确冲突，不修改原对象；
- 不提供 update、rename、copy-overwrite 或 delete；
- 对象 metadata 不参与协议解释，也不在创建后修改。

因此正常协议可以运行在追加式 WORM 或一次刻录对象介质上，只要介质允许持续追加新对象，
并由适配器保证单个对象在完成刻录后才可见。若介质只能整体刻录一次且之后不能追加，
它只能承载只读快照，不能承载持续演进的文件系统。

V1 每个 Chunk 最大 64 MiB，Head、Segment、Manifest 和 Checkpoint 受各自大小上限约束，
正常协议不需要 Multipart Upload。后端适配器可以在协议层之外使用临时上传机制，但临时状态
不能进入不可变 namespace，失败清理也不能成为协议正确性的前提。

## 7. 上层 RefStore

Ref 不保存在 S3。使用 PVLogS3Lite 的上层系统必须提供本地事务型 RefStore，例如 SQLite：

```rust
struct RefValue {
    format_version: u16,
    ref_id: String,
    lineage_id: [u8; 16],
    head: Fid,
    revision: u64,
    updated_at_ms: u64,
}
```

示例：

```json
{
  "format_version": 1,
  "ref_id": "main",
  "lineage_id": "550e8400e29b41d4a716446655440000",
  "head": "xxh3-128:abcdef...",
  "revision": 42,
  "updated_at_ms": 1785320000000
}
```

RefStore 记录的 `revision` 和 `lineage_id` 必须与目标 Head 一致。发布新 Head 必须在本地
数据库事务中执行 CAS：

```text
UPDATE refs
SET head = new_head, revision = new_revision
WHERE ref_id = target_ref
  AND head = expected_head
  AND revision = expected_revision
```

必须正好影响一条记录，否则表示并发冲突。不得无条件覆盖。

RefStore 是关键控制数据，必须位于持久卷并具备备份和恢复流程。若 RefStore 丢失，S3
对象可能仍然完整，但系统不能自动确定哪个 Head 是当前现实。S3 中可以保存不可变诊断或
恢复辅助对象，但它们不能成为正常挂载所依赖的可变 Ref。

快照名称、分支名称和 Pin 状态也属于上层 RefStore，不进入 S3 可变 Key。

仓库内 `SqliteRefStore` 将“首次初始化”和“打开既有库”分为两个入口。普通启动只允许
`openExisting`；数据库缺失、损坏、schema 不受支持或表不完整时停止启动，不能静默创建空库。
CAS 在 SQLite 事务中同时匹配 ref ID、旧 Head 和旧 revision，且 V1 每次只前进一个 revision。
在线一致性备份和恢复步骤见
[`runbooks/File Service RefStore 备份恢复.md`](./runbooks/File%20Service%20RefStore%20备份恢复.md)。

创世初始化先生成并持久化 revision 0 Checkpoint，再生成引用它的 revision 0 Head；两者均
完成读后 FID 与结构验证后，才用 `initializeWithRef` 发布 `main`。初始 SQLite 在同目录临时
文件中完整创建，关闭并清空 WAL 后通过 create-only 硬链接发布。失败最多留下不可达的不可变
对象，不会留下半初始化或空的权威 RefStore。

`FileContentStore` 强制执行 64 MiB 边界：小于等于边界时直接引用 Chunk，超过边界时按固定
大小写入 Chunk 并由 WASM 生成 Manifest。读取 Manifest 后从 WASM 取得文件长度、Chunk FID
和长度，随后逐 Chunk 读回并验证 FID、单块长度及总长度。2026-07-29 已在真实 R2 隔离前缀
验证 64 MiB + 1 字节得到两个 Chunk 和一个 Manifest，并完成逐块读回。

## 8. Head

Head 是不可变、内容寻址的文件系统版本根。

```rust
struct Head {
    format_version: u16,
    lineage_id: [u8; 16],
    root_entry_id: EntryId,
    revision: u64,

    parent_head: Option<Fid>,
    last_segment: Option<Fid>,
    checkpoint: Option<CheckpointRef>,

    created_at_ms: u64,
    writer_id: String,
}

struct CheckpointRef {
    fid: Fid,
    revision: u64,
    covered_segment: Option<Fid>,
}
```

字段语义：

- `format_version`：Head Schema 版本；
- `lineage_id`：稳定历史谱系身份；多个 Ref 和 Fork 可以共享同一 lineage；
- `root_entry_id`：该 lineage 唯一根目录的稳定身份，所有 Head 中保持不变；
- `revision`：该文件系统版本的严格递增序号；
- `parent_head`：前一个已发布 Head，用于历史、审计和 Fork；
- `last_segment`：该版本最新的 Segment；
- `checkpoint`：可选的回放基线；
- `created_at_ms`：展示和诊断时间，不参与提交顺序判定；
- `writer_id`：创建该版本的设备或进程标识。

规则：

1. 创世 Head 的 `revision = 0`、`parent_head = None`、`last_segment = None`。
2. 普通提交的新 Head revision 必须等于父 Head revision 加一。
3. `parent_head` 必须指向提交所基于的 Head。
4. `last_segment` 必须指向本次提交生成的 Segment。
5. Head 一旦上传不得修改。
6. Head FID 是快照、Fork 和版本恢复使用的稳定版本身份。
7. 根目录逻辑上始终存在，名称为空、没有父目录，不能移动、重命名或删除。

## 9. Segment

一个 Segment 表示一次原子文件系统事务。

```rust
struct Segment {
    format_version: u16,
    lineage_id: [u8; 16],

    base_head: Fid,
    previous_segment: Option<Fid>,
    revision: u64,

    transaction_id: [u8; 16],
    created_at_ms: u64,
    writer_id: String,
    operations: Vec<Operation>,
}
```

字段语义：

- `base_head`：本事务所基于的已发布 Head；
- `previous_segment`：日志链中前一个 Segment；
- `revision`：该 Segment 提交后对应的 revision；
- `transaction_id`：客户端生成的幂等事务标识；
- `operations`：按数组顺序原子执行的一组 Entry 操作。

约束：

1. Segment revision 必须等于 `base_head.revision + 1`。
2. Segment `previous_segment` 应等于 base Head 的 `last_segment`。
3. 一个 Segment 的 Operation 必须全部成功应用，否则该 Segment 无效。
4. 单个 Segment 内不允许引用尚未上传完成的 Manifest 或 Chunk。
5. Segment 上传不等于提交；只有新 Head 被上层 RefStore 发布后，Segment 才对当前文件系统可见。
6. Segment 大小应设置实现上限，初始建议 8 至 32 MiB；超出时应拆分上层事务或拒绝，而不是发布半个事务。

## 10. Operation

PVLogS3Lite 使用稳定 Entry ID 表示文件和目录身份。Entry ID 由操作系统 CSPRNG 生成随机
128 位值，创建后永不复用。路径由父目录关系和当前名称推导，不作为资源身份。

```rust
struct EntryId([u8; 16]);

enum Operation {
    CreateDirectory {
        entry_id: EntryId,
        parent_id: EntryId,
        name: String,
        mtime_ms: u64,
    },

    CreateFile {
        entry_id: EntryId,
        parent_id: EntryId,
        name: String,
        content: ContentRef,
        size: u64,
        mtime_ms: u64,
    },

    SetFileContent {
        entry_id: EntryId,
        expected_content: Option<Fid>,
        content: ContentRef,
        size: u64,
        mtime_ms: u64,
    },

    MoveEntry {
        entry_id: EntryId,
        new_parent_id: EntryId,
        new_name: String,
    },

    RemoveEntry {
        entry_id: EntryId,
        recursive: bool,
    },
}
```

### 10.1 CreateDirectory

- 创建一个目录；
- `entry_id` 不得已经存在或曾被当前 lineage 使用；
- 父目录必须存在，或在同一事务更早的位置创建；
- 同一父目录内名称冲突时拒绝；
- 根目录使用 lineage 创建时固定的保留 Entry ID，不通过普通 Operation 创建。

### 10.2 CreateFile

- 创建新文件 Entry；
- `entry_id` 不得已经存在或曾被当前 lineage 使用；
- 父目录必须存在；
- 同一父目录内名称冲突时拒绝；
- `content` 指向完整的新文件内容；
- `size` 必须与 ContentRef 表示的逻辑大小一致。

### 10.3 SetFileContent

- 只修改现有文件的内容、大小和修改时间；
- 不改变 Entry ID、名称或父目录；
- `expected_content` 存在时必须等于当前 ContentRef 的 FID，否则返回文件版本冲突；
- 文件历史由旧 Head 和旧 Segment 自然保存。

### 10.4 MoveEntry

- 原子移动或重命名文件/目录；
- Entry ID 保持不变；
- 新父目录必须存在且为目录；
- 同一父目录内名称冲突时拒绝；
- 不允许把目录移动到自身或自己的后代中；
- 初始版本不支持替换已有目标。

### 10.5 RemoveEntry

- 从新文件系统版本中逻辑删除文件或目录，不删除或修改任何已有 S3 对象；
- 删除非空目录必须设置 `recursive = true`；
- 删除后 Entry ID 不得分配给其他资源；
- 删除不存在 Entry 默认报冲突；
- 调用方需要幂等删除时应在生成 Segment 前把“不存在”转换为无操作。

### 10.6 名称与路径规范

持久 Entry 名称必须：

- 是 NFC 规范化 UTF-8；
- 非空；
- 不等于 `.` 或 `..`；
- 不包含 `/`、NUL 或控制字符；
- V1 不超过 255 个 UTF-8 字节。

逻辑路径使用 `/` 拼接祖先名称，只用于展示、查找和兼容路径型 API。大小写敏感性属于 lineage
配置，不能依赖 S3 Key 行为。读取方必须验证 Entry 图无环、父目录存在、同目录名称唯一。

## 11. 文件内容

### 11.1 ContentRef

```rust
enum ContentRef {
    Chunk {
        fid: Fid,
    },
    Manifest {
        fid: Fid,
    },
}
```

- `Chunk`：大小小于或等于 64 MiB 的文件，包括零字节文件；
- `Manifest`：大小超过 64 MiB 的文件，由固定 64 MiB Chunk 顺序组成。

初始版本不提供 Inline。`CreateFile.size` 和 `SetFileContent.size` 必须与 ContentRef 表示的
逻辑文件大小一致。

### 11.2 Chunk

Chunk 对象的持久内容就是原始文件字节，不增加协议头。其 FID 为原始字节的 XXH3-128。

固定参数：

```text
CHUNK_SIZE = 64 * 1024 * 1024
           = 67,108,864 bytes
```

规则：

- 文件大小小于或等于 64 MiB 时保存为单个 Chunk；
- 文件大小超过 64 MiB 时按 64 MiB 边界顺序分片；
- 最后一个 Chunk 可以小于 64 MiB；
- 空文件使用零字节 Chunk；
- 下载支持 Range GET；
- 客户端缓存以 FID 为 Key；
- Chunk 去重只由持久字节决定。

### 11.3 Manifest

```rust
struct Manifest {
    format_version: u16,
    file_size: u64,
    chunk_size: u64,
    chunks: Vec<ChunkRef>,
}

struct ChunkRef {
    fid: Fid,
    length: u64,
}
```

Manifest 规则：

1. `chunk_size` 必须等于 67,108,864；
2. 文件大小必须大于 `chunk_size`；
3. 除最后一项外，每个 Chunk 的 `length` 必须等于 `chunk_size`；
4. 最后一项长度必须在 `1..=chunk_size`；
5. 所有 `length` 之和必须等于 `file_size`；
6. Chunk 的逻辑 offset 由数组位置和 `chunk_size` 推导；
7. 每个被引用 Chunk 的实际长度和 FID 必须通过读取验证；
8. 一个 Chunk 可被不同文件或不同 Manifest 复用；
9. Manifest 自身按规范编码后计算 FID。

初始版本不引入 Overlay。随机小写通过重写受影响 Chunk 并生成新 Manifest 实现，其余 Chunk 继续复用。

未来如确有需求，可以在 Manifest Schema 中增加 Patch 表达，但不得为此修改 PVLog Operation 的语义。

## 12. Checkpoint

Checkpoint 是一个明确的完整路径状态快照，不是由大量伪操作组成的全量 Segment。

```rust
struct Checkpoint {
    format_version: u16,
    lineage_id: [u8; 16],
    revision: u64,
    covered_segment: Option<Fid>,
    entries: Vec<Entry>,
}

struct Entry {
    entry_id: EntryId,
    parent_id: Option<EntryId>,
    name: String,
    kind: EntryKind,
    created_at_ms: u64,
    mtime_ms: u64,
}

enum EntryKind {
    Directory,
    File {
        content: ContentRef,
        size: u64,
    },
}
```

规则：

1. Entry 按 `entry_id` 原始字节升序排序；
2. 显式保存唯一根目录 Entry，其 `parent_id = None`；
3. 每个非根 Entry 的父目录必须存在且为目录；
4. Entry ID 唯一，同一父目录内规范名称唯一；
5. Entry 图不得存在环；
6. 被删除的 Entry 不出现在当前 Checkpoint；
7. Checkpoint revision 表示它完整覆盖到的状态版本；
8. `covered_segment` 表示回放时的停止边界；
9. Checkpoint FID 必须针对最终规范编码字节计算；
10. Checkpoint 只影响加载速度，不改变逻辑文件系统语义。

初始版本可使用单个 Checkpoint 对象。只有在实际规模证明单对象不可接受后，才增加分片 Checkpoint；不能预先引入目录树或复杂索引协议。

建议触发条件：

- Checkpoint 后累计 Segment 数超过阈值；
- Checkpoint 后累计日志字节超过阈值；
- 空闲期间的周期性维护；
- 用户显式请求优化。

Checkpoint 创建应产生一个新的不可变 Head。新 Head 的逻辑文件状态与原 Head 相同，但它指向新的 Checkpoint。是否把这种维护 Head 展示为用户历史，由上层产品决定。

## 13. 提交流程

假设上层 RefStore 的 Ref R 指向 Head A：

```text
1. 在本地 RefStore 事务外读取 Ref R、Head A 和 revision
2. 下载并验证 Head A
3. 在本地状态上验证事务可应用
4. 生成并上传新增 Chunk
5. 生成并上传新增 Manifest
6. 生成并上传 Segment B
7. 生成并上传 Head B
8. 读取并验证 Head B 及本次新增引用已经可用
9. 在本地 RefStore 事务中执行 CAS：A → B
```

对象关系：

```text
Segment B:
  base_head       = Head A
  previous_segment = Head A.last_segment
  revision        = Head A.revision + 1

Head B:
  parent_head     = Head A
  last_segment    = Segment B
  revision        = Head A.revision + 1
```

只有第 9 步成功后，提交才正式发布。

第 4 至第 8 步失败：

- Ref 不变；
- 当前文件系统仍指向 Head A；
- 已上传对象成为不可达对象，由 V1 GC 报告记录但不删除。

第 9 步 CAS 失败：

- 表示另一个 Writer 已经更新 Ref；
- 不得无条件重试覆盖；
- 调用方必须重新读取最新 Head；
- 可以重新验证并生成新的 Segment；
- 目标 Entry 或预期内容变化时返回明确冲突。

S3 中没有提交发布点。Head B 上传完成只表示一个完整候选版本存在；本地 RefStore CAS 成功
才表示该版本成为当前现实。

## 14. 回放

加载 Head H 的流程：

```text
1. 下载并验证 Head H
2. 若 H 有 Checkpoint，下载并验证 Checkpoint
3. 用 Checkpoint entries 初始化路径索引
4. 从 H.last_segment 向 previous_segment 反向遍历
5. 到达 checkpoint.covered_segment 时停止
6. 反转收集到的 Segment
7. 按 revision 升序应用
8. 在每个 Segment 内按 operations 数组顺序应用
```

若无 Checkpoint，则遍历到 `previous_segment = None`。

回放必须验证：

- Head、Segment 和 Checkpoint 的 `lineage_id` 一致；
- revision 连续；
- Segment `base_head` 与相应提交历史一致；
- Segment 链不存在循环；
- Checkpoint revision 不大于 Head revision；
- Operation 的 Entry ID、父子关系、名称和引用合法；
- 引用的 Manifest 和 Chunk 存在且 FID、长度正确。

遇到损坏或缺失对象时，系统必须报告具体 FID 和引用来源，不得静默忽略 Record。

## 15. 快照

快照属于上层 RefStore，只保存不可变 Head FID：

```rust
struct SnapshotRef {
    format_version: u16,
    snapshot_id: [u8; 16],
    name: String,
    lineage_id: [u8; 16],
    head: Fid,
    created_at_ms: u64,
    pinned: bool,
}
```

创建快照不复制 Segment、Manifest 或 Chunk。

快照名称、Pin 和删除属于本地控制状态，不写入 S3 可变 Key。无论采用哪种产品语义，
快照指向的 Head 必须保持不可变。

## 16. Fork

创建 Fork：

```text
读取源 Ref 的 Head FID
        |
        v
在本地 RefStore 创建新 Ref，指向同一 Head
```

之后两个 Ref 可以各自发布新 Head：

```text
                   Head A
                  /      \
          Head main-B   Head fork-B
```

Fork 不复制历史对象和文件内容。新提交只上传发生变化的 Segment、Manifest 和 Chunk。

Head 使用 `lineage_id`，Ref 名称只表示具体分支或现实。因此 Fork 继承同一 lineage，
可以零对象创建并直接共享源 Head。

## 17. 历史与审计

Head 的 `parent_head` 构成版本历史，Segment 保存该版本的状态变化：

```text
Head 40 -> Head 41 -> Head 42
               |
               v
           Segment 41
           - MoveEntry
           - SetFileContent
```

文件历史通过 Entry ID 查找旧 Head/Segment 中相关的 `CreateFile`、`SetFileContent`、
`MoveEntry` 和 `RemoveEntry`，不再保存独立 `VersionAppend`。

为了加速历史查询，可以在本地数据库维护：

```text
entry_id -> [(revision, head_fid, operation_position)]
```

该索引必须可从 Head 和 Segment 重建，不能成为权威数据。

默认审计只记录状态变更，不记录文件读取、搜索或用户浏览行为。历史保留期属于产品策略，不属于对象格式。

## 18. 并发模型

### 18.1 单写者

单写者仍必须使用本地 RefStore CAS，以防进程重启、重复请求或意外的第二设备造成静默覆盖。

### 18.2 多写者

多写者冲突处理采用乐观并发：

1. 所有 Writer 从某个 Head 开始；
2. 首个成功 CAS 的 Writer 发布；
3. 其他 Writer 收到条件失败；
4. 失败 Writer 重新加载最新 Head；
5. 重新验证事务；
6. 无冲突则生成新 Segment并重试；
7. 有冲突则返回用户可理解的错误。

初始版本不自动产生多父 Head，也不实现三方合并。

可安全重放的典型操作：

- 在不同父目录或不同名称创建文件；
- 修改不同文件；
- 创建不同目录。

需要冲突的典型操作：

- 两个 Writer 修改同一文件；
- 一个 Writer 移动 Entry，另一个修改同一 Entry；
- 一个 Writer 删除目录，另一个在目录下创建文件。

## 19. 幂等性与重试

S3 请求和客户端提交可能在成功后丢失响应，因此所有阶段必须可重试：

- Chunk、Manifest、Segment、Head 通过内容寻址天然幂等；
- `transaction_id` 用于识别重复事务；
- 本地 RefStore CAS 防止重复发布覆盖新状态；
- 客户端在不确定本地事务是否成功时，必须重新读取 RefStore；
- 若 Ref 已指向预期 Head，视为提交成功；
- 若 Ref 仍指向旧 Head，可使用原 expected Head 和 revision 重试；
- 若 Ref 指向其他 Head，进入冲突处理。

## 20. 序列化与版本兼容

### 20.1 固定格式

Head、Segment、Checkpoint 和 Manifest 统一使用受限的 RFC 8949 Deterministic CBOR。

固定规则：

- 只使用 definite-length；
- 禁止 indefinite-length；
- 禁止浮点数；
- 整数使用最短编码；
- Map Key 使用固定非负整数；
- Map Key 按 Deterministic CBOR 规则排序；
- 文本必须是 NFC 规范化 UTF-8；
- 时间统一为非负 `u64` 毫秒；
- FID、Entry ID、lineage ID 和 transaction ID 使用固定长度 byte string；
- Enum 使用冻结的非负整数判别值；
- 每个顶层对象包含对象类型和格式版本；
- 未知字段默认拒绝，除非新格式版本明确允许；
- 初始版本不使用 CBOR tag。

对象类型固定为：

```text
1 = Head
2 = Segment
3 = Checkpoint
4 = Manifest
```

每种对象必须维护跨语言黄金测试向量：

```text
逻辑对象
→ 预期 CBOR 十六进制
→ 预期 XXH3-128 FID
```

Rust、TypeScript 和其他实现必须产生相同字节和 FID。编码库升级不得改变已发布格式。
协议演进使用新的顶层 `format_version`；不得重新解释旧版本字段或 Enum 判别值。

## 21. 完整性与安全

最低要求：

- 每个不可变对象下载后验证 XXH3-128 FID；
- 上传使用 TLS；
- S3 凭证采用最小权限；
- 不可变对象前缀禁止无条件覆盖；
- S3 中不存在 Ref 前缀；
- 第三方应用不能访问 S3 凭据、Key 或任意 FID 读取接口；
- 不信任持久 Entry、名称、父子关系和长度字段；
- 对对象大小、集合长度、递归深度和回放 Segment 数设置上限；
- 防止 Segment 链循环；
- 防止 Entry 图循环、Manifest 长度错误和整数溢出；
- 日志和错误消息不得输出 S3 密钥。

如果使用客户端加密：

- 加密应发生在计算持久 FID 之前或之后，必须由未来协议版本统一规定；
- 随机加密会降低跨版本去重；
- 收敛加密会引入信息泄露风险；
- V1 不定义协议层加密，依赖 TLS 和 S3 静态加密能力。

## 22. Checkpoint 与历史保留

Checkpoint 只优化读取，不自动表示可以删除旧历史。

建议把策略分开：

```text
Checkpoint 策略：
  控制挂载和回放成本

历史策略：
  控制 Head、Segment 和旧内容保留时间

GC 策略：
  V1 只报告从所有根不可达的对象，不删除
```

建议的个人系统默认历史策略：

- 最近 24 小时保留较密版本；
- 最近 30 天保留每日版本；
- 更早版本按月保留；
- 用户固定快照永久保留；
- 不可达对象进入候选报告；V1 不执行删除。

这些数值为产品默认建议，不是协议强制要求。

## 23. 垃圾回收

### 23.1 GC 根

GC 根至少包括：

- 上层 RefStore 当前 Ref 指向的 Head；
- 上层 RefStore 快照指向的 Head；
- RefStore 备份中仍受保护的 Head；
- 保留策略要求保留的历史 Head；
- 正在执行或宽限期内的事务对象；
- 管理员明确 Pin 的对象。

GC 扫描必须使用 RefStore 的一致性快照。RefStore 不可用、备份状态不明或扫描不完整时，
不得生成可执行删除结论。

### 23.2 可达性遍历

```text
Ref / Snapshot
  -> Head
     -> parent Head（保留策略允许时）
     -> Segment
     -> Checkpoint
        -> Manifest
           -> Chunk
```

Segment 中的 `CreateFile` 和 `SetFileContent` 也可能直接引用 Manifest 或 Chunk。

### 23.3 V1 报告规则

V1 GC 只有在以下条件都成立时，才把对象列为候选：

1. 不可从任何 GC 根到达；
2. 首次发现时间和最后确认时间可记录；
3. 不属于仍在进行的上传；
4. 未被显式 Pin；
5. 最近一次完整 GC 标记成功完成。

候选报告本身不授予删除权限。V1 正常 File Service 和 GC Scanner 都没有 `DeleteObject` 权限。

未来删除版 GC 必须作为独立协议阶段引入，至少要求：

- 独立最小权限凭据；
- 两次成功扫描；
- 至少 30 天宽限期；
- RefStore 备份验证；
- 可审阅删除计划；
- 恢复演练。

## 24. 故障语义

| 故障点 | 结果 |
|---|---|
| Chunk 上传失败 | 当前 Ref 不变，可重试 |
| Manifest 上传失败 | 当前 Ref 不变，已上传 Chunk 暂时不可达 |
| Segment 上传失败 | 当前 Ref 不变 |
| Head 上传失败 | 当前 Ref 不变 |
| 本地 RefStore CAS 失败 | 并发冲突，不能覆盖 |
| 本地事务结果不确定 | 重新读取 Ref 判断是否已提交 |
| RefStore 丢失 | 停止挂载和 GC，使用本地备份恢复 |
| 当前 Head 损坏 | 尝试用户快照、RefStore 备份或已知父 Head 恢复 |
| Segment 缺失 | 该 Head 不可完整回放，报告缺失 FID |
| Checkpoint 损坏 | 若完整旧 Segment 仍保留，可退化为日志回放 |
| Chunk 缺失 | 对应文件内容不可用，但应尽量允许诊断其余路径 |
| FID 相同但字节不同 | 报告 `FID_COLLISION`，停止读写相关对象 |

实现应提供离线验证工具，能够：

- 验证 Ref 与 Head；
- 遍历 Head/Segment 链；
- 校验 revision 和 parent 关系；
- 校验 Checkpoint；
- 校验 Manifest 和 Chunk FID；
- 输出缺失及不可达对象报告；
- 在不修改 S3 的模式下运行。

## 25. 性能原则

初始优化重点：

- 在本地缓存 Head、Checkpoint、Segment、Manifest 和常用 Chunk；
- 将一次用户事务批量写入一个 Segment；
- 避免每个小文件操作立即创建 Checkpoint；
- 大文件并发上传 Chunk；
- 使用 Range GET 或按 Chunk 精确读取；
- 限制并发请求数量；
- 对重复内容先计算 XXH3-128 并复用已有对象。

不应为了减少一个 S3 PUT 而删除不可变 Head。Head 是版本身份和原子发布模型的核心，其对象很小，保留这一层的收益高于请求成本。

## 26. 与原 PVLog V2 的关系

PVLogS3Lite 保留：

- 不可变内容寻址 Head；
- 不可变 Segment 链；
- Head 作为快照与 Fork 根；
- 按顺序回放 Entry 状态变化；
- 内容对象引用；
- 定期生成全量状态以限制回放成本。

PVLogS3Lite 简化：

- S3 只保存不可变对象，当前 Head 指针回到上层本地 RefStore；
- 所有对象统一使用无 seed 的 XXH3-128 FID；
- 文件和目录使用随机 128 位稳定 Entry ID；
- 将路径型 PutFile 操作改为 Entry 创建、内容更新、移动和删除；
- 删除显式 `VersionAppend`；
- 将 Direct、Manifest、Overlay 从 PVLog Record 移到内容层；
- 将全量 Frame 明确建模为 Checkpoint；
- 删除没有稳定语义的 flags、nonce 等字段；
- 使用上层本地 RefStore CAS 检测并发写；
- V1 GC 只生成不可达对象报告，不删除协议对象。

## 27. 最小实施阶段

### 阶段一：核心存储

- FID、Entry ID 和 Deterministic CBOR；
- S3 ObjectStore；
- Chunk 和 Manifest；
- Head 和 Segment；
- Entry 操作与状态索引；
- 本地 SQLite RefStore 创建、备份与 CAS 更新；
- 从无 Checkpoint 的完整日志回放；
- 完整性验证工具。

### 阶段二：可用性

- 本地元数据缓存；
- Checkpoint 创建与加载；
- 快照；
- Fork；
- 历史浏览；
- 冲突错误与安全重试。

### 阶段三：维护

- 历史保留策略；
- GC 标记和报告；
- 损坏扫描与恢复工具；
- 性能压测。

以下功能只有在真实需求和数据证明必要时才增加：

- Overlay；
- Checkpoint 分片；
- 自动冲突合并；
- 多父 Head；
- 内容定义分块；
- 更复杂的目录索引。

## 28. 核心不变量

实现和测试必须维护以下不变量：

1. 本地 RefStore 只能指向已经完整上传并验证的 Head。
2. Head、Segment、Checkpoint、Manifest 和 Chunk 一旦创建不可覆盖。
3. Head FID 唯一确定一个逻辑文件系统版本。
4. Segment 中所有 Operation 原子生效。
5. 本地 RefStore CAS 是提交的唯一发布点。
6. 发布失败不得改变旧 Head 表示的状态。
7. Checkpoint 只能优化回放，不能改变回放结果。
8. 从 Checkpoint 加增量 Segment 得到的状态必须等于从历史起点完整回放的状态。
9. 快照和 Fork 只增加引用，不复制已有内容对象。
10. V1 File Service 和 GC Scanner 不得删除任何协议对象。
11. 时间戳不能决定提交顺序，revision 和引用关系才是顺序依据。
12. 文件内容组织方式的演进不得要求重定义旧 PVLog Operation。
13. Entry ID 在创建后稳定且永不复用。
14. 重命名、移动和内容更新不得改变 Entry ID。
15. 所有读取对象必须重新计算并验证 XXH3-128 FID。
16. S3 中不得保存正常运行依赖的可变 Ref。

## 29. 总结

PVLogS3Lite 的核心定义是：

```text
本地 RefStore 是可变发布点
S3 只保存不可变对象
Head 是不可变版本身份
Segment 是原子 Entry 变化
Checkpoint 是回放加速
Manifest 和 Chunk 是文件内容
XXH3-128 FID 提供寻址、校验与去重
```

它继续采用日志式文件系统状态模型，而不是改成目录 Merkle DAG。不可变 Head 保证快照、
历史和 Fork 的稳定身份；稳定 Entry ID 保证资源在重命名和移动后的连续身份；Segment
保持写入简单；Checkpoint 限制回放成本；本地 RefStore CAS 提供清晰的原子发布与冲突检测。

该设计优先解决个人文件系统真正需要的问题，同时避免引入收益不明确的分布式合并、
复杂树结构、在线精确 GC 和 S3 可变控制状态。
