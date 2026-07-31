# Biunivers 文档索引

## V0.1：已完成并归档

归档日期：2026-07-28

实现基线：`8586732 implement browser desktop V0.1`

| 文档 | 状态 | 用途 |
|---|---|---|
| [V0.1 需求方案](浏览器云端个人桌面%20V0%201%20需求方案.md) | 已完成 | 已交付功能范围、成功标准和最终验收清单 |
| [V0.1 技术设计](浏览器云端个人桌面%20V0.1%20技术设计.md) | 已实施 | 架构决策、WinBox 生命周期、状态模型和风险记录 |
| [V0.1 施工计划](浏览器云端个人桌面%20V0.1%20施工计划.md) | 施工完成 | 六阶段实施过程、验收映射和完工记录 |

## V0.2：已完成并归档

归档版本：`v0.2.0`

| 文档 | 状态 | 内容 |
|---|---|---|
| [V0.2 需求方案](<浏览器云端个人桌面 V0.2 需求方案.md>) | 已实施 | 第三方静态应用检查、安装、运行和生命周期的产品闭环 |
| [V0.2 技术设计](<浏览器云端个人桌面 V0.2 技术设计.md>) | 已实施 | 单进程双 origin、管理 API、GitHub source、JSON 持久化和前端集成 |
| [V0.2 施工计划](<浏览器云端个人桌面 V0.2 施工计划.md>) | 施工完成 | 七阶段任务、测试矩阵和人工验收记录 |

Static App、Manifest 和 Management Protocol v1 仍保持发布候选/草案状态；这是协议冻结策略，
不影响 V0.2 产品里程碑已经交付。

## V0.3：File Service 已完成并归档

归档版本：`v0.3.0`

| 文档 | 状态 | 内容 |
|---|---|---|
| [V0.3 施工与验收归档](<浏览器云端个人桌面 V0.3 施工与验收归档.md>) | 已归档 | 交付范围、实施结果、质量门禁、运维入口和后续边界 |
| [Biunivers File Service V0.1](<Biunivers File Service V0.1 设计.md>) | 已实施 | 不可变文件模型、句柄、Host API、流式传输和安全边界 |
| [File Service V0.1 首轮验收](<acceptance/File Service V0.1 首轮验收.md>) | 已通过 | 真实 R2、记事本、分片、重启、备份恢复和 GC 验收证据 |
| [File Service RefStore 备份恢复](<runbooks/File Service RefStore 备份恢复.md>) | 当前运维手册 | SQLite 在线备份、恢复、内容扫描和只读 GC |
| [Biunivers Host API v1](<protocols/Biunivers Host API v1.md>) | 已实现 | 第三方应用文件选择、读写传输、元数据、释放和冲突语义 |
| [Biunivers Resource Session Protocol v1](<developer-kit/v1/BIUNIVERS_RESOURCE_SESSION_PROTOCOL_V1.md>) | 已实现 | 主推的可续租资源会话、重复 GET、Range 读取和完整保存 |

Static App Protocol v1 的安装校验要求第三方仓库携带逐字一致的冻结原文，因此原文中
“V1 不提供 Host API”保留其发布时语境，不做原地修改。V0.3 文件能力由独立、可选的
`biunivers.host-api/1` 增加；它不改变 `biunivers.static-app/1` 的安装契约。

## 存储设计与决策

| 决策 | 状态 | 内容 |
|---|---|---|
| [ADR-0001：应用接入与特权边界](decisions/0001-应用接入与特权边界.md) | 已接受 | internal 编译期白名单、第三方静态应用/iframe/external、GitHub 安装边界及未来资源交换原则 |
| [ADR-0002：第三方应用使用独立 Origin](decisions/0002-第三方应用使用独立-Origin.md) | 已接受 | 文件 capability 的应用级 origin 隔离 |
| [PVLogS3Lite](PVLogS3Lite.md) | 规范评审通过 | S3 不可变对象、XXH3-128 FID、稳定 Entry ID、64 MiB 分片和本地 RefStore |
| [PVLogS3Lite CBOR v1](<protocols/PVLogS3Lite CBOR v1.md>) | 格式基线候选 | 已实现的确定性 CBOR 字段编号、对象类型和跨实现黄金向量 |
| [Biunivers 数据卷备份恢复](<runbooks/Biunivers 数据卷备份恢复.md>) | 当前运维手册 | `/data` 整卷一致性备份、非破坏性恢复演练和单写者切换原则 |

