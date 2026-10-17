# Changelog

按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 组织，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

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

[1.1.0]: https://github.com/luoxh8/workbuddy-connect/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/luoxh8/workbuddy-connect/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/luoxh8/workbuddy-connect/releases/tag/v1.0.0
