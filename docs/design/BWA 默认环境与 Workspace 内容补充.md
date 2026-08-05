# BWA 默认环境与 Workspace 内容补充

状态：已完成并归档

实现说明：应用默认环境与 Instance 覆盖、main 向既有 Workspace 添加内容均已完成并通过产品验收。内容添加入口位于文件管理器，第一版只采用自动改名策略；运行中或存在未处置改动的 Workspace 禁止发布。验收证据见《BWA 默认环境与 Workspace 内容补充验收》。

## 1. 目标

本设计补齐两个已经进入日常使用路径的缺口：

1. Workspace Application 可以保存一组应用级默认环境变量，Instance 只配置差异项；
2. 用户可以把 main 中选中的文件或目录导入一个已经存在的 Workspace。

两项能力都属于宿主控制面，不修改 `Biunivers Workspace Application Protocol v1`。容器最终仍只接收普通环境变量并看到一个独立 `/workspace`，第三方应用不需要适配新协议。

## 2. 设计原则

- 只增加两层配置：Application 默认值和 Instance 覆盖值；不引入 Profile、模板继承树或条件表达式。
- Workspace 导入产生新的不可变 HEAD；不建立 main 与 Workspace 之间的链接、同步或共享目录。
- 已发布 Run 的输入必须固定。运行中修改默认配置或 Workspace，不得暗中改变该 Run。
- secret 仍不进入 RefStore、日志、页面回显、Workspace 或运行记录。
- 复用现有 Entry/FID、自动改名、对象限额和 Ref CAS 规则，不建立第二套文件语义。

## 3. 应用默认环境变量

### 3.1 最终环境

一次 Run 的最终环境按名称合并：

```text
Application 默认环境
        +
Instance 覆盖环境
        ↓ Instance 同名项优先
Run 固定启动环境
```

Instance 中不存在某个名称时，使用 Application 默认值。删除 Instance 覆盖即恢复继承。Instance 可以增加 Application 中没有的变量，也可以显式覆盖变量的值和敏感性。

默认配置是动态继承关系，不在创建或 Fork Instance 时复制。修改 Application 默认值会影响所有没有同名覆盖的 Instance，但只在它们下一次启动或保存重启时生效；已经运行的容器不热更新。

宿主不增加“必填变量声明”。V1 镜像没有机器可读配置 manifest，启动依赖继续由应用 README 和 `BWA_STARTUP_ERROR:` 表达。Manager 只负责合并、校验变量名和安全注入。

### 3.2 持久化

RefStore 新增独立的 `bwa_application_environment` 表：

```text
application_id
name
value       -- 普通值；敏感项为 NULL
sensitive
PRIMARY KEY (application_id, name)
```

现有 `bwa_environment` 保持为 Instance 覆盖表。升级后不迁移或重写既有行：由于 Application 默认环境初始为空，所有既有 Instance 的最终环境保持完全不变。

不把两种作用域抽象成通用多态配置表。两张表的外键、删除级联和权限边界更直接，也避免当前只有两层时过度抽象。

`BwaSecretStore` 增加 Application 作用域的保存、读取和删除操作。Application secret 与 Instance secret 使用不同命名空间；RefStore 只保存名称和 `sensitive=true`。卸载 Application 时删除其默认 secret；删除 Instance 只删除该 Instance 的覆盖 secret。

### 3.3 解析与运行记录

`BwaRegistryService.resolveEnvironment(instanceId)` 改为：

1. 读取 Application 默认普通项和 secret；
2. 读取 Instance 覆盖普通项和 secret；
3. 按名称合并，Instance 优先；
4. 生成容器启动环境。

任何被选中的敏感项缺值时仍然失败关闭。被 Instance 普通值覆盖的 Application secret 不需要读取，也不能因为默认 secret 缺失而阻止启动。

