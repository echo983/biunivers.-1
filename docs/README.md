# Biunivers 文档索引

## V0.1：已完成并归档

归档日期：2026-07-28

实现基线：`8586732 implement browser desktop V0.1`

| 文档 | 状态 | 用途 |
|---|---|---|
| [V0.1 需求方案](浏览器云端个人桌面%20V0%201%20需求方案.md) | 已完成 | 已交付功能范围、成功标准和最终验收清单 |
| [V0.1 技术设计](浏览器云端个人桌面%20V0.1%20技术设计.md) | 已实施 | 架构决策、WinBox 生命周期、状态模型和风险记录 |
| [V0.1 施工计划](浏览器云端个人桌面%20V0.1%20施工计划.md) | 施工完成 | 六阶段实施过程、验收映射和完工记录 |

## 后续设计共识

| 决策 | 状态 | 内容 |
|---|---|---|
| [ADR-0001：应用接入与特权边界](decisions/0001-应用接入与特权边界.md) | 已接受 | internal 编译期白名单、第三方静态应用/iframe/external、GitHub 安装边界及未来资源交换原则 |

## 第三方应用生态 V1：发布候选

| 文档 | 状态 | 内容 |
|---|---|---|
| [第三方静态应用开发包 v1](developer-kit/v1/README.md) | 草案 | 面向人类和 AI 的快速上手、协议原文、Schema、模板、检查表和故障排查 |
| [Biunivers Static App Protocol v1](developer-kit/v1/BIUNIVERS_APP_PROTOCOL_V1.md) | 草案 | 第三方仓库必须保存的协议原文；定义 `index.html`、iframe、公开配置和宿主责任 |
| [Biunivers App Manifest v1](<protocols/Biunivers App Manifest v1.md>) | 草案 | `biunivers.app.json` 的最小身份、窗口默认值和配置 schema |
| [Biunivers App Management Protocol v1](<protocols/Biunivers App Management Protocol v1.md>) | 草案 | GitHub 安装、固定 commit、可靠注册、更新、停用、卸载和基本恢复 |
| [Static App Protocol v1 发布候选摘要](<protocols/Biunivers Static App Protocol v1 发布候选摘要.md>) | 发布候选 | 第三方最小交付、宿主承诺、边界和冻结判断 |
| [Nassau App Manifest v1](<Nassau App Manifest v1.txt>) | 参考材料 | 内容寻址应用清单参考；不是 Biunivers V1 的直接运行协议 |

## V0.2：已完成

| 文档 | 状态 | 内容 |
|---|---|---|
| [V0.2 需求方案](<浏览器云端个人桌面 V0.2 需求方案.md>) | 草案 | 第三方静态应用检查、安装、运行和生命周期的产品闭环与验收场景 |
| [V0.2 技术设计](<浏览器云端个人桌面 V0.2 技术设计.md>) | 草案 | 单进程双 origin、管理 API、GitHub source、JSON 持久化和前端集成 |
| [V0.2 施工计划](<浏览器云端个人桌面 V0.2 施工计划.md>) | 施工完成 | 七阶段任务、出口条件、测试矩阵和人工验收 |

## 归档规则

- V0.1 文档用于解释已经交付的行为和当时的设计决策；
- 不在归档文档中直接扩大 V0.1 范围；
- 缺陷修复应关联独立 issue 或修复记录；
- 新功能、破坏性状态变更或配置协议变化应建立新的版本需求与设计文档；
- 当前运行和部署方式以仓库根目录 [README](../README.md) 为准。