## V0.4：文件管理器已完成并归档

归档版本：`v0.4.0`

| 文档 | 状态 | 内容 |
|---|---|---|
| [V0.4 文件管理器需求方案](<浏览器云端个人桌面 V0.4 文件管理器需求方案.md>) | 设计基线 | internal 权限、用户闭环、PVLog 语义和非目标 |
| [V0.4 文件管理器技术设计](<浏览器云端个人桌面 V0.4 文件管理器技术设计.md>) | 设计基线 | internal 实例、管理 API、事务校验、上传下载和历史兼容 |
| [V0.4 文件管理器施工计划](<浏览器云端个人桌面 V0.4 文件管理器施工计划.md>) | 验收完成 | 五阶段任务、验收记录、出口条件和合并门槛 |

## V0.5：资源打开验收完成

| 文档 | 状态 | 内容 |
|---|---|---|
| [V0.5 资源打开设计](<浏览器云端个人桌面 V0.5 资源打开设计.md>) | 评审通过 | 应用自报 Handler、系统默认关联、打开方式、窗口启动上下文和 capability 重新签发 |
| [V0.5 资源打开规范评审](<浏览器云端个人桌面 V0.5 资源打开规范评审.md>) | 评审通过 | 必要性审查、七项冻结决策、单实例窗口修正和实施门槛 |
| [V0.5 资源打开技术设计](<浏览器云端个人桌面 V0.5 资源打开技术设计.md>) | 已实现 | Handler 安装投影、默认关联、Pending Launch、claim 和 Launch Broker |
| [V0.5 资源打开施工计划](<浏览器云端个人桌面 V0.5 资源打开施工计划.md>) | 验收完成 | 主仓库七阶段实施、记事本适配、真实环境验收和合并门槛 |
| [V0.5 资源打开验收](<acceptance/V0.5 资源打开验收.md>) | 已通过 | 自动化门槛、真实 R2/Notepad 验收、缺陷修复和合并结论 |

归档版本：`v0.5.0`

## V0.6：文件管理器可用性验收完成

归档版本：`v0.6.0`

| 文档 | 状态 | 内容 |
|---|---|---|
| [V0.6 文件管理器可用性需求](<浏览器云端个人桌面 V0.6 文件管理器可用性需求.md>) | 设计基线 | 新建空文件、零拷贝复制文件、加载反馈和非目标 |
| [V0.6 文件管理器可用性技术设计](<浏览器云端个人桌面 V0.6 文件管理器可用性技术设计.md>) | 设计基线 | internal API、FID 复用、事务 CAS、前端状态和失败边界 |
| [V0.6 文件管理器可用性施工计划](<浏览器云端个人桌面 V0.6 文件管理器可用性施工计划.md>) | 验收完成 | 服务端、文件管理器体验、真实验收和合并门槛 |
| [V0.6 文件管理器可用性验收](<acceptance/V0.6 文件管理器可用性验收.md>) | 已通过 | 自动化、Docker/R2、零拷贝证据、冲突和重启恢复 |

## V0.7：桌面表面自由布局验收完成

归档版本：`v0.7.0`

