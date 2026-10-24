---
description: 把本机已登录的 WorkBuddy 账号模型（含免费模型）接入 ZCode
---

用 `workbuddy-connect` 技能把本机已登录的 WorkBuddy 账号接入 ZCode。

要求：

1. 先跑 `accounts` 确认有哪些区域已登录，并检查 Node.js 主版本 ≥ 22.18。
2. 起桥接（`serve`，或 `Start-Bridge.cmd` 注册 Windows 计划任务常驻）。
3. 用 `models --region <区域>` 列出模型，指出其中的免费模型（`billing.free` 为 true）。
4. 用 `install --region <区域>` 注册进 ZCode。桥只提供一种协议（OpenAI Chat Completions），
   所以没有协议可选；用户只想接免费模型时加 `--free-only`。
5. 告诉用户重启 ZCode，之后在模型选择器里能看到 `WorkBuddy CN` / `WorkBuddy Global`。

只使用用户自己的账号与额度，不要绕过 WorkBuddy 的登录或配额设计；不要输出任何 token。
把桥接目录、端口、接入区域、模型数量和免费模型 id 汇报给用户，
并说明哪些检查尚未验证（注册成功不等于请求能通）。
