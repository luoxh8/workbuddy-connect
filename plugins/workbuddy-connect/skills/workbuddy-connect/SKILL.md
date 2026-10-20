---
name: workbuddy-connect
description: 把本机已登录的 WorkBuddy（国内版 / 国际版）账号模型接入 ZCode、ChatGPT 桌面版或 Codex CLI，包括 WorkBuddy 的免费模型；三种协议（OpenAI Chat Completions / Anthropic Messages / OpenAI Responses）全部注册。当用户说「接入 WorkBuddy」「把 workbuddy 模型接到 zcode」「接进 ChatGPT」「接到 ChatGPT 桌面版」「Codex 用 WorkBuddy」「WorkBuddy 免费模型」「workbuddy-connect 装一下」「刷新 WorkBuddy 模型」「检查 WorkBuddy 连接」「卸载 WorkBuddy 接入」时使用。
---

# WorkBuddy Connect

把用户**自己账号**的 WorkBuddy 模型接进 ZCode。桥接进程在本机回环地址上同时提供
**OpenAI Chat Completions**、**Anthropic Messages**、**OpenAI Responses** 三种协议，
再作为 ZCode 的自定义 provider 注册（每个区域 × 每种协议各一条）。

```text
ZCode / 任意客户端 → 本机桥接 (127.0.0.1:10108) → 用户自己的 WorkBuddy 账号
                      ├─ POST /<region>/v1/chat/completions   (openai-chat-completions)
                      ├─ POST /<region>/v1/messages           (anthropic-messages)
                      └─ POST /<region>/v1/responses          (openai-responses)
```

**三种协议共享同一端口、同一区域凭据、同一个 `GET /<region>/v1/models`。**
向上游只发一种 Chat Completions 请求，另两种在桥接内部双向翻译；图片去重 / 缩图 / 超预算丢弃
对三条路径都生效。

**消耗的是用户自己 WorkBuddy 账号的积分。** 本项目不提供账号、不附带积分。
调用量以 WorkBuddy 当时的数据为准；免费模型（倍率 `x0.00`）按 WorkBuddy 当期政策执行。

## 桥接位置

运行时源码就在本技能目录旁边：`<本技能 SKILL.md 所在目录>/assets/bridge`
（本技能的文件路径在加载时已给出，取其目录再拼 `assets/bridge`）。
下文用 `$BRIDGE` 表示该目录。

需要 **Node.js 22.18 或更新版本**（桥接直接跑 TypeScript）。用户 PATH 里没有 `node` 很常见，
所以优先用 `$BRIDGE/Install.cmd` / `$BRIDGE/Start-Bridge.cmd`：它们的 PowerShell 脚本会自己找
Node（PATH → WorkBuddy 自带运行时 `%USERPROFILE%\.workbuddy\binaries\node` → 常见安装位置）。
只有直接调 CLI 时才需要自己定位 `node.exe`；确实找不到任何可用 Node 时，停下来让用户安装，
不要自行安装运行时。

## 步骤

1. 确认环境与登录状态。桥接只读 WorkBuddy 桌面登录文件，不修改它。

   ```powershell
   node "$BRIDGE/src/cli.ts" accounts
   ```

   `state` 为 `signed-in` 的区域才能接入；全部 `signed-out` 时请用户先在 WorkBuddy 客户端登录。

2. 启动桥接（后台、常驻）。`Start-Bridge.cmd` 会注册 Windows 计划任务（登录后隐藏启动、
   意外退出自动恢复）；也可以直接后台跑 `serve`：

   ```powershell
   node "$BRIDGE/src/cli.ts" serve --port 10108
   ```

   桥接会把自己的状态写在 `%USERPROFILE%\.workbuddy-connect`。

3. 看模型目录（不发送推理请求，不消耗积分）。`billing.free=true`（倍率 `x0.00`）
   的就是免费模型：

   ```powershell
   node "$BRIDGE/src/cli.ts" models --region cn
   ```

4. 注册进 ZCode。**默认三种协议全注册**（每个区域三条 provider）：

   ```powershell
   # 全部可用模型 × 三种协议（免费模型也在其中）
   node "$BRIDGE/src/cli.ts" install --region cn
   node "$BRIDGE/src/cli.ts" install --region cn --free-only

   # 只要某一种协议（chat / anthropic / responses）
   node "$BRIDGE/src/cli.ts" install --region cn --protocol anthropic
   ```

   | `--protocol` | ZCode `api.type` | 请求路径 | provider id |
   |---|---|---|---|
   | `chat`（默认含） | `openai-chat-completions` | `/v1/chat/completions` | `workbuddy-<region>` |
   | `anthropic` | `anthropic-messages` | `/v1/messages` | `workbuddy-<region>-anthropic` |
   | `responses` | `openai-responses` | `/v1/responses` | `workbuddy-<region>-responses` |

   每条的 `optionSpecs` 用该协议自己的字段名（`reasoning_effort` /
   `output_config.effort` / `reasoning.effort`，以及 `max_tokens` / `max_output_tokens`），
   所以推理档位与输出上限在三条 provider 上都可用。

