# Biunivers Resource App

这是一个可直接安装的 Open Resource + Resource Session v1 文本应用模板。

开始开发：

1. 修改 `biunivers.app.json` 的 `appId`、版本、名称和窗口尺寸；
2. 修改 `biunivers.open-resource.json`，只声明实际支持的类型；
3. 保留三份 `BIUNIVERS_*_PROTOCOL_V1.md` 原文，不要改写；
4. 在 `app.js` 中替换示例业务逻辑；
5. 使用开发包根目录的 Schema 和发布检查表完成校验。

模板展示主动选取、启动资源领取、读取、写回、另存为、60 秒续租和主动释放。它不包含
Host API fallback；只有明确需要兼容旧宿主时才增加。

根目录 `AGENTS.md` 为 AI 开发代理提供交付、安全、资源权限与验证约束；它不是安装器强制
文件。
