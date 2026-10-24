# WorkBuddy Connect

[![npm](https://img.shields.io/npm/v/workbuddy-connect.svg)](https://www.npmjs.com/package/workbuddy-connect)
[![license](https://img.shields.io/npm/l/workbuddy-connect.svg)](LICENSE)
[![node](https://img.shields.io/node/v/workbuddy-connect.svg)](package.json)

把 **WorkBuddy 国内版 / 国际版**里**你自己账号**的模型，变成一个本机 **OpenAI 兼容接口** ——
免费模型（`hy3`、`step-5-preview` 等）也在内。两个区域可以任选一个，也可以同时使用。

**只有一种协议：OpenAI Chat Completions。** 这是几乎所有客户端都认的通用格式，也是
WorkBuddy 上游本身回答的格式，所以桥里面没有协议翻译层——请求进去什么样，转发出去就是什么样。

| 用途 | 路径（以 `cn` 为例） | 认证头 |
|---|---|---|
| 对话 | `POST /cn/v1/chat/completions` | `Authorization: Bearer <key>` |
| 模型目录 | `GET /cn/v1/models` | `Authorization: Bearer <key>` |
| 剩余积分 | `GET /cn/v1/credits` | `Authorization: Bearer <key>` |

`x-api-key: <key>` 也接受，方便只发这个头的客户端。Vercel AI SDK、LangChain、OpenWebUI、
Chatbox、Cherry Studio、Dify、n8n……只要它能填一个 OpenAI 兼容的 base URL 就能接。

> **为什么 2.0 去掉了 Anthropic Messages 和 OpenAI Responses？** 这两种协议各自要维护一整套请求
> 改写、流式事件重编码和错误信封映射，而它们能连上的客户端**同时都能连 Chat Completions**——
> 三份代码换不来多一个可用客户端。真遇到**只**说 Anthropic / Responses 的客户端
> （例如新版 Codex CLI 强制 `wire_api = "responses"`），用 1.4.x 的 tag，或在客户端前面挂一个只说
> 那一种协议的转发器。

支持**直接接入**的客户端（不用手写配置）：

- **ZCode** —— 见「方法一 / 方法二」

```text
任意 OpenAI 兼容客户端 → 本机 WorkBuddy Bridge (127.0.0.1:10108) → 你自己的 WorkBuddy 账号
                          ├─ WorkBuddy CN/模型名称
                          └─ WorkBuddy Global/模型名称
```

**消耗的是你自己 WorkBuddy 账号的积分。** 免费模型（倍率 `x0.00`，例如 `hy3`、`step-5-preview`）
按 WorkBuddy 当期政策执行；具体模型、倍率、活动和权限以 WorkBuddy 当时的数据为准。
本项目不提供账号、不附带积分。

## 为什么需要桥接

WorkBuddy 桌面端把模型藏在它自己的登录态后面，客户端拿不到可直接调用的 API。
所以本项目的做法是：

1. 一个只跑在 `127.0.0.1` 的本地桥接进程，用你自己 WorkBuddy 桌面端的登录态去访问
   WorkBuddy 的模型接口，对外提供 **OpenAI Chat Completions**（外加 `/v1/models` 与 `/v1/credits`）；
2. 一个可选的安装命令，把桥接注册成 **ZCode 的自定义 provider**（每个区域一条）：
   默认写 `%USERPROFILE%\.zcode\v2\provider_config.json`；
   改过数据目录则写 `<数据目录>\.zcode\v2\provider_config.json`）。其它客户端不需要这一步，
   直接填地址和 key。

桥自身零 npm 运行依赖，只需要 Node.js 跑 TypeScript。

## 前置条件

- **Windows 10/11**（一键安装与后台常驻脚本面向 Windows）。
- 已安装并登录 **WorkBuddy 国内版或国际版**（要两边模型就分别登录两边）。
- 桥接直接跑 TypeScript，需要 **Node.js 22.18 或更新版本**：
  - PATH 里有 `node` 就直接用；
  - 没有的话，脚本会自动改用 **WorkBuddy 自带的 Node 运行时**
    （`%USERPROFILE%\.workbuddy\binaries\node\versions\*`），所以大多数已装 WorkBuddy 的机器
    不需要额外安装；
  - 也可以用 `WORKBUDDY_NODE_PATH` 或 `-NodePath` 显式指定。
- ZCode 已安装。桥接注册后需要**重启 ZCode** 才会看到新的 provider。

## 方法一：ZCode 插件（推荐）

1. 在 ZCode 里打开 **插件市场 → 添加 → 添加插件市场**，填入本仓库地址：
   `https://github.com/luoxh8/workbuddy-connect`
2. 在 **个人 → workbuddy-connect → workbuddy-connect → 安装**。
3. 新开一个会话，发送：

   ```text
   用 workbuddy-connect 把本机已登录的 WorkBuddy 接入 ZCode
   ```

   也可以直接用命令 `/workbuddy-connect`。

插件自带的技能会检查 Node 版本与登录状态、启动桥接、列出模型（标出免费模型）、
注册 provider，然后告诉你重启 ZCode。

## 方法二：双击安装

1. 把仓库克隆或下载到一个准备长期保留的目录。
2. 双击 `Install.cmd`。它会注册 Windows 计划任务（登录后隐藏启动、意外退出自动恢复），
   然后自动识别当前已登录的区域并注册模型。
3. 重启 ZCode，在模型选择器里找 `WorkBuddy CN` / `WorkBuddy Global`（两个区域全装时各一条）。

```powershell
# 只接国内 / 只接国际 / 同时接两边
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install.ps1 -Region cn
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install.ps1 -Region global
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install.ps1 -Region both

# 只注册免费模型（倍率 x0.00）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install.ps1 -Region cn -FreeOnly

# 换端口 / 不设置登录后自启
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install.ps1 -Port 10109 -NoAutoStart
```

**安装后请保留项目目录的位置**：Windows 计划任务指向它，移动或删除前先卸载。

## 方法三：npm

```bash
npm i -g workbuddy-connect              # 或临时用：npx workbuddy-connect status
workbuddy-connect status                # 桥接与各区域状态
workbuddy-connect install --region cn   # 注册/刷新 provider
workbuddy-connect serve                 # 前台跑桥接（默认 127.0.0.1:10108）
```

包内自带 .ts 类型擦除的 loader，装进 `node_modules` 也能跑（Node ≥ 22.18）；
`npm i` 不触发任何生命周期脚本，注册 provider 必须显式跑 `workbuddy-connect install`。

## 接入 ChatGPT 桌面版 / Codex CLI（2.0 起不再支持）

新版 Codex CLI / ChatGPT 桌面版**强制 `wire_api = "responses"`**，二进制里直接写着
`wire_api = "chat"` is no longer supported，而本桥只提供 Chat Completions，所以 2.0 起
`install-codex` / `remove-codex` 两个命令已移除。

需要把 WorkBuddy 接进 Codex 时有两个选择：

1. 用 **1.4.x** 的 tag（那版带 Responses 路由和 Codex 目录生成）；
2. 让 Codex 直连官方端点——DeepSeek 官方 `POST https://api.deepseek.com/responses` 已可用，
   本机就是这么配的，中间不需要任何代理。


## 日常使用

```powershell
node src/cli.ts --help                           # 全部命令与参数
node src/cli.ts --version                        # 版本（取自 package.json）
node src/cli.ts accounts                          # 只读检查桌面登录状态
node src/cli.ts status                            # 桥接与各区域状态
node src/cli.ts models --region cn                # 模型目录（含免费标记，不消耗积分）
node src/cli.ts install --region cn               # 注册/刷新 provider（可重复运行）
node src/cli.ts install --region cn --free-only   # 只注册免费模型
node src/cli.ts remove --region cn                # 只移除本桥接注册的 provider
```

装成 npm 包之后换成 `workbuddy-connect <command>` 即可，参数完全一致。
`serve` 是前台运行；`status` 是默认命令，不给命令直接跑就是它。

`install` 给**每个区域各注册一条 provider**（`workbuddy-cn` / `workbuddy-global`）。
可以重复运行以同步可用模型、上下文窗口、图像输入和上游声明的推理档位；模型目录缓存最长 5 分钟。
它只增删自己那条 provider 和它名下的 model 规则，其他 provider、`providerOrder` 和你手写的规则都保持原样。
从 1.4.x 升级时，旧的 `workbuddy-<region>-anthropic` / `-responses` 两条会**自动清掉**（只在它们仍指向本桥时才删）。

真实调用（会消耗积分，建议先用免费模型）：

```powershell
node src/cli.ts smoke --region cn --model hy3
```

本地 API：

- `GET /healthz`、`GET /status`（`/status` 的 `protocol` 字段是 `openai-chat-completions`）
- `GET /cn/v1/{models,credits}`、`POST /cn/v1/chat/completions`
- `GET /global/v1/{models,credits}`、`POST /global/v1/chat/completions`

所有接口都需要桥接自己的本地密钥（安装时自动生成）：主用 `Authorization: Bearer`，
也接受 `x-api-key`。不需要手工粘贴 WorkBuddy token。

## 登录、数据与权限

桥接**只读**以下文件（优先 Local AppData，找不到时查 Roaming）：

| 区域 | 相对 AppData 的登录文件 |
|---|---|
| 国内版 | `CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info` |
| 国际版 | `CodeBuddyExtension\Data\Public\auth\workbuddy-desktop-ai.info` |

WorkBuddy 5.6.2+ 把 token 存成 `{"$wbEncrypted":1,...}` 的 AES-GCM 信封。要解开它必须拿到
应用自己的 at-rest 密钥，桥接的做法是**以只读方式**调用一次 WorkBuddy 自带的 Electron 运行时
（`WorkBuddy.exe -e` 加 `ELECTRON_RUN_AS_NODE=1`）取密钥，只在内存里解密，不落盘、不打印。
旧版本存明文 token 时这条路径不会被触发。

- 桥接绑定 `127.0.0.1`，校验 Bearer、Host 和浏览器 Origin。
- 对话内容与 access token 只发给对应的 WorkBuddy 服务；refresh token 只用于刷新接口。
- 区域、账号和企业身份隔离；退出或切换桌面账号后不会复用旧账号缓存。
- 刷新缓存只写在桥接自己的状态目录（默认 `%USERPROFILE%\.workbuddy-connect`，
  老版本在 `%USERPROFILE%\.zcode\workbuddy-connect`，首次运行会自动迁移过去以保住密钥），
  不覆盖 ZCode 或 WorkBuddy 的登录文件。
- 运行目录含私密数据，**不要打包给别人或提交 Git**。本仓库、插件和发布包不含任何凭据。

## 大请求体自动整形（图片去重 / 缩图 / 超限丢弃）

客户端（Codex、带视觉的会话等）每轮都会把整段对话连同里面的 base64 图片重新发一遍。
图片按 token 计很小，永远不会触发上下文压缩，但**字节数只涨不跌**，迟早撞上上游的请求体上限，
之后每一轮都 `413`，会话看起来就"假死"了。

桥在转发前只动图片这一件事，其余字段（文本、`tools`、采样参数……）一律原样转发：

| 层 | 做什么 | 触发条件 |
|---|---|---|
| 1. 去重 | 同一张图在历史里出现多次时，只保留**最新**那份，更旧的换成一行文字占位 | 请求里存在 `data:` 图片且内容重复 |
| 2. 张数上限 | 只保留最新 `WORKBUDDY_SHAPE_MAX_IMAGES` 张（默认 64），更旧的换占位 | 图片数超限 |
| 3. 缩图 | 单张超过 `WORKBUDDY_SHAPE_IMAGE_MAX` 的图用 ffmpeg 缩到长边 `DIM`、JPEG 质量 `Q` | 装了 ffmpeg |
| 4. 预算 | 仍超 `WORKBUDDY_SHAPE_MAX_BYTES`（默认 24 MiB）时，从**最旧**的图开始继续换占位 | 整形后仍超预算 |

没有图片的请求只做一次字节数比较，不会解析、不会重写。整形后仍超预算时不硬发，
直接返回 `413 request_too_large` 并说明当前字节数与可调的环境变量。

ffmpeg 优先取 `WORKBUDDY_SHAPE_FFMPEG`，否则用 PATH 上的 `ffmpeg`；两者都没有时
第 3 层自动跳过，去重与丢弃照常生效（请求不会因为缺 ffmpeg 而失败）。

观察整形效果（`status` 里就有，`shape.shrinker` 是 `ffmpeg` 还是 `none` 一眼可见）：

```powershell
node src/cli.ts status
#   "shape": { "requests": 3, "images": 12, "duplicated": 8, "shaped": 4,
#              "dropped": 0, "bytesIn": 53480841, "bytesOut": 8023755,
#              "shrinker": "ffmpeg", "maxBytes": 25165824, ... }
```

| 变量 | 默认 | 含义 |
|---|---|---|
| `WORKBUDDY_SHAPE_MAX_BYTES` | `25165824`（24 MiB） | 整形后的请求体预算 |
| `WORKBUDDY_SHAPE_MAX_IMAGES` | `64` | 保留最新的 N 张图 |
| `WORKBUDDY_SHAPE_IMAGE_DIM` | `1536` | 缩图长边上限 |
| `WORKBUDDY_SHAPE_IMAGE_QUALITY` | `3` | ffmpeg `-q:v`，越小越清晰也越大 |
| `WORKBUDDY_SHAPE_IMAGE_MAX` | `262144`（256 KiB） | 单张超过这个字节数才重编码 |
| `WORKBUDDY_SHAPE_FFMPEG` | 自动探测 | ffmpeg 可执行文件路径 |

> 这与 `openfilm-fix` 那个独立代理不是同一件事：那个代理服务的是 **OpenFilm → DeepSeek**
> 这条链路（不经过本桥），本节的整形服务的是**任何客户端 → 本桥 → WorkBuddy**。两者互不替代。

## 常见问题

**只有国内版，可以安装吗？** 可以。默认只注册检测到登录的区域；之后登录另一区域再跑一次安装。

**ZCode 里看不到新 provider？** 重启 ZCode。写配置不会热更新到已经打开的会话。

**提示 "Bridge is not running at http://127.0.0.1:10108"？** 桥接进程没起来（或已经退出）。
双击 `Start-Bridge.cmd`，或跑 `node src/cli.ts serve`；装过的话也可以重启计划任务
（`schtasks /run /tn WorkBuddyConnectBridge`）。这条提示出现在 `status` / `models` / `install` /
`smoke` 任何一个命令里，都是同一个原因。

**提示 "No bridge state in ..."？** 这台机器还没生成过桥接状态（第一次运行）。先跑一次
`node src/cli.ts serve` 或安装脚本，它会在 `%USERPROFILE%\.workbuddy-connect` 建 `bridge.json`
（内含本地 Bearer 密钥与端口），之后其它命令才有东西可读。

**端口占用？** 首次安装可传 `-Port`。已有桥接在运行时不要起第二份副本；用原来的项目目录更新或先卸载。

**WorkBuddy 401 或登录过期？** 打开对应区域的 WorkBuddy 重新登录，再重试状态 / 安装。不要把 token 发给别人排障。

**模型存在但调用失败？** 目录可见不代表每个模型都已验证。检查自己账号的权限、积分和网络；服务端限流或更新也可能导致失败。

**能接别人的账号吗？** 不能也不应该。桥接只用本机已登录的账号。

**开机时冒出黑色控制台窗口？** 2.0 起不会了。之前计划任务的动作直接是 `powershell.exe`（它再拉起
`node.exe`），而任务计划器在交互式会话里启动控制台程序时，Windows 会先给它的控制台分配窗口，
程序自己再怎么 `-WindowStyle Hidden` 也来不及——那一下闪窗就是这么来的。现在动作改成
`wscript.exe` 跑 `scripts/Launch-Bridge.vbs`：wscript 是 GUI 子系统宿主，**根本不分配控制台**，
再由它以隐藏方式启动 PowerShell 监督进程和 node 子进程。升级后再跑一次安装（或
`Remove-BridgeTask.ps1` + `Install-BridgeTask.ps1`）即可切到新布局，旧布局的任务会被原地迁移。

**macOS / Linux 能用吗？** Node 核心保留了相应的登录文件探测，但本发布只完成 Windows 验证。
其他平台可手动跑 `node src/cli.ts serve` 与 `install`，后台服务需自行配置。

## 卸载

```powershell
node src/cli.ts remove --region both        # 或双击 Uninstall.cmd
```

它会移除本桥接注册的 provider、停止桥接、删掉计划任务与启动快捷方式，保留你自己的其他
provider 和 WorkBuddy 桌面登录。删插件只需在 ZCode 的插件管理里卸载；已经运行的桥接请先按上面卸载。

## 开发

变更记录见 [CHANGELOG.md](CHANGELOG.md)。

```powershell
npm test                # 单元测试（62 个，不访问真实 WorkBuddy 账号）
npm run build:plugin    # 把运行时代码同步进插件自包含目录（改版本号后必须跑）
npm run check:plugin    # 校验插件内副本与源码一致
```

版本号只有一个来源：`package.json` 的 `version`。`/healthz` 和 `--version` 都读它
（`src/version.ts`），所以不会出现"包里写 1.0.1、接口还报 1.0.0"这种漂移。

`npm test` 与 `npm run check:plugin` 需要 Node 24 或更新；桥接本身只要 22.18。

Windows 后台托管回归检查（会创建并删除独立的测试计划任务，不调用模型）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/bridge-task.integration.ps1
```

## 来源与许可

基于 [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT）改编，
并保留其上游协议实现与 MIT 许可。本版本把接入目标从 DSH 改为 ZCode：去掉 DSH / OpenCodex
运行依赖，新增 ZCode provider 注册（`src/zcode.ts`）、ZCode 插件与技能分发，并加入
WorkBuddy 5.6.2+ 加密登录文件的本地解密。详细来源见 [NOTICE.md](NOTICE.md)。

使用 WorkBuddy 客户端接口，非官方开放 API。WorkBuddy 或 ZCode 更新后可能需要适配；
本项目与腾讯、WorkBuddy、Z.AI 无官方关联。请遵守对应服务条款，仅使用自己有权使用的账号和额度。
