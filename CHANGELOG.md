# Changelog

按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 组织，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [1.4.0] - 2026-10-20

### Added

- **Codex CLI 与 ChatGPT 桌面版接入**（`src/codex.ts`，命令 `install-codex` / `remove-codex`）。
  两者读同一份 `~/.codex/config.toml` 与同一个模型目录，所以一次写入同时服务两边：
  - 在 `config.toml` 追加 `[model_providers.workbuddy]`（`wire_api = "responses"`，
    `base_url = http://127.0.0.1:10108/<region>/v1`），并设置 `model_provider`、
    `model_catalog_json` 与默认 `model`（优先免费模型）。
  - 生成 `<config 同目录>/workbuddy-models.json`，把 `/v1/models` 的每个模型写成 Codex 能读的
    目录条目（上下文窗口、视觉输入、推理档位、优先级）。
  - 写在 `# >>> workbuddy-connect >>>` 标记块内；块内另有 `# restore` 注释记录改动前的根键，
    `remove-codex` 据此逐字节还原（有测试保证往返一致），并删掉自己生成的目录文件。
- 默认模型只在"不是本桥提供的模型"时才改写：用户手动选过的模型在重装后保持不变。
- 目录条目会克隆本机已有目录的结构（Codex 对 `truncation_policy`、
  `supported_reasoning_levels`、`model_messages` 等字段是严格校验的），只替换本桥知道的字段。
- 首次安装会把原 `model_catalog_json` 指向的目录里的模型**合并**进新目录，避免客户端模型
  选择器里凭空少掉另一个 provider 的模型（Codex 只能读一个目录文件）。
- 测试 77 → 91：新增写入/幂等/往返还原/目录结构/跨 provider 合并/多区域等用例。

### Why the system prompt is replaced

Codex 每轮把自带的约 17 KB 系统提示词作为 `developer` 消息发出，WorkBuddy 上游会
**以 HTTP 400 拒绝这份原文**（`Codex CLI is an open source project led by OpenAI` 这段是触发点，
实测稳定复现；删词改词即通过，与长度、换行、tools 字段无关）。因此改为用 Codex 官方扩展点
`model_catalog_json` 的 `base_instructions` 下发一份等效但措辞中性的系统提示词——客户端根本不发
被拒的原文，桥接保持"只做协议翻译、不改写用户内容"。

## [1.3.0] - 2026-10-20

### Added

- **Anthropic Messages 与 OpenAI Responses 两种协议**（`src/protocols.ts`）。桥接现在在同一个
  区域地址下同时提供三条路径，客户端按自己的协议选：
  - `POST /<region>/v1/chat/completions`（原有）
  - `POST /<region>/v1/messages`（新增，接受 `x-api-key` 与 `Authorization: Bearer` 两种认证头）
  - `POST /<region>/v1/responses`（新增）
  向上游仍只发一种 Chat Completions 请求，另两种协议双向翻译：入站请求改写成 chat 体
  （`system`/`content` 块、`tool_use`/`tool_result`、`input`/`function_call_output`、
  `output_config.effort`/`reasoning.effort`、`max_tokens`/`max_output_tokens` 等），
  出站把上游 chunk 重新编码成该协议的流式事件（`message_start`…`message_stop` /
  `response.created`…`response.completed`）。
  - 并行工具调用按协议要求串行化：Anthropic 的 content block 与 Responses 的 output item
    都不能重叠，第二个调用会缓冲到前一个关闭后按完整参数重放。
  - 错误响应用各自的信封（`{type:'error',error:{type}}` / `{error:{type,code,message}}`），
    状态码映射沿用原来的分类。
- `install` / `remove` 支持 `--protocol <all|chat|anthropic|responses>`（默认 `all`）。每个区域 ×
  每种协议各注册一条 provider：`workbuddy-<region>`（沿用历史 id）、
  `workbuddy-<region>-anthropic`、`workbuddy-<region>-responses`；`--protocol` 可只动其中一条。
  `Install.ps1` / `Uninstall.ps1` 同步暴露 `-Protocol`。
- 每条 provider 的 model 规则按协议写各自的 optionSpecs 字段名：
  `reasoning_effort` / `output_config.effort` / `reasoning.effort`，
  `max_tokens` / `max_output_tokens`。
- `smoke` 增加 `--protocol`，按该协议构造请求并解析响应（`src/smoke.ts`）。
- `/status` 新增 `protocols`，列出当前桥接提供的三种协议。
- 测试 55 → 77：新增协议转换（入站/出站、非流式与流式事件序列、并行工具调用、
  错误信封）与按协议注册/卸载的用例。

### Changed

