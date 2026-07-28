# Biunivers App Manifest v1

状态：草案

固定文件名：`biunivers.app.json`

## 1. 目标

Manifest 是 Biunivers 安装器读取的应用说明，描述应用身份、版本、窗口默认值和安装配置。

它不描述应用内部代码结构，也不授予 Host API 或浏览器权限。

## 2. 最小 Manifest

```json
{
  "formatVersion": 1,
  "protocol": "biunivers.static-app/1",
  "appId": "io.github.example.calculator",
  "version": "1.0.0",
  "name": "Calculator",
  "license": "MIT",
  "icon": "icon.svg",
  "window": {
    "defaultWidth": 640,
    "defaultHeight": 480
  },
  "configuration": []
}
```

## 3. 完整示例

```json
{
  "formatVersion": 1,
  "protocol": "biunivers.static-app/1",
  "appId": "io.github.example.calculator",
  "version": "1.0.0",
  "name": "Calculator",
  "description": "A small offline calculator.",
  "license": "MIT",
  "icon": "assets/icon.svg",
  "window": {
    "defaultWidth": 640,
    "defaultHeight": 480,
    "minWidth": 320,
    "minHeight": 240,
    "desktop": true,
    "pinned": false
  },
  "configuration": [
    {
      "key": "defaultPrecision",
      "label": "Default precision",
      "type": "integer",
      "required": false,
      "default": 2,
      "minimum": 0,
      "maximum": 12
    },
    {
      "key": "angleUnit",
      "label": "Angle unit",
      "type": "select",
      "required": true,
      "options": ["degrees", "radians"],
      "default": "degrees"
    }
  ]
}
```

## 4. 字段

### `formatVersion`

必需。V1 必须为整数 `1`。宿主不支持该版本时拒绝安装。

### `protocol`

必需。V1 必须为：

```text
biunivers.static-app/1
```

仓库根目录必须同时存在对应的 `BIUNIVERS_APP_PROTOCOL_V1.md` 原文。

### `appId`

必需。应用的稳定身份，格式为：

```text
io.github.<owner>.<application>
```

要求：

- 只使用小写字母、数字、点和短横线；
- GitHub owner 部分必须与安装来源一致；
- 在一个 Biunivers 实例中唯一；
- 更新时不能改变。

例如：

```text
io.github.example.calculator
```

### `version`

必需。应用显示版本，使用 SemVer，例如 `1.0.0` 或 `1.1.0-beta.1`。

版本用于向用户展示；实际安装内容固定到 Git commit SHA。

### `name`

必需。非空的用户可见名称，最长 80 个字符。

### `description`

可选。纯文本简介，最长 300 个字符。

### `license`

必需。应用的开源许可证标识，例如 `MIT`、`Apache-2.0` 或 `GPL-3.0-only`。

仓库根目录必须存在 `LICENSE` 原文。GitHub 仓库公开不等于已经授予开源使用许可。

### `icon`

必需。相对于仓库根目录的图片路径。文件必须存在，且不能指向外部 URL 或应用目录之外。

### `window`

必需。

必需字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `defaultWidth` | 正整数 | 默认宽度 |
| `defaultHeight` | 正整数 | 默认高度 |

可选字段：

| 字段 | 类型 | 默认值 |
|---|---|---|
| `minWidth` | 正整数 | 宿主默认值 |
| `minHeight` | 正整数 | 宿主默认值 |
| `desktop` | boolean | `true` |
| `pinned` | boolean | `false` |

最小尺寸不能大于默认尺寸。宿主可以根据当前屏幕限制最终尺寸。

### `configuration`

必需。配置项数组；没有配置时使用 `[]`。

每项必须包含：

| 字段 | 类型 | 说明 |
|---|---|---|
| `key` | string | 稳定且唯一的配置键 |
| `label` | string | 安装界面标签 |
| `type` | string | 配置类型 |
| `required` | boolean | 是否必填 |

可选通用字段：

- `description`；
- `default`。

V1 类型：

| 类型 | 值 | 可选限制 |
|---|---|---|
| `string` | 字符串 | 无 |
| `boolean` | 布尔值 | 无 |
| `integer` | 整数 | `minimum`、`maximum` |
| `number` | 数字 | `minimum`、`maximum` |
| `select` | 字符串 | 必须提供非空 `options` |

规则：

- key 只能包含字母和数字，并以小写字母开头；
- 同一个 manifest 中 key 不得重复；
- default 必须符合自身类型和限制；
-必填项没有默认值时，安装过程必须要求填写；
-未声明的配置键不能保存；
-V1 不支持 secret 配置。

## 5. 固定入口

V1 不提供 `entry` 字段。入口始终是仓库根目录：

```text
index.html
```

缺少入口时拒绝安装。

## 6. 仓库文件

V1 不要求开发者在 manifest 中逐个列出文件，也不要求额外维护每个文件的摘要。

理由是安装记录已经固定到 Git commit SHA；逐文件清单会显著增加使用构建工具的应用的发布负担，而对 V1 的实际价值有限。

安装器保存该 commit 的普通仓库文件，但必须排除：

- `.git`；
- 符号链接；
- 其他不能作为普通静态文件安全提供的对象。

V1 不解析 Git submodule，也不负责下载 Git LFS 对象。应用不得依赖它们提供运行所需文件。

静态服务器必须关闭目录列表，并拒绝访问 dotfile、`biunivers.app.json` 和协议 Markdown。

未来如果需要独立分发、镜像校验或签名，可以在新的 manifest 版本中增加内容摘要。

## 7. 未知字段

V1 安装器应拒绝未知字段，避免拼写错误被静默忽略。

增加新字段或改变字段语义需要发布新的 manifest 格式版本。

## 8. 与 Nassau 的关系

`nassau.appmanifest` 可以作为未来内容寻址和能力系统的参考，但不是 Biunivers V1 的直接安装格式。

Nassau 系应用只要另外提供：

- 根目录 `index.html`；
- `biunivers.app.json`；
- `BIUNIVERS_APP_PROTOCOL_V1.md`；

就可以作为普通 Biunivers 静态 iframe 应用安装。Biunivers V1 不调用 Nassau 的 `start(host)`。
