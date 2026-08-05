# BWA 默认环境与 Workspace 内容补充验收

状态：通过  
日期：2026-08-05  
分支：`feature/bwa-default-env-workspace-import`

## 1. 验收范围

- Workspace Application 保存应用级默认普通变量和 secret；
- Instance 只保存差异项，同名配置覆盖应用默认值；
- 新 Instance 无需重复填写公共模型配置即可启动；
- 文件管理器将 main 中选定的文件或递归目录添加到已有 Workspace；
- 内容 FID 复用，导入 Entry 使用新身份，同名根项目自动改名；
- main 与 Workspace revision、Workspace 写租约和未处置 Run 共同保护最终发布。

## 2. 产品验收

| 场景 | 结果 |
| --- | --- |
| 新 Instance 继承应用默认 endpoint、模型与 secret | 通过 |
| Instance 使用 `CODEX_MODEL_NAME` 覆盖默认模型 | 通过；界面呈现覆盖后的模型名称 |
| Instance 覆盖不影响其他 Instance | 通过 |
| 缺少 Runtime 本地 Run 的失败状态丢弃 | 通过；清理具备幂等性 |
| main 单文件添加到已有 Workspace | 通过 |
| main 递归目录添加到已有 Workspace | 通过；目录结构与内容完整 |
| 重复添加同名项目 | 通过；自动插入 `(main)` 后缀 |
| 运行中 Workspace 修改保护 | 通过；拒绝控制面发布 |

## 3. 数据与安全边界

- Application secret 使用独立私有命名空间，不进入 RefStore、页面回显或 Workspace；
- 已运行容器不热更新环境，下一次启动时固定解析最终环境；
- main 内容不会挂载或暴露给 BWA，选择行为只发生在可信文件管理器；
- main 与目标 Workspace 的固定 Ref 条件在同一 SQLite 事务中检查；
- 导入只发布 Workspace 新 Head，不修改 main，也不建立后续同步关系。

## 4. 自动化门槛

- Vitest：444 通过，1 跳过；
- 新增覆盖：RefStore v6 迁移、两级环境合并、secret 缺失、双 Ref 守卫、递归导入、自动改名、权限隔离和文件管理器流程；
- `npm run build`：通过；
- `git diff --check`：通过。

## 5. 结论

公共 BWA 配置不再要求每个 Instance 重复填写，已有 Workspace 也可以持续接收用户从 main
明确选择的新资料。两项能力均保持 Workspace 隔离、固定 Head、不可变对象复用和第三方应用
不能遍历 main 的边界。本功能达到合并条件；实时同步、跨 Universe 移动、配置 Profile 和
Workspace 内通用删除继续后置。