| 文档 | 状态 | 内容 |
|---|---|---|
| [ADR-0003：桌面表面使用稳定引用表](decisions/0003-桌面表面使用稳定引用表.md) | 已接受 | 非链接文件的引用表、内建 Resolver、长期 handle 与 capability 边界 |
| [V0.7 桌面表面需求方案](<浏览器云端个人桌面 V0.7 桌面表面需求方案.md>) | 设计基线 | 应用/文件/目录引用、框选、自由拖动、自动对齐和生命周期 |
| [V0.7 桌面表面技术设计](<浏览器云端个人桌面 V0.7 桌面表面技术设计.md>) | 评审通过 | SQLite/CAS、Resolver、像素布局、右键菜单、碰撞和迁移 |
| [V0.7 桌面表面施工计划](<浏览器云端个人桌面 V0.7 桌面表面施工计划.md>) | 验收完成 | 五阶段实施、验收矩阵和合并门槛 |
| [V0.7 桌面表面验收](<acceptance/V0.7 桌面表面验收.md>) | 已通过 | 自动化、真实 Docker/R2、自由布局、生命周期和并发验收 |

## V0.10：目录 ZIP 导出验收完成

归档版本：`v0.10.0`

| 文档 | 状态 | 内容 |
|---|---|---|
| [V0.10 目录 ZIP 导出设计](<浏览器云端个人桌面 V0.10 目录 ZIP 导出设计.md>) | 已归档 | 复用下载按钮、internal 快照、流式 ZIP Store、进度、取消与安全边界 |
| [V0.10 目录 ZIP 导出施工计划](<浏览器云端个人桌面 V0.10 目录 ZIP 导出施工计划.md>) | 验收完成 | ZIP 核心、快照服务、HTTP、文件管理器集成和真实验收 |
| [V0.10 目录 ZIP 导出验收](<acceptance/V0.10 目录 ZIP 导出验收.md>) | 已通过 | 自动化证据与真实 Docker/R2 浏览器验收结果 |

## V0.11：Wormhole Linux/rclone 验收完成

版本候选：`v0.11.0`

| 文档 | 状态 | 内容 |
|---|---|---|
| [V0.11 Wormhole 需求方案](<浏览器云端个人桌面 V0.11 Wormhole 需求方案.md>) | 设计基线 | 按需 WebDAV 通道、internal 应用、临时密码、原生连接与 rclone 用户路径 |
| [V0.11 Wormhole 技术设计](<浏览器云端个人桌面 V0.11 Wormhole 技术设计.md>) | 设计基线 | 认证生命周期、WebDAV 方法、PVLog 映射、流式 IO、锁、并发与安全边界 |
| [V0.11 Wormhole 规范评审](<浏览器云端个人桌面 V0.11 Wormhole 规范评审.md>) | 评审通过 | 必要性、保留与延期项、风险审查及闭环结论 |
| [V0.11 Wormhole 施工计划](<浏览器云端个人桌面 V0.11 Wormhole 施工计划.md>) | 收尾中 | 控制面、只读、写入、兼容、界面和真实验收六阶段 |
| [V0.11 Wormhole 验收](<acceptance/V0.11 Wormhole 验收.md>) | Linux/rclone 已通过 | Docker/R2、WebDAV CRUD、Range、挂载与跨分片大文件证据；原生 Windows/macOS 待补 |

## V0.12：文件视觉身份设计

| 文档 | 状态 | 内容 |
|---|---|---|
| [V0.12 普通文件 Identicon 设计](<浏览器云端个人桌面 V0.12 普通文件 Identicon 设计.md>) | 设计基线候选 | 仅替换无专用图标普通文件的默认符号；Entry ID 稳定身份、Jdenticon 包体门槛和四处共享渲染 |

## V0.12：Open Resource v1.1 多资源交付

里程碑：`v0.12.0`

