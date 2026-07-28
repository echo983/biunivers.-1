# Biunivers Static App Protocol v1 发布候选摘要

状态：发布候选

协议标识：`biunivers.static-app/1`

## 第三方应用最小交付

公开 GitHub 仓库根目录必须包含：

- 可直接运行的 `index.html`；
- 符合 Schema 的 `biunivers.app.json`；
- 未修改的 `BIUNIVERS_APP_PROTOCOL_V1.md`；
- `LICENSE`；
- manifest 引用的 icon。

应用是纯静态文件集合。Biunivers 不安装依赖、不执行构建、不启动应用服务端。

## 宿主承诺

- 将 branch、tag 或 commit 固定为完整 commit SHA；
- 校验身份、协议、Manifest、路径、文件类型和大小；
- 安装完成后才写入应用注册表；
- 从独立 App Origin 提供静态文件和公开配置；
- 提供窗口、配置、更新、停用、启用和卸载；
- 安装或更新失败时保留当前可用状态。

## 明确边界

- 配置会发送给浏览器，不得存放 secret；
- V1 不提供 Host API、capability、跨应用资源交换或应用专属后端；
- 包内资源使用相对路径，客户端路由使用 hash 路由；
- iframe 内业务和站点数据由应用负责，外层窗口由宿主负责。

## 发布判断

V1 已通过最小示例与独立计算器的真实 GitHub 安装验收。当前保持发布候选状态；
V0.2 里程碑合并时冻结协议正文。后续不兼容变化必须使用新协议标识和新文件名。
