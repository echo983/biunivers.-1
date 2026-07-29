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
| [Biunivers Resource Session Protocol v1](<developer-kit/v1/BIUNIVERS_RESOURCE_SESSION_PROTOCOL_V1.md>) | 施工中 | 主推的可续租资源会话、重复 GET、Range 读取和完整保存 |

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

## 第三方应用生态 V1：发布候选

| 文档 | 状态 | 内容 |
|---|---|---|
| [第三方静态应用开发包 v1](developer-kit/v1/README.md) | 草案 | 面向人类和 AI 的快速上手、协议原文、Schema、模板、检查表和故障排查 |
| [Biunivers Static App Protocol v1](developer-kit/v1/BIUNIVERS_APP_PROTOCOL_V1.md) | 草案 | 第三方仓库必须保存的协议原文；定义 `index.html`、iframe、公开配置和宿主责任 |
| [Biunivers App Manifest v1](<protocols/Biunivers App Manifest v1.md>) | 草案 | `biunivers.app.json` 的最小身份、窗口默认值和配置 schema |
| [Biunivers App Management Protocol v1](<protocols/Biunivers App Management Protocol v1.md>) | 草案 | GitHub 安装、固定 commit、可靠注册、更新、停用、卸载和基本恢复 |
| [Biunivers Open Resource Protocol v1](developer-kit/v1/BIUNIVERS_OPEN_RESOURCE_PROTOCOL_V1.md) | V1 冻结候选 | 可选 Handler 声明、单实例 Launch Context 和窗口级文件 capability 交付 |
| [Biunivers Resource Session Protocol v1 设计](<Biunivers Resource Session Protocol v1 设计.md>) | 设计基线 | 主推资源接口、启用应用的对象资格、60/300 秒租约、通用 Range 和持续编辑 |
| [Biunivers Resource Session Protocol v1 规范评审](<Biunivers Resource Session Protocol v1 规范评审.md>) | 评审通过 | 最小必要范围、授权边界、快照语义、兼容策略和删减项 |
| [Static App Protocol v1 发布候选摘要](<protocols/Biunivers Static App Protocol v1 发布候选摘要.md>) | 发布候选 | 第三方最小交付、宿主承诺、边界和冻结判断 |
| [Nassau App Manifest v1](<Nassau App Manifest v1.txt>) | 参考材料 | 内容寻址应用清单参考；不是 Biunivers V1 的直接运行协议 |

## V0.8：资源会话待施工

| 文档 | 状态 | 内容 |
|---|---|---|
| [V0.8 资源会话技术设计](<浏览器云端个人桌面 V0.8 资源会话技术设计.md>) | 待施工评审 | 并行兼容架构、内存租约、Range/Chunk、控制面、数据面与生命周期 |
| [V0.8 资源会话施工计划](<浏览器云端个人桌面 V0.8 资源会话施工计划.md>) | 待施工 | 六阶段实施、兼容验证、真实 Range 验收和合并门槛 |

## 归档规则

- V0.1 文档用于解释已经交付的行为和当时的设计决策；
- V0.2 与 V0.3 归档文档分别解释对应 tag 的产品行为和验收边界；
- 不在归档文档中直接扩大 V0.1 范围；
- 缺陷修复应关联独立 issue 或修复记录；
- 新功能、破坏性状态变更或配置协议变化应建立新的版本需求与设计文档；
- 当前运行和部署方式以仓库根目录 [README](../README.md) 为准。