| 文档 | 状态 | 内容 |
|---|---|---|
| [Open Resource v1.1 协议](developer-kit/v1/BIUNIVERS_OPEN_RESOURCE_PROTOCOL_V1_1.md) | 已实现 | `resource.openMany`、Handler `multiple`、批量 Launch、独立 Session 和兼容边界 |
| [Open Resource v1.1 Handler Schema](developer-kit/v1/biunivers.open-resource-v1.1.schema.json) | 已实现 | v1.1 严格声明格式，不修改 v1 Schema |
| [Open Resource v1.1 openMany 请求 Schema](developer-kit/v1/biunivers.open-resource-v1.1.message.schema.json) | 已实现 | 复用 Resource Session v1 消息通道的严格多选请求 |
| [Open Resource v1.1 技术设计](<浏览器云端个人桌面 Open Resource v1.1 技术设计.md>) | 实现基线 | 版本化安装、共同 Handler、批量签发、多选 picker 和 Pending Launch 集合化 |
| [Open Resource v1.1 规范评审](<浏览器云端个人桌面 Open Resource v1.1 规范评审.md>) | 评审通过 | 必要性、协议数量、只读授权边界、兼容与风险控制 |
| [Open Resource v1.1 施工计划](<浏览器云端个人桌面 Open Resource v1.1 施工计划.md>) | 已完成 | 六阶段实现、自动验证、真实应用验收和合并门槛 |
| [Open Resource v1.1 多资源验收](<acceptance/Open Resource v1.1 多资源验收.md>) | 已通过 | 全量测试、Docker、BiuniView 主动多选与批量 Launch、旧版单资源兼容 |

## V0.13：Workspace Runtime

归档版本：`v0.13.0`

| 文档 | 状态 | 说明 |
| --- | --- | --- |
| [V0.13 Workspace Runtime 技术设计](<浏览器云端个人桌面 V0.13 Workspace Runtime 技术设计.md>) | 总设计通过 | 选择集派生、固定 HEAD PVLogFS、COW 挂载、沙箱 Run、提交、Diff 与导回 |
| [V0.13 Workspace Runtime 规范评审](<浏览器云端个人桌面 V0.13 Workspace Runtime 规范评审.md>) | 评审通过 | 自洽性、冗余删减、风险和挂载技术探针 Go/No-Go |
| [V0.13 Workspace Runtime 路线图](<浏览器云端个人桌面 V0.13 Workspace Runtime 路线图.md>) | 已完成 | 挂载探针、局部设计、控制面、产品闭环和里程碑阶段出口 |
| [V0.13 Workspace 挂载技术探针](<acceptance/V0.13 Workspace 挂载技术探针.md>) | 挂载探针通过 | 无特权 FUSE/COW、Docker 隔离、真实固定 PVLog HEAD、按需跨分片 Range 与异常清理 |
| [V0.13 Workspace 控制面局部设计](<浏览器云端个人桌面 V0.13 Workspace 控制面局部设计.md>) | 已冻结 | Workspace/Ref/Run Schema、状态机、事务、恢复、GC root |
| [V0.13 PVLogFS 与 Compute Runtime 局部设计](<浏览器云端个人桌面 V0.13 PVLogFS 与 Compute Runtime 局部设计.md>) | 已冻结 | 固定 Snapshot、完整 Chunk 校验缓存、挂载、窄 Runtime API 与沙箱 |
| [V0.13 COW 提交、Diff 与导回局部设计](<浏览器云端个人桌面 V0.13 COW 提交、Diff 与导回局部设计.md>) | 已冻结 | Upper 解释、发布 CAS、Diff、原子导回与丢弃 |
| [V0.13 Workspace Runtime 施工计划](<浏览器云端个人桌面 V0.13 Workspace Runtime 施工计划.md>) | 已完成 | RefStore、派生、系统应用、PVLogFS、Runtime、提交、导回和恢复的阶段出口 |
| [V0.13 Workspace 控制面首轮验收](<acceptance/V0.13 Workspace 控制面首轮验收.md>) | 已通过 | Schema v2、原子迁移、Workspace/Run、单写租约、Ref-aware 与多 Ref GC roots |
| [V0.13 Workspace Runtime 里程碑验收](<acceptance/V0.13 Workspace Runtime 里程碑验收.md>) | 已通过 | 固定 HEAD、真实 PVLogFS、隔离沙箱、COW 提交、崩溃恢复、Diff、导回与备份恢复 |