5. 让用户**重启 ZCode**，然后在模型选择器里找 `WorkBuddy CN`、`WorkBuddy CN · Anthropic`、
   `WorkBuddy CN · Responses`（国际版同理）。

## 接入 ChatGPT 桌面版 / Codex CLI

Windows 上 ChatGPT 桌面版就是 Codex（MSIX 包名 `OpenAI.Codex`）；它和 `codex` 命令行读同一份
`%USERPROFILE%\.codex\config.toml`、同一个模型目录，所以一条命令同时接两边：

```powershell
node "$BRIDGE/src/cli.ts" install-codex --region cn
node "$BRIDGE/src/cli.ts" remove-codex        # 撤回，逐字节还原 config.toml
```

它会在 `config.toml` 里写一个 `# >>> workbuddy-connect >>>` 标记块
（`[model_providers.workbuddy]`、`model_provider`、`model_catalog_json`、默认免费 `model`），
并在同目录生成 `workbuddy-models.json`。写完要**重启 ChatGPT 桌面版**（或开新的 codex 会话）。

**不要跳过目录文件**：Codex 每轮会把它自带的约 17 KB 系统提示词作为 `developer` 消息发出，
WorkBuddy 上游会以 HTTP 400 拒掉该原文（触发点含 `Codex CLI is an open source project led by OpenAI`）。
目录里的 `base_instructions` 是 Codex 官方的覆盖入口，用来下发一份等效但措辞中性的提示词——
没有它，连接本身会通，但每次对话都 400。

若用户原来的 `model_catalog_json` 指向别处，install 会**合并**那个目录的模型，不会让它们消失；
安装报告的 `note` 会写明保留了几个。

## 其他命令

```powershell
node "$BRIDGE/src/cli.ts" status                     # 桥接、各区域登录状态、可用协议
node "$BRIDGE/src/cli.ts" remove --region cn         # 移除本桥接注册的 provider（默认三种全删）
node "$BRIDGE/src/cli.ts" remove --region cn --protocol responses   # 只删一条
node "$BRIDGE/src/cli.ts" smoke --region cn --model hy3 --protocol anthropic   # 真实调用（可能消耗积分）
```

`smoke` 必须显式给 `--protocol chat|anthropic|responses`：它按该协议构造请求并解析响应，
这样才能真的验证那条路径，而不是拿 chat 的结论冒充。

`install` 会写 ZCode 那份个人 provider 配置：默认 `%USERPROFILE%\.zcode\v2\provider_config.json`；
若在「设置 → 数据目录」里改过数据目录（`dataBaseDir`），则写
`<数据目录>\.zcode\v2\provider_config.json`——**那份才是 ZCode 实际读的**，写错地方模型不会出现
（脚本会读 `%USERPROFILE%\.zcode\v2\setting.json` 自行判断）。它只增删自己那几条 provider
和它们名下的 model 规则，其他 provider、`providerOrder` 与手写规则都保持原样；
`ZCODE_PROVIDER_CONFIG`（绝对路径）可显式指定目标文件。

## 汇报要求

- 报告桥接目录、端口、已接入区域、**已注册的协议**、每条协议的模型数量与免费模型 id。
- 报告 `install` 实际写入的配置文件路径（它打在 stderr 上）。
- 明确说明哪些检查已实测、哪些未验证（例如没做真实调用就别声称调用成功；
  注册成功不等于请求能通，需要时用 `smoke --protocol <p>` 分别验证）。
- 提醒用户重启 ZCode 后才会看到 provider。
- 不要输出任何 token、`bridge.json` 内容或 WorkBuddy 登录文件的字段值。

## 边界

- 只使用用户自己的账号与额度；不要绕过 WorkBuddy 的登录、配额或权限设计。
- 不修改 WorkBuddy 桌面登录文件；桥接的刷新缓存只写在自己的状态目录里。
- `smoke` 会真实调用模型，只有在用户同意时才跑，并且优先用免费模型。
- 卸载时先 `remove`，再停桥接；不要把用户其他 provider 一起清掉。
  只删其中一种协议时用 `--protocol`，别的协议 provider 必须保留。
