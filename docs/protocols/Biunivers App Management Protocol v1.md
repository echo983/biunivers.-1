# Biunivers App Management Protocol v1

状态：草案

## 1. 目标

本协议定义 Biunivers 如何从公开 GitHub 仓库安装、配置、注册、更新、停用和卸载第三方静态应用。

它是 Biunivers 管理服务的行为约定，不是 iframe 应用可以调用的 Host API。

## 2. V1 支持范围

V1 支持：

- `github.com` 公共仓库；
- 仓库根目录应用；
- 明确的 branch、tag 或 commit；
- 固定到完整 Git commit SHA；
- 已经构建完成的静态文件；
- 一个 `appId` 安装一个实例；
- 用户显式更新；
- 公开客户端配置；
- 启用、停用和卸载。

V1 不支持：

- 私有仓库；
- GitHub 之外的安装源；
- monorepo 子目录；
- 安装时构建；
- secret；
- 自动更新；
- 应用依赖和应用商店。

## 3. 系统责任

安装必须由 Biunivers 管理服务执行。浏览器桌面本身不负责 clone 仓库、写入服务器文件或直接修改共享 APP 表。

管理服务负责：

- 获取并校验仓库；
- 保存应用文件和安装配置；
- 维护安装记录；
- 生成桌面 APP 表；
- 管理更新、停用和卸载。

静态文件服务负责提供已安装应用。桌面仍然只把应用当作 iframe 窗口运行。

管理操作必须经过 Biunivers 自身的身份认证和授权。

## 4. 安装输入

安装请求至少包含：

```json
{
  "repository": "https://github.com/example/calculator",
  "ref": "v1.0.0",
  "configuration": {
    "defaultPrecision": 4
  }
}
```

`repository` 必须是规范的公开 GitHub HTTPS 仓库地址。`ref` 可以是 branch、tag 或 commit。

管理服务获取仓库后必须把 ref 解析为完整 commit SHA。安装完成后不能继续跟随可变 branch 或 tag。

## 5. 安装流程

管理服务按以下流程安装：

1. 校验 GitHub 仓库地址；
2. 获取指定 ref 并记录完整 commit SHA；
3. 在临时目录读取仓库；
4. 读取并校验 `biunivers.app.json`；
5. 校验对应版本的协议 Markdown 原文；
6. 确认宿主支持声明的协议和 manifest 版本；
7. 校验 `appId` 与 GitHub owner，并检查 ID 冲突；
8. 确认根目录 `index.html`、`LICENSE` 和 icon 存在；
9. 拒绝符号链接和异常路径，不解析 submodule 或下载 LFS 对象；
10. 根据 manifest 校验并生成公开配置；
11. 检查应用大小没有超过部署限制；
12. 把普通应用文件写入新的正式版本目录；
13. 最后写入安装记录并注册 APP。

安装器不得执行仓库中的代码、Git hook、构建命令或生命周期脚本。

文件写入或校验失败时，不得产生可运行的 APP 记录。正式注册是安装过程的最后一步。

## 6. 应用目录和访问

应用文件位于专用数据目录，不写入 Biunivers 源码或前端镜像：

```text
installed-apps/
└── io.github.example.calculator/
    └── <commit-sha>/
        ├── index.html
        └── assets/
```

桌面入口：

```text
/apps/<appId>/<commit-sha>/index.html
```

配置入口：

```text
/apps/<appId>/<commit-sha>/.biunivers/config.json
```

配置是管理服务提供的虚拟资源，不属于仓库文件。它必须使用 `Cache-Control: no-store`。

静态文件服务必须：

- 防止路径穿越；
- 关闭目录列表；
- 不提供 `.git` 和其他 dotfile；
- 不提供 manifest 和协议 Markdown；
- 使用正确的常见 MIME 类型；
- 不把未知应用路径回退到桌面首页。

## 7. APP 表

安装完成后，管理服务把应用转换为普通 iframe 定义：

```json
{
  "id": "io.github.example.calculator",
  "name": "Calculator",
  "kind": "iframe",
  "icon": "/apps/io.github.example.calculator/<commit-sha>/assets/icon.svg",
  "url": "/apps/io.github.example.calculator/<commit-sha>/index.html",
  "defaultWidth": 640,
  "defaultHeight": 480,
  "minWidth": 320,
  "minHeight": 240,
  "desktop": true,
  "pinned": false,
  "trusted": true
}
```

Manifest 不能声明：

- `kind`；
- `internalComponent`；
- 最终托管 URL；
- 宿主权限。

第三方安装应用永远不能变成 `internal`。

## 8. 安装记录

每个应用至少记录：

```text
app_id
repository
requested_ref
commit_sha
version
protocol
configuration
status
installed_at
updated_at
```

`status` 只需要：

```text
active
disabled
```

失败安装可以写操作日志，但不能以半安装应用的形式进入 APP 表。

## 9. 配置

配置处理顺序：

1. 拒绝 manifest 未声明的 key；
2. 优先使用用户填写值；
3. 缺失时使用 manifest 默认值；
4. 必填且无值时停止安装；
5. 校验类型和限制；
6. 保存最终 JSON object。

修改配置必须重新校验并原子保存。已经打开的应用可以在重新打开后读取新配置。

配置全部是浏览器可见值。管理服务不得把它当作 secret 存储机制。

## 10. 更新

更新由用户显式发起。

管理服务必须：

1. 获取目标 ref 并解析新的 commit SHA；
2. 执行与安装相同的全部校验；
3. 确认 `appId` 没有改变；
4. 用新 manifest 重新校验配置；
5. 把新版本写入新的目录；
6. 成功后切换安装记录和 APP 表；
7. 失败时继续使用旧版本。

V1 不自动替换正在运行的 iframe。界面应提示用户关闭后重新打开应用。

更新成功前不能删除旧版本。后续如何保留和清理更多历史版本属于实施策略。

## 11. 停用和启用

停用应用：

- 从 APP 表移除；
- 关闭或提示关闭应用窗口；
- 保留文件、配置和安装记录。

重新启用：

- 检查当前入口仍然存在；
- 恢复 APP 表；
- 不需要重新访问 GitHub。

## 12. 卸载

卸载前必须向用户展示应用名称、版本和将删除的数据。

确认后：

1. 阻止新的应用窗口打开；
2. 关闭应用窗口；
3. 从 APP 表和安装记录移除；
4. 删除或进入待清理状态的应用文件和配置。

服务器端卸载不一定能清除浏览器保存的全部第三方应用数据，界面必须如实说明。

## 13. 失败恢复

最低恢复要求：

- 临时目录不会被桌面运行；
- 安装或更新失败不影响当前版本；
- GitHub 不可用不影响已经安装的应用；
- APP 表不能指向不存在的 `index.html`；
- 管理服务启动时清理或报告未完成的临时安装。

## 14. 协议兼容

宿主维护显式支持列表：

```json
{
  "appProtocols": ["biunivers.static-app/1"],
  "manifestVersions": [1]
}
```

未来采用长期向后兼容还是版本白名单制另行决定。V1 安装器只接受当前宿主明确列出的版本。

## 15. 后续协议边界

应用间启动、文件关联、资源句柄、Range 读取和 NAS 凭据代理属于未来独立的 Resource Exchange Protocol，不属于安装管理协议。
