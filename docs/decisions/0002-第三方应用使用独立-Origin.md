# ADR 0002：第三方应用使用独立 Origin

- 状态：Accepted
- 日期：2026-07-29

## 决策

每个已安装第三方应用使用独立 Origin。宿主把 app ID 的 SHA-256 前 160 bit 编码为单个
DNS 标签 `app-<40 hex>`，并加在 `BIUNIVERS_APP_ORIGIN` 的主机名前：

```text
http://app-<hash>.localhost:8081
https://app-<hash>.apps.desktop.example.com
```

应用资源路径为 `/apps/<commit-sha>/*`。服务端同时校验请求 Host、active 应用记录和登记的
commit；app ID 不出现在资源路径中。应用 Origin 不提供桌面和管理 API。

`BIUNIVERS_APP_ORIGIN` 是应用基域，只接受 `localhost` 或 DNS 名称，不接受 IP。公网部署
必须配置单层 wildcard DNS 和 TLS，并由反向代理原样传递 Host。

## 理由

共享 Origin 会让不同第三方应用共享 Cookie、localStorage、Cache API 等浏览器状态，无法
作为文件授权的安全边界。单标签哈希既稳定地隐藏 app ID 的 DNS 细节，也可由普通单层
wildcard 证书覆盖。160 bit 标签碰撞风险在本系统规模内可忽略。

## 边界

独立 Origin 只建立浏览器隔离基础，不等于文件授权。后续 File Host API 仍必须绑定应用、
窗口实例、用户动作和短期句柄。V1 不引入动态 capability 声明、opaque-origin sandbox 或
自定义域名。
