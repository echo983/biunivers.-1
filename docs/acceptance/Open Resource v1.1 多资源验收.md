# Open Resource v1.1 多资源验收

状态：自动验证通过，Docker 与第三方界面验收待执行

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

## BiuniView 验收步骤

先在应用管理中把 `https://github.com/echo983/biunivers-image-viewer.git` 更新到
`feature/open-resource-v1.1`。

1. 启动 BiuniView，点击“打开多张”；
2. 在同一个目录以 Ctrl/Command 或 Shift 选择至少三张图片；
3. 确认不足两张时不能打开，达到两张后可确认；
4. 确认图片顺序与选择器显示顺序一致；
5. 用“上一张/下一张”切换，确认图片和序号正确；
6. 在文件管理器多选相同图片，点击“打开方式”；
7. 确认只出现声明 `multiple: true` 且匹配全部文件的应用；
8. 用 BiuniView 打开，确认获得完整集合；
9. 混入一个不支持的普通文件，确认 BiuniView 不再作为共同候选；
10. 单独双击一张图片，确认旧的单文件路径仍正常。

## 尚未通过

- 当前代理环境无权访问 `/var/run/docker.sock`，因此 Docker/R2 和人工界面证据尚待用户终端执行；
- WildPlay 播放列表适配不是本次最小合并门槛，待 BiuniView 路径稳定后再推进。