- 桥接的 401/404/413 等错误现在按请求路径所属协议返回对应信封；chat 路径保持不变。
- `remove` 的默认范围从"该区域那一条"变为"该区域三种协议各一条"，`--protocol` 可收窄。

### Fixed

- Responses 流式与最终响应现在共用同一批 item id 与 output index，之前最终 `output`
  会重新生成 id，导致流式事件指向的 item 在终态响应里不存在。
- 并行工具调用中先发起的那个把后续参数分片全部收进自己的块，之前会漏掉第一段之后的尾巴。

## [1.2.0] - 2026-10-18

### Added

- **内置大请求体整形**（`src/shape.ts`），把原先单独的 `openfilm-fix` 代理那套思路搬进桥：
  - 同一张图在历史里重复出现时只保留最新一份（客户端每轮重发整段对话，图片会一路累积）；
  - 超过张数上限时丢最旧的图；
  - 偏大的图用 ffmpeg 缩到 1536px JPEG（`-q:v 3`）；
  - 仍超预算（默认 24 MiB）时从最旧的图继续换占位，实在不行返回 `413 request_too_large`
    并说明当前字节数。
  其余字段一律原样转发；没有图片的请求只做一次字节比较。
- `/status` 新增 `shape` 段：`requests / images / duplicated / shaped / dropped / bytesIn / bytesOut / shrinker`。
- `WORKBUDDY_SHAPE_MAX_BYTES` / `_MAX_IMAGES` / `_IMAGE_DIM` / `_IMAGE_QUALITY` / `_IMAGE_MAX` / `_FFMPEG`
  六个环境变量（README 有表）。
- 测试 44 → 55：去重、张数上限、预算丢弃、无图请求零改动、无 ffmpeg 时降级、真实图片经 ffmpeg 缩图、桥端到端去重与计数。

## [1.1.0] - 2026-10-18

### Added

- `--help` / `-h`：完整命令与参数说明（原来只有 `help` 子命令，且写死了 `node src/cli.ts` 这条路径）。
- `--version` / `-v`：打印版本号。
- `src/version.ts`：版本号的唯一来源，读 `package.json`；`/healthz` 与 `--version` 共用。
- 失败时给可执行的下一步：
  - 桥没起来 → 直接告诉你用哪条命令起（`serve` / `scripts\Start-Bridge.ps1`）；
  - 状态文件还不存在（全新机器先跑 `status`）→ 提示先起一次桥；
  - 未知命令 / 未知参数 → 附上 `--help` 提示。

### Changed

- `models` / `remove` 的区域展开逻辑收敛到 `regionsOf()`，行为不变。
- README：补 npm 安装、`--help`/`--version`、两条新故障排查、状态目录默认路径（`.workbuddy-connect`）。
- 测试 37 → 44：新增区域展开、程序名推断、usage 覆盖、连接被拒判定、版本一致性、`/healthz` 版本断言。

### Fixed

- `/healthz` 里硬编码的 `version: '1.0.0'` 会与实际包版本漂移（发 1.0.1 后接口还报 1.0.0）。
- 用法提示里的程序名：npm 安装后箭头指向的是包内 `bin/cli.mjs`，原来会误显示成
  `node src/cli.ts`；现在按是否位于 `node_modules` 判断，安装后显示 `workbuddy-connect`。

## [1.0.1] - 2026-10-18

### Fixed

- **装不上**：`package.json` 的 `scripts.install` 会被 npm 当成生命周期钩子，消费者执行
  `npm i workbuddy-connect` 时会在对方机器上跑 `install` 命令（注册 provider）并直接失败。
  已改名为 `scripts.setup`，安装期零副作用。
- **跑不起来**：`bin` 指向 `src/cli.ts`，而 Node 禁止对 `node_modules` 内的 `.ts` 做类型擦除
  （`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`）。改为 `bin/cli.mjs` + `bin/ts-loader.mjs`：
  用 Node 自带的 `module.stripTypeScriptTypes` 自己擦类型，零依赖，并滤掉那条 ExperimentalWarning。

## [1.0.0] - 2026-10-18

### Added

- 首次发布到 npm：`workbuddy-connect`（本地桥 + CLI）。
- WorkBuddy 国内版 / 国际版双区域，OpenAI 兼容 `/v1/models`、`/v1/chat/completions`、`/credits`。
- ZCode provider 注册与移除（`install` / `remove`），只动自己那一条 provider 与其名下 model。
- Windows 后台托管（计划任务 + 启动快捷方式）、ZCode 插件与技能分发。

[1.3.0]: https://github.com/luoxh8/workbuddy-connect/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/luoxh8/workbuddy-connect/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/luoxh8/workbuddy-connect/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/luoxh8/workbuddy-connect/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/luoxh8/workbuddy-connect/releases/tag/v1.0.0
