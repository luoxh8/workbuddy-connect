---
description: 把本机已登录的 WorkBuddy 账号模型（含免费模型）接入 ZCode 与 Codex CLI
---

用 `workbuddy-connect` 技能把本机已登录的 WorkBuddy 账号接入客户端。

要求：

1. 先跑 `accounts` 确认有哪些区域已登录，并检查 Node.js 主版本 ≥ 22.18。
2. 起桥接（`serve`，或 `Start-Bridge.cmd` 注册 Windows 计划任务常驻；启动器已改成 wscript，不闪黑窗）。
3. 用 `models --region <区域>` 列出模型，指出其中的免费模型（`billing.free` 为 true）。
4. 用 `install --region <区域>` 注册进 ZCode（`api.type = openai-responses`，每个区域一条）。
   用户只想接免费模型时加 `--free-only`。
5. 需要接 Codex / ChatGPT 桌面版时再跑 `install-codex --region <区域>`。
   **先问用户**：默认路由要不要切到桥？
   - 要（默认）：直接 `install-codex`，会把 `model_provider` 设为 `workbuddy`、`model` 设为免费模型；
   - 不要：加 `--keep-default`，只把桥的 provider 和合并后的目录加上，默认路由不动。
6. 告诉用户重启 ZCode（及 ChatGPT 桌面版）之后在模型选择器里能看到新条目。

只使用用户自己的账号与额度，不要绕过 WorkBuddy 的登录或配额设计；不要输出任何 token。
把桥接目录、端口、接入区域、注册到哪些客户端、模型数量和免费模型 id 汇报给用户，
并说明哪些检查尚未验证（注册成功不等于请求能通）。
