---
name: workbuddy-connect
description: 把本机已登录的 WorkBuddy（国内版 / 国际版）账号模型接入 ZCode，包括 WorkBuddy 的免费模型。当用户说「接入 WorkBuddy」「把 workbuddy 模型接到 zcode」「WorkBuddy 免费模型」「workbuddy-connect 装一下」「刷新 WorkBuddy 模型」「检查 WorkBuddy 连接」「卸载 WorkBuddy 接入」时使用。
---

# WorkBuddy Connect

把用户**自己账号**的 WorkBuddy 模型接进 ZCode。桥接进程在本机回环地址上提供
OpenAI Chat Completions 接口，再作为 ZCode 的自定义 provider 注册。

```text
ZCode → 本机桥接 (127.0.0.1:10108) → 用户自己的 WorkBuddy 账号
```

**消耗的是用户自己 WorkBuddy 账号的积分。** 本项目不提供账号、不附带积分。
调用量以 WorkBuddy 当时的数据为准；免费模型（倍率 `x0.00`）按 WorkBuddy 当期政策执行。

## 桥接位置

运行时源码就在本技能目录旁边：`<本技能 SKILL.md 所在目录>/assets/bridge`
（本技能的文件路径在加载时已给出，取其目录再拼 `assets/bridge`）。
下文用 `$BRIDGE` 表示该目录。

需要 **Node.js 24 或更新版本**（`node --version` 校验主版本号 ≥ 24）。普通 ZCode
桌面用户可能没有全局 `node`，先检查；缺失时停下来告诉用户去装 Node，不要自行安装。

## 步骤

1. 确认环境与登录状态。桥接只读 WorkBuddy 桌面登录文件，不修改它。

   ```powershell
   node "$BRIDGE/src/cli.ts" accounts
   ```

   `state` 为 `signed-in` 的区域才能接入；全部 `signed-out` 时请用户先在 WorkBuddy 客户端登录。

2. 启动桥接（后台、常驻）。用 `Start-Bridge.cmd` 可注册 Windows 计划任务，
   也可以直接前台/后台跑 `serve`：

   ```powershell
   node "$BRIDGE/src/cli.ts" serve --port 10108
   ```

   桥接会把自己的状态写在 `%USERPROFILE%\.zcode\workbuddy-connect`。

3. 看模型目录（不发送推理请求，不消耗积分）。`billing.free=true`（倍率 `x0.00`）
   的就是免费模型：

   ```powershell
   node "$BRIDGE/src/cli.ts" models --region cn
   ```

4. 注册进 ZCode：

   ```powershell
   # 全部可用模型（免费模型也在其中，用 --free-only 可只注册免费模型）
   node "$BRIDGE/src/cli.ts" install --region cn
   node "$BRIDGE/src/cli.ts" install --region cn --free-only
   ```

5. 让用户**重启 ZCode**，然后在模型选择器里找 `WorkBuddy CN` / `WorkBuddy Global`。

## 其他命令

```powershell
node "$BRIDGE/src/cli.ts" status                     # 桥接与各区域登录状态
node "$BRIDGE/src/cli.ts" remove --region cn         # 移除本桥接注册的 provider
node "$BRIDGE/src/cli.ts" smoke --region cn --model hy3   # 真实调用一次（可能消耗积分）
```

`install` 会写 `%USERPROFILE%\.zcode\v2\provider_config.json`（ZCode 的个人 provider
配置）。它只增删自己那一条 provider 和它名下的 model 规则，其他 provider、`providerOrder`
与手写规则都保持原样。

## 汇报要求

- 报告桥接目录、端口、已接入区域、模型数量与免费模型 id。
- 明确说明哪些检查已实测、哪些未验证（例如没做真实调用就别声称调用成功）。
- 提醒用户重启 ZCode 后才会看到 provider。
- 不要输出任何 token、`bridge.json` 内容或 WorkBuddy 登录文件的字段值。

## 边界

- 只使用用户自己的账号与额度；不要绕过 WorkBuddy 的登录、配额或权限设计。
- 不修改 WorkBuddy 桌面登录文件；桥接的刷新缓存只写在自己的状态目录里。
- `smoke` 会真实调用模型，只有在用户同意时才跑，并且优先用免费模型。
- 卸载时先 `remove`，再停桥接；不要把用户其他 provider 一起清掉。
