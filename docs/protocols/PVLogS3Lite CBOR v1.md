# PVLogS3Lite CBOR v1

## 1. 状态与范围

- 状态：格式基线候选
- 版本：1
- 规范编码：RFC 8949 确定性 CBOR 的受限子集
- FID：`XXH3-128(seed=0, persisted_bytes)`，以 16 字节大端序表示

本文只冻结 PVLogS3Lite V1 不可变对象的持久字节格式。对象的事务、RefStore、
WORM 写入与安全边界由《PVLogS3Lite 设计规范》定义。

## 2. 通用编码规则

1. 只允许确定长度的 map、array、byte string 和 text string。
2. map key 均为非负整数，按数值严格递增编码。
3. 整数必须使用能容纳该值的最短 CBOR 表示。
4. 文本必须是合法 UTF-8；名称合法性由上层协议校验。
5. FID、Entry ID、lineage ID 和 transaction ID 均编码为恰好 16 字节的 byte string，
   不编码为十六进制文本。
6. 时间为 Unix epoch 毫秒的无符号整数。
7. 可选引用不存在时编码为 CBOR `null`，字段本身不能省略。
8. 解码器必须拒绝重复 key、未知 object type、非 `1` 的 format version、类型错误、
   非规范整数、非递增 key 和超出实现上限的数据。
9. Checkpoint 的 entries 必须按 Entry ID 的 16 字节词典序升序编码。
10. V1 编码器不得添加本文未定义的字段；扩展需要新 format version。

实现上限属于 ABI/运行时约束而不是持久格式。V0.1 Core 单个编码对象最大 32 MiB，
Entry 名称最大 255 个 UTF-8 字节；超过上限必须在分配或解析大对象前拒绝。

所有顶层对象均以字段 `0` 表示 object type，以字段 `1` 表示 format version。

| object type | 值 |
|---|---:|
| Head | 1 |
| Segment | 2 |
| Checkpoint | 3 |
| Manifest | 4 |

## 3. Head

| key | 字段 | CBOR 类型 |
|---:|---|---|
| 0 | object type，固定为 `1` | uint |
| 1 | format version，固定为 `1` | uint |
| 2 | lineage ID | bytes(16) |
| 3 | root Entry ID | bytes(16) |
| 4 | revision | uint |
| 5 | parent Head FID | bytes(16) / null |
| 6 | last Segment FID | bytes(16) / null |
| 7 | CheckpointRef | map / null |
| 8 | created at ms | uint |
| 9 | writer ID | text |

CheckpointRef：

| key | 字段 | CBOR 类型 |
|---:|---|---|
| 0 | Checkpoint FID | bytes(16) |
| 1 | revision | uint |
| 2 | covered Segment FID | bytes(16) / null |

## 4. Segment 与操作

| key | 字段 | CBOR 类型 |
|---:|---|---|
| 0 | object type，固定为 `2` | uint |
| 1 | format version，固定为 `1` | uint |
| 2 | lineage ID | bytes(16) |
| 3 | base Head FID | bytes(16) |
| 4 | previous Segment FID | bytes(16) / null |
| 5 | revision | uint |
| 6 | transaction ID | bytes(16) |
| 7 | created at ms | uint |
| 8 | writer ID | text |
| 9 | operations | array |

每个 operation 是整数 key map，字段 `0` 是操作类型：

| 类型 | 值 | 其余字段 |
|---|---:|---|
| CreateDirectory | 1 | `1 entry_id`, `2 parent_id`, `3 name`, `4 mtime_ms` |
| CreateFile | 2 | `1 entry_id`, `2 parent_id`, `3 name`, `4 content`, `5 size`, `6 mtime_ms` |
| SetFileContent | 3 | `1 entry_id`, `2 expected_content_fid/null`, `3 content`, `4 size`, `5 mtime_ms` |
| MoveEntry | 4 | `1 entry_id`, `2 new_parent_id`, `3 new_name` |
| RemoveEntry | 5 | `1 entry_id`, `2 recursive` |

`content` 是 `{0: kind, 1: fid}`；kind `1` 表示单 Chunk，kind `2` 表示 Manifest。
`expected_content_fid` 只携带预期 FID；其对象类别由当前 Entry 状态确定。

## 5. Manifest

| key | 字段 | CBOR 类型 |
|---:|---|---|
| 0 | object type，固定为 `4` | uint |
| 1 | format version，固定为 `1` | uint |
| 2 | file size | uint |
| 3 | chunk size，固定为 `67108864` | uint |
| 4 | chunks | array |

每个 chunk 是 `{0: fid bytes(16), 1: length uint}`。Manifest 只用于大于 64 MiB
的文件，至少包含两个 chunk；除最后一个 chunk 外长度必须为 64 MiB，最后一个长度为
`1..=64 MiB`，所有长度之和必须等于 file size。小于等于 64 MiB 的文件直接引用 Chunk。

## 6. Checkpoint

| key | 字段 | CBOR 类型 |
|---:|---|---|
| 0 | object type，固定为 `3` | uint |
| 1 | format version，固定为 `1` | uint |
| 2 | lineage ID | bytes(16) |
| 3 | revision | uint |
| 4 | covered Segment FID | bytes(16) / null |
| 5 | entries | array |

Entry 通用字段：

| key | 字段 | CBOR 类型 |
|---:|---|---|
| 0 | Entry ID | bytes(16) |
| 1 | parent Entry ID；根目录为 null | bytes(16) / null |
| 2 | name；根目录为空字符串 | text |
| 3 | kind；Directory `1`，File `2` | uint |
| 4 | created at ms | uint |
| 5 | mtime ms | uint |

File 额外包含 `6 content` 和 `7 size`；Directory map 不包含这两个字段。

## 7. 一致性向量

机器可读黄金向量位于
[`pvlog-cbor-v1-vectors.json`](./pvlog-cbor-v1-vectors.json)。实现必须同时匹配：

- 完整 CBOR 十六进制字节；
- 对该字节计算得到的 32 位小写十六进制 XXH3-128 FID。

向量是格式兼容性约束，不只是测试样例。修改任一既有向量意味着不兼容的格式变更。

仓库内 Rust PVLog Core 已实现 Head、Segment、Checkpoint 和 Manifest 的严格解码与
重新编码一致性检查。Checkpoint 解码还验证唯一根目录、Entry ID 唯一、父目录存在且类型正确、
同目录名称唯一以及父子图无环。原生核心与 WASM 导出使用同一实现和同一组黄金向量。

服务端加载仓库内由该 Rust crate 生成的 ABI v1 WASM 产物；产物只包含纯计算能力，并随
Docker 镜像复制，不在运行时下载。`npm run build:pvlog-wasm` 是唯一再生成入口，生成后必须
运行 Rust 测试、黄金向量检查和服务端 packaged-WASM 测试。

Checkpoint Entry 投影是实现内部的 WASM ABI，不属于持久 CBOR 格式，也不参与 FID。它可以
随 ABI major version 演进，但不能改变相同 Checkpoint 字节的协议解释。