## V0.14：Biunivers Workspace Application

| 文档 | 状态 | 说明 |
| --- | --- | --- |
| [V0.14 Biunivers Workspace Application 概念设计](<浏览器云端个人桌面 V0.14 Biunivers Workspace Application 概念设计.md>) | 第三版概念已冻结 | OCI repository 身份、容器 HTTP UI、Workspace 状态、Application Manager、动态配置与信任边界 |
| [V0.14 Registry、Image 与持久 Schema 局部设计](<浏览器云端个人桌面 V0.14 Registry、Image 与持久 Schema 局部设计.md>) | 实现基线 | GHCR 镜像固定、Application/Instance Schema、Workspace 独占绑定和敏感变量边界 |
| [V0.14 Registry、Image 与持久 Schema 规范评审](<浏览器云端个人桌面 V0.14 Registry、Image 与持久 Schema 规范评审.md>) | 评审通过 | 第一施工切片的必要性、删减项、事务闭环和风险门禁 |
| [V0.14 Workspace Application 施工计划](<浏览器云端个人桌面 V0.14 Workspace Application 施工计划.md>) | 施工中 | Registry/Image、Lifecycle、Proxy/UI 三段纵向闭环及 `v0.14.0` 合并门槛 |
| [V0.14-A BWA Registry 与 Image 验收](<acceptance/V0.14-A BWA Registry 与 Image 验收.md>) | 已通过 | 公开 GHCR、真实 Runtime socket、固定 digest、持久 Schema、空白 Instance 与 secret 边界 |
| [V0.14 Lifecycle、提交与异常恢复局部设计](<浏览器云端个人桌面 V0.14 Lifecycle、提交与异常恢复局部设计.md>) | 实现基线 | 动态 BWA Run、结束分类、正常提交、保存重启、受控关机和异常 Upper 门禁 |
| [V0.14 Lifecycle、提交与异常恢复规范评审](<浏览器云端个人桌面 V0.14 Lifecycle、提交与异常恢复规范评审.md>) | 评审通过 | 必要性、过度设计删减、状态自洽性、风险和分段施工门 |
| [V0.14 Lifecycle、提交与异常恢复阶段验收](<浏览器云端个人桌面 V0.14 Lifecycle、提交与异常恢复阶段验收.md>) | 阶段通过 | 真实 BWA、异常 Upper、保存重启、受控/非受控恢复、更新门和回退出口 |
| [V0.14 Runtime Proxy、网络与 iframe 局部设计](<浏览器云端个人桌面 V0.14 Runtime Proxy、网络与 iframe 局部设计.md>) | 实现基线 | 稳定 Instance origin、bootstrap 会话、bridge endpoint、HTTP/WebSocket 代理和宿主故障页 |
| [V0.14 Runtime Proxy、网络与 iframe 规范评审](<浏览器云端个人桌面 V0.14 Runtime Proxy、网络与 iframe 规范评审.md>) | 评审通过 | 必要性、身份授权闭环、网络边界、删减项、风险与第一施工门 |
| [Biunivers Workspace Application Protocol v1](<protocols/Biunivers Workspace Application Protocol v1.md>) | V1 冻结候选 | OCI label、8080 HTTP UI、健康检查、iframe、Workspace 持久性和权限边界 |

## 第三方应用生态 V1：发布候选

