# Biunivers Hello

这是一个最小的 Biunivers Static App Protocol v1 示例。

创建自己的应用时：

1. 把本目录全部文件复制到新的 GitHub 仓库根目录；
2. 在 `biunivers.app.json` 中修改 `appId`、名称、版本和窗口配置；
3. 修改 `LICENSE` 中的版权信息，或换成 manifest 声明的其他开源许可证；
4. 修改 `index.html`、`app.js`、`style.css` 和 `icon.svg`；
5. 不要修改 `BIUNIVERS_APP_PROTOCOL_V1.md`；
6. 确保所有静态资源继续使用相对路径；
7. 按开发包中的 `PUBLISH_CHECKLIST.md` 完成发布检查。

本示例读取一个可选的公开配置：

```json
{
  "greeting": "你好，Biunivers"
}
```

在普通本地静态服务器中没有 `.biunivers/config.json` 时，示例会自动使用默认问候语。

根目录 `AGENTS.md` 为 AI 开发代理提供交付、安全与验证约束；它不是安装器强制文件。
