# 浏览器云端个人桌面 Open Resource v1.1 施工计划

状态：已完成

日期：2026-07-30

## 阶段 1：版本化安装

- 引入 Open Resource Validator Registry；
- 同时加载 v1 和 v1.1 Schema/原文；
- 根据 declaration protocol 严格选择；
- 更新安装、检查、投影和类型；
- 验证 v1 原文字节没有变化；
- 覆盖安装、更新、降级、错误原文和未知版本测试。

出口：宿主能可靠安装 v1.1 声明，旧 v1 应用完全不回归。

## 阶段 2：共同 Handler 与批量 Session

- 实现 Entry ID 去重和有序集合校验；
- 实现 `resolveMany`；
- 强制同一个 `multiple: true` Handler 匹配全部文件；
- Session Registry 增加容量预检和批量签发；
- ResourceSessionService 增加只读 `issueFiles`；
- 测量 64 KiB 响应安全上限；
- 覆盖不存在、目录、混合类型、过期 revision 和容量不足。

出口：服务端能把一个合法集合全成或全败地投影为独立 Session。

## 阶段 3：应用主动 `resource.openMany`

- 扩展 capabilities；
- 扩展 message 校验与 dispatcher；
- HostFilePicker 增加单目录多选模式；
- 支持 Ctrl/Command、Shift、数量提示和上限；
- 导航时清空选择；
- 接入 IframeApp pending picker 生命周期；
- 返回有序 `resources[]`；
- 覆盖取消、窗口关闭、停用和并发 picker。

出口：第三方应用可以一次请求并读取一组用户选择文件。

## 阶段 4：批量 Pending Launch

- Pending Launch 内部统一为 `entryIds[]`；
- 单文件行为保持；
- 增加 v1.1 protocol 和批量创建；
- claim 时重新验证并批量签发；
- 返回 `resource` 或 `resources` 互斥结构；
- 通知使用目标声明的 Open Resource 协议版本；
- legacy Host API Launch 保持单文件。

出口：服务端可为文件管理器创建、通知和领取一个批量 Launch。

## 阶段 5：文件管理器批量打开

- 多选时启用“打开方式”；
- 调用共同 Handler Resolver；
- 对话框显示文件数量和批量候选；
- 创建批量 Launch 并激活目标应用；
- 不记忆批量默认关联；
- 明确 busy、stale、无共同应用和超上限错误；
- 保持移动、复制、删除和框选行为。

出口：用户可以从文件管理器一次把多个文件交给声明支持的第三方应用。

## 阶段 6：开发者交付与真实应用

- 更新开发者 README、AI 指南、AGENTS 和发布检查表；
- 提供 v1.1 声明示例和客户端示例；
- 适配 Image Viewer，验证一组图片；
- 适配 WildPlay，验证播放列表；
- 验证旧版本应用仍能安装和单文件打开；
- 更新 About、文档索引和验收记录。

出口：人类或 AI 第三方开发者能够不猜测地实现批量资源应用。

## 自动验证

- v1/v1.1 Schema 正反例；
- v1 原文 hash/bytes 不变；
- Validator 版本白名单；
- common Handler 全集合匹配；
- 有序去重；
- Session 全成或全败；
- message 最大投影；
- picker 选择行为；
- 单/批 Launch 兼容；
- 停用、更新、关闭和重启撤销；
- 全量 Vitest、TypeScript、构建、ESLint 和依赖审计。

## 人工验收

Image Viewer：

1. 应用内主动多选至少三张图片；
2. 顺序正确；
3. 能前后切换；
4. 未选择图片不可访问；
5. 释放后读取失败。

文件管理器：

1. Ctrl/Shift 或框选多张图片；
2. “打开方式”只显示支持批量的应用；
3. 一次打开后取得完整集合；
4. 混入不支持文件时不显示候选；
5. 旧单文件打开保持正常。

WildPlay：

1. 多选音频或视频；
2. 按显示顺序形成播放列表；
3. Range、续租和释放正常；
4. 不自动取得同目录其他媒体。

## 合并门槛

- v1 原文和旧应用行为不变；
- v1.1 协议、Schema、实现一致；
- 第一版只读和单目录边界未扩大；
- 全成或全败证据充分；
- 至少一个真实第三方应用通过主动多选和文件管理器批量 Launch；
- 全部相关文档及时完整；
- 未通过的平台或场景如实记录。