| 文档 | 状态 | 内容 |
|---|---|---|
| [第三方静态应用开发包 v1](developer-kit/v1/README.md) | 当前开发包 | 面向人类和 AI 的快速上手、协议原文、Schema、静态/资源应用模板、检查表和故障排查 |
| [Biunivers Static App Protocol v1](developer-kit/v1/BIUNIVERS_APP_PROTOCOL_V1.md) | 草案 | 第三方仓库必须保存的协议原文；定义 `index.html`、iframe、公开配置和宿主责任 |
| [Biunivers App Manifest v1](<protocols/Biunivers App Manifest v1.md>) | 草案 | `biunivers.app.json` 的最小身份、窗口默认值和配置 schema |
| [Biunivers App Management Protocol v1](<protocols/Biunivers App Management Protocol v1.md>) | 草案 | GitHub 安装、固定 commit、可靠注册、更新、停用、卸载和基本恢复 |
| [Biunivers Open Resource Protocol v1](developer-kit/v1/BIUNIVERS_OPEN_RESOURCE_PROTOCOL_V1.md) | V1 冻结候选 | 可选 Handler 声明、单实例 Launch Context 和窗口级文件 capability 交付 |
| [Biunivers Resource Session Protocol v1 设计](<Biunivers Resource Session Protocol v1 设计.md>) | 设计基线 | 主推资源接口、启用应用的对象资格、60/300 秒租约、通用 Range 和持续编辑 |
| [Biunivers Resource Session Protocol v1 规范评审](<Biunivers Resource Session Protocol v1 规范评审.md>) | 评审通过 | 最小必要范围、授权边界、快照语义、兼容策略和删减项 |
| [Static App Protocol v1 发布候选摘要](<protocols/Biunivers Static App Protocol v1 发布候选摘要.md>) | 发布候选 | 第三方最小交付、宿主承诺、边界和冻结判断 |
| [Nassau App Manifest v1](<Nassau App Manifest v1.txt>) | 参考材料 | 内容寻址应用清单参考；不是 Biunivers V1 的直接运行协议 |

## V0.8：资源会话验收完成

归档版本：`v0.8.0`

| 文档 | 状态 | 内容 |
|---|---|---|
| [V0.8 资源会话技术设计](<浏览器云端个人桌面 V0.8 资源会话技术设计.md>) | 已实现 | 并行兼容架构、内存租约、Range/Chunk、控制面、数据面与生命周期 |
| [V0.8 资源会话施工计划](<浏览器云端个人桌面 V0.8 资源会话施工计划.md>) | 验收完成 | 六阶段实施、兼容验证、真实 Range 验收和合并门槛 |
| [V0.8 资源会话后端验收](<acceptance/V0.8 资源会话后端验收.md>) | 已通过 | Docker/R2、随机 Seek、租约、保存冲突、撤销、重启和 Notepad 双栈验收 |

## V0.9：文件管理器批量操作验收完成

归档版本：`v0.9.0`

| 文档 | 状态 | 内容 |
|---|---|---|
| [V0.9 文件管理器批量操作需求方案](<浏览器云端个人桌面 V0.9 文件管理器批量操作需求方案.md>) | 已实现 | 标准多选、批量移动/复制/删除、原子性和安全边界 |
| [V0.9 文件管理器批量操作技术设计](<浏览器云端个人桌面 V0.9 文件管理器批量操作技术设计.md>) | 已实现 | 多选模型、批量 PVLog Segment、FID 复用、限制与 API |
| [V0.9 文件管理器批量操作施工计划](<浏览器云端个人桌面 V0.9 文件管理器批量操作施工计划.md>) | 验收完成 | 四阶段施工、完工记录和版本边界 |
| [V0.9 文件管理器批量操作验收](<acceptance/V0.9 文件管理器批量操作验收.md>) | 已通过 | 自动化门槛、Docker/R2 与真实浏览器验收 |

## 归档规则

- V0.1 文档用于解释已经交付的行为和当时的设计决策；
- V0.2 与 V0.3 归档文档分别解释对应 tag 的产品行为和验收边界；
- 不在归档文档中直接扩大 V0.1 范围；
- 缺陷修复应关联独立 issue 或修复记录；
- 新功能、破坏性状态变更或配置协议变化应建立新的版本需求与设计文档；
- 当前运行和部署方式以仓库根目录 [README](../README.md) 为准。