Compute Runtime 在准备 Run 时继续接收一次性解析后的固定环境。为诊断和身份核对，可以记录变量名称、敏感标记及最终环境的现有安全指纹；不得新增 secret 明文持久化。配置保存不改变 Workspace revision，也不自行重启 Instance。

### 3.4 管理界面

Application 卡片增加“默认环境”入口，复用现有环境变量编辑器：

- 普通变量可以查看和修改值；
- secret 只显示“已配置/未配置”，保存新值时覆盖；
- 保存后关闭编辑面板；
- 提示“未覆盖的 Instance 将在下次启动时使用新值”。

Instance 环境编辑器改为同时呈现：

- 继承的 Application 默认项及来源；
- Instance 覆盖项；
- 新增覆盖、修改覆盖和“恢复继承”；
- 合并后的变量名称与敏感性，但永不回显 secret 值。

第一版不提供批量复制配置、导入 `.env`、历史版本或回滚。

## 4. 向既有 Workspace 导入内容

### 4.1 语义

该操作名称为“添加到 Workspace…”。它是一次从 main 固定快照到 Workspace 固定快照的复制导入：

```text
main @ sourceRevision 的选择集
              +
Workspace @ expectedRevision 的目标目录
              ↓
Workspace @ expectedRevision + 1
```

导入后两边完全独立。main 中的后续改名、移动、修改或删除不会改变 Workspace；Workspace 中的后续修改也不会回写 main。需要回写时继续使用现有“导回 main”流程。

### 4.2 内容与身份

- 文件内容、Manifest 和 Chunk 复用现有 FID，不重新上传或复制 S3 对象；
- 导入的根项目及递归子树全部获得新的 Entry ID；
- 文件名、目录结构、内容 FID 和可保留的 Entry 元数据从源快照复制；
- 目标名称冲突只提供现有“自动改名”规则；
- 空选择、重复选择、非法祖先关系和超限子树失败关闭；
- 入口继续沿用现有递归 Entry 数、深度和元数据大小上限。

该操作不支持移动语义，因为跨 Universe 的“移动”会同时修改 main 和 Workspace，制造不必要的双 Ref 事务和误删除风险。

### 4.3 一致性与锁

规划输入必须包含：

```text
sourceMainRevision
selectedEntryIds
workspaceIdHex
expectedWorkspaceRevision
destinationDirectoryEntryId
conflictPolicy = AUTO_RENAME
```

服务先从两个固定 HEAD 构建导入计划并写入新的不可变 Segment、Checkpoint 和 Head，最后在同一个 RefStore 事务中同时确认：

- main Ref 仍是 `sourceMainRevision`；
- Workspace Ref 仍是 `expectedWorkspaceRevision`；
- Workspace 当前允许控制面写入。

只有三项都成立才 CAS 发布 Workspace 新 Ref。失败时不改变任一 Ref；已经写入但未引用的不可变对象由未来 GC 处理。

Workspace 存在以下任一状态时禁止导入：

- 活跃的 BWA Run 或 Workspace 写租约；
- 尚未处置的异常 Upper；
- 正在提交、停止、恢复或清理的生命周期操作。

这一保护应成为 Workspace 控制面统一写入守卫，后续“从 Workspace 移除”复用同一规则，而不是仅检查某一种 Run 状态。

### 4.4 服务边界

新增面向 main → Workspace 的服务，不复用现有 `WorkspaceImportService` 名称。现有服务的方向是 Workspace → main，强行加入反向分支会使权限、冲突和 CAS 语义混杂。

建议边界：

- `WorkspaceContentImportPlanner`：读取两个固定快照，递归复制 Entry 并执行自动改名；
- `WorkspaceContentImportService`：执行限额、不可变对象构建、双 Ref 校验和 Workspace CAS；
- `WorkspaceMutationGuard`：统一判断运行态、租约和异常 Upper；
- `WorkspaceControlService`：暴露系统应用所需的受控操作。

