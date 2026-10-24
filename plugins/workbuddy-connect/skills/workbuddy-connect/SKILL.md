---
name: workbuddy-connect
description: 把本机已登录的 WorkBuddy（国内版 / 国际版）账号模型接入 ZCode 或 Codex CLI / ChatGPT 桌面版，包括 WorkBuddy 的免费模型。桥只提供一种协议（OpenAI Responses）。当用户说「接入 WorkBuddy」「把 workbuddy 模型接到 zcode」「接进 ChatGPT」「Codex 用 WorkBuddy」「WorkBuddy 免费模型」「workbuddy-connect 装一下」「刷新 WorkBuddy 模型」「检查 WorkBuddy 连接」「卸载 WorkBuddy 接入」时使用。
---

# WorkBuddy Connect

把用户**自己账号**的 WorkBuddy 模型接进 ZCode 和/或 Codex CLI。桥接进程在本机回环地址上提供
**一种**协议——**OpenAI Responses**——再注册给各个客户端。

```text
ZCode / Codex → 本机桥接 (127.0.0.1:10108) → 用户自己的 WorkBuddy 账号
                 ├─ POST /<region>/v1/responses   (openai-responses)
                 ├─ GET  /<region>/v1/models
                 └─ GET  /<region>/v1/credits
```

**为什么是 Responses 而不是 Chat Completions**：Codex CLI 二进制里写着
`` `wire_api = "chat"` is no longer supported ``，只认 `responses`；ZCode 也支持
`api.type = "openai-responses"`。所以 Responses 能同时覆盖两边，Chat Completions 会少接一个客户端。

**不要再给用户加 Anthropic Messages**（1.3 有过，2.0 删了），也不要提 `--protocol` 参数。

**消耗的是用户自己 WorkBuddy 账号的积分。** 免费模型（倍率 `x0.00`）按 WorkBuddy 当期政策执行。

## 桥接位置

运行时源码就在本技能目录旁边：`<本技能 SKILL.md 所在目录>/assets/bridge`
（本技能的文件路径在加载时已给出，取其目录再拼 `assets/bridge`）。下文用 `$BRIDGE` 表示。

需要 **Node.js 22.18 或更新版本**。用户 PATH 里没有 `node` 很常见，优先用
`$BRIDGE/Install.cmd` / `$BRIDGE/Start-Bridge.cmd`：它们的 PowerShell 脚本会自己找 Node
（PATH → `%USERPROFILE%\.workbuddy\binaries\node` → 常见安装位置）。找不到就停下来让用户装，
不要自行安装运行时。

## 步骤

1. 确认环境与登录状态（只读，不改 WorkBuddy 的文件）：

   ```powershell
   node "$BRIDGE/src/cli.ts" accounts
   ```

   `state` 为 `signed-in` 的区域才能接入。

2. 启动桥接（后台常驻）。`Start-Bridge.cmd` 注册 Windows 计划任务（登录后隐藏启动、退出自恢复，
   **不会闪黑窗**——动作是 `wscript.exe` 跑 `Launch-Bridge.vbs`）：

   ```powershell
   node "$BRIDGE/src/cli.ts" serve --port 10108
   ```

3. 看模型目录（不消耗积分）。`billing.free=true`（`x0.00`）是免费模型：

   ```powershell
   node "$BRIDGE/src/cli.ts" models --region cn
   ```

4. 注册进 ZCode（每个区域一条 provider，`api.type` 固定 `openai-responses`）：

   ```powershell
   node "$BRIDGE/src/cli.ts" install --region cn
   node "$BRIDGE/src/cli.ts" install --region cn --free-only
   ```

   provider id 是 `workbuddy-<region>`。从旧版本升级时，`install` 会顺手清掉 1.4.x 留下的
   `-anthropic` / `-responses` 两条（报告里 `cleaned` 字段）。

5. 注册进 Codex（可选）：

   ```powershell
   node "$BRIDGE/src/cli.ts" install-codex --region cn
   node "$BRIDGE/src/cli.ts" install-codex --region cn --keep-default   # 只加列表，不改默认路由
   node "$BRIDGE/src/cli.ts" remove-codex                               # 撤回，逐字节还原
   ```

   **`--keep-default` 什么时候用**：用户已经有自己配好的 provider（比如直连官方）不想被替换。
   它照样写 `[model_providers.workbuddy]`、把目录指向合并后的 `workbuddy-models.json`，
   但不动 `model` / `model_provider`——Codex 继续走原路由，列表里多出桥的模型。

   不加这个参数时，install 会把 `model` 设成免费模型、`model_provider` 设成 `workbuddy`，
   即**默认切到桥**。**先问用户要哪种**，不要替他决定默认路由。

6. 让用户**重启客户端**（ZCode / ChatGPT 桌面版 / 新开 codex 会话）才会看到新条目。

## 其他命令

```powershell
node "$BRIDGE/src/cli.ts" status                     # 桥接、各区域登录状态、协议
node "$BRIDGE/src/cli.ts" providers                  # ZCode 注册表全部 provider（只读）
node "$BRIDGE/src/cli.ts" prune                      # 清 ZCode 里的退役布局条目
node "$BRIDGE/src/cli.ts" remove --region cn         # 移除本桥注册的 ZCode provider
node "$BRIDGE/src/cli.ts" smoke --region cn --model hy3   # 真实调用（可能消耗积分）
```

`providers` / `prune` 不需要桥在跑（只读写配置文件）。

`install` 写 ZCode 那份个人 provider 配置：默认 `%USERPROFILE%\.zcode\v2\provider_config.json`；
若改过数据目录（`dataBaseDir`），则写 `<数据目录>\.zcode\v2\provider_config.json`——**那份才是
ZCode 实际读的**（脚本会读 `setting.json` 自行判断）。`ZCODE_PROVIDER_CONFIG`（绝对路径）可覆盖。

## 汇报要求

- 报告桥接目录、端口、已接入区域、注册到哪些客户端、模型数量与免费模型 id。
- 报告 `install` / `install-codex` 实际写入的配置文件路径（打在 stderr）。
- 用 `install-codex` 时说明**是否改了 Codex 的默认路由**（加了 `--keep-default` 就没改）。
- 明确说明哪些已实测、哪些未验证（注册成功不等于请求能通，需要时用 `smoke` 或
  `codex exec` 验证）。
- 不要输出任何 token、`bridge.json` 内容或 WorkBuddy 登录文件的字段值。

## 边界

- 只使用用户自己的账号与额度；不要绕过 WorkBuddy 的登录、配额或权限设计。
- 不修改 WorkBuddy 桌面登录文件；刷新缓存只写桥自己的状态目录。
- `smoke` 会真实调用模型，只在用户同意时跑，优先免费模型。
- 卸载先 `remove` / `remove-codex`，再停桥接；不要把用户其他 provider 一起清掉。
