# Open Resource v1.1 多资源验收

状态：通过

日期：2026-07-30

## 实现范围

- v1 与 v1.1 安装白名单和对应协议原文校验；
- `multiple: true` 共同 Handler 解析；
- `resource.openMany` 主动多选；
- 2 至 100 个普通文件的只读、独立、可续租 Session；
- 全成或全败的批量 Session 签发；
- 文件管理器批量“打开方式”和 Pending Launch；
- 单资源 v1、Resource Session v1 与 legacy Host API 兼容。

## 自动证据

- 全量 Vitest：68 个测试文件通过、1 个跳过；285 项通过、1 项跳过；
- TypeScript 客户端与服务端构建通过；
- ESLint 通过；
- v1.1 Schema 正反验证通过；
- v1 旧声明、单资源 Resolver 和单资源 Launch 回归通过；
- v1.1 共同 Handler、有序批量 Session、`resource.openMany` 和批量 Launch 测试通过；
- BiuniView `0.2.0` Manifest 与 v1.1 Handler Schema 校验通过；
- BiuniView 三份冻结协议文件与宿主开发者包逐字节一致；
- BiuniView 图片格式测试 3 项通过。

## Docker 启动

```bash
bash scripts/run-open-resource-v11-test.sh
```

2026-07-30 使用 `biunivers:open-resource-v11-dev` 构建并启动成功：

```text
{"status":"ok"}
Biunivers 已启动：http://localhost:8080
```

BiuniView 从 GitHub 分支 `feature/open-resource-v1.1` 安装更新成功。

## BiuniView 人工验收

以下项目均于 2026-07-30 实测通过：

- 应用内“打开多张”可用 Ctrl 和 Shift 选择三张图片；
- 图片按选择器显示顺序交付，序号和上一张/下一张切换正确；
- 只选择一张时确认按钮不可用；
- 进入另一目录会清空原选择；
- 文件管理器多选三张图片后，BiuniView 可作为共同 Handler 一次取得完整集合；
- 混入 `.txt` 后，BiuniView 不再是共同候选；
- 单独双击图片仍能走单资源路径打开；
- 文件管理器双击 `.txt` 后，旧版单资源应用 BiuniNote 仍能打开且内容正确。

## 延后项

- WildPlay 播放列表适配不是 v1.1 最小闭环或本次合并门槛，后续按产品需求独立推进；
- 本轮没有增加多文件写入、跨目录选择、目录资源或文件系统遍历。

## 结论

Open Resource v1.1 的安装、主动多选、文件管理器批量交付、独立 Session、共同 Handler、
兼容和安全边界均形成可用闭环，具备合并条件。