Planner 可以复用现有 Workspace 派生和导回规划中的 Entry 复制、ID 生成与命名辅助函数，但不要求先进行大规模通用化重构。

### 4.5 用户界面

第一入口放在文件管理器：

1. 用户单选或多选 main 中同一目录下的文件和目录；
2. 点击“添加到 Workspace…”；
3. 选择目标 Workspace；
4. 在目标 Workspace 目录选择器中确定位置；
5. 界面显示源 revision、目标 revision 和自动改名说明；
6. 确认后发布一个 Workspace revision，并显示导入数量和新 revision。

不把该入口放进第三方 BWA。应用不应知道或遍历 main，也不能主动指定宿主 Entry ID。

Workspace 管理应用后续增加“从 Workspace 移除”。它是第二阶段：支持选择 Workspace Entry、确认后发布新 HEAD，不删除底层对象。第一阶段先完成“添加”，因为这是当前阻断用户补充项目资料的能力缺口。

## 5. API 最小形状

应用默认环境：

```text
GET  /api/v1/control/bwa/applications/:applicationId/environment
PUT  /api/v1/control/bwa/applications/:applicationId/environment
```

Instance 环境接口保留现有地址和替换语义，但响应增加默认项、覆盖项与有效来源，不返回 secret 值。

Workspace 内容导入：

```text
POST /api/v1/host/workspaces/:workspaceId/import-main
```

请求必须显式包含两个 revision、选择集、目标目录和 `AUTO_RENAME`。响应返回新 Workspace revision、导入根项目数量及最终名称。具体 URL 可以在施工时按现有路由风格调整，但不能省略双 revision CAS。

## 6. 失败表达

第一版只需要可操作的稳定错误类别：

- Application 或 Instance 不存在；
- 环境变量输入非法或 secret 缺失；
- main 源 revision 已变化；
- Workspace 目标 revision 已变化；
- Workspace 正被运行或存在未处置 Upper；
- 目标目录不存在；
- 名称、深度、Entry 数或元数据超限；
- 不可变对象写入或 Ref CAS 失败。

界面刷新最新状态后允许用户重试。系统不自动重放跨 revision 导入，也不自动停止 BWA Instance。

## 7. 施工顺序

1. 增加 Application 默认环境表、secret 作用域和合并解析测试；
2. 完成 Application/Instance 两级环境配置 API 与界面；
3. 增加 Workspace 统一写入守卫；
4. 实现 main → Workspace Planner、不可变对象构建与双 Ref CAS；
5. 在文件管理器加入“添加到 Workspace…”及目标目录选择器；
6. 完成并发、重启、secret、重复 FID、目录递归和冲突改名验收；
7. 第二阶段增加 Workspace 内选择和移除。

## 8. 明确不做

- 不增加 BWA 协议版本；
- 不增加配置 Profile、配置继承层级、`.env` 上传或变量声明 manifest；
- 不把 Application 默认配置写入 Workspace；
- 不把 main 挂载给 BWA，也不允许 BWA 主动浏览 main；
- 不建立 main 与 Workspace 的实时同步、符号链接或跟随更新；
- 不实现跨 Universe 移动、双向合并或自动冲突解决；
- 不在第一阶段实现 Workspace 内容删除、历史回滚界面或通用版本浏览器。

## 9. 闭环判断

完成第一阶段后：

- 一个 BWA 的公共配置只需填写一次，新 Instance 可以立即继承并按需覆盖；
- 每次 Run 得到固定、可诊断且不泄露 secret 的最终环境；
- 用户可以持续把 main 中的新资料补入既有 Workspace；
- 导入不破坏 Universe 隔离、不可变对象复用、固定 HEAD 或运行锁；
- BWA 仍无法遍历 main，第三方协议与安全边界保持不变。

因此两项能力在产品体验、数据模型和运行一致性上形成最小闭环，没有要求低必要性的通用配置系统或同步系统。
