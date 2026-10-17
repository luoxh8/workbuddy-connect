# WorkBuddy Connect

把 **WorkBuddy 国内版 / 国际版**里**你自己账号**的模型，变成一个本机 OpenAI 兼容接口 —— 免费模型（`hy3`、`step-5-preview` 等）也在内。
两个区域可以任选一个，也可以同时使用。

**不绑定 ZCode**：桥对外就是标准的 OpenAI Chat Completions + `/models`，任何客户端都能接
（ZCode 用自带的 `openai-chat-completions` provider；DSH 用内置 `llm-pi-ai` 指向桥；其它工具填 baseURL + key 即可）。

```text
任意客户端 → 本机 WorkBuddy Bridge (127.0.0.1:10108) → 你自己的 WorkBuddy 账号
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
   WorkBuddy 的模型接口，对外提供 **OpenAI Chat Completions**（`/v1/models`、`/v1/chat/completions`）；
2. 一个可选的安装命令，把桥接注册成 **ZCode 的自定义 provider**（写 ZCode 那份个人 provider 配置：
   默认在 `%USERPROFILE%\.zcode\v2\provider_config.json`；改过数据目录则写
   `<数据目录>\.zcode\v2\provider_config.json`）。其它客户端不需要这一步，直接填地址和 key。

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
3. 重启 ZCode，在模型选择器里找 `WorkBuddy CN` / `WorkBuddy Global`。

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

## 日常使用

```powershell
node src/cli.ts accounts                          # 只读检查桌面登录状态
node src/cli.ts status                            # 桥接与各区域状态
node src/cli.ts models --region cn                # 模型目录（含免费标记，不消耗积分）
node src/cli.ts install --region cn               # 注册/刷新（可重复运行）
node src/cli.ts install --region cn --free-only   # 只注册免费模型
node src/cli.ts remove --region cn                # 只移除本桥接注册的 provider
```

`install` 可以重复运行以同步可用模型、上下文窗口、图像输入和上游声明的推理档位；
模型目录缓存最长 5 分钟。它只增删自己那一条 provider 和它名下的 model 规则，
其他 provider、`providerOrder` 和你手写的规则都保持原样。

真实调用（会消耗积分，建议先用免费模型）：

```powershell
node src/cli.ts smoke --region cn --model hy3
```

本地 API：

- `GET /healthz`、`GET /status`
- `GET /cn/v1/models`、`POST /cn/v1/chat/completions`
- `GET /global/v1/models`、`POST /global/v1/chat/completions`

所有接口都需要桥接自己的本地 Bearer 密钥（安装时自动生成）；不需要手工粘贴 WorkBuddy token。

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
- 刷新缓存只写在桥接自己的状态目录（默认 `%USERPROFILE%\.zcode\workbuddy-connect`），
  不覆盖 ZCode 或 WorkBuddy 的登录文件。
- 运行目录含私密数据，**不要打包给别人或提交 Git**。本仓库、插件和发布包不含任何凭据。

## 常见问题

**只有国内版，可以安装吗？** 可以。默认只注册检测到登录的区域；之后登录另一区域再跑一次安装。

**ZCode 里看不到新 provider？** 重启 ZCode。写配置不会热更新到已经打开的会话。

**端口占用？** 首次安装可传 `-Port`。已有桥接在运行时不要起第二份副本；用原来的项目目录更新或先卸载。

**WorkBuddy 401 或登录过期？** 打开对应区域的 WorkBuddy 重新登录，再重试状态 / 安装。不要把 token 发给别人排障。

**模型存在但调用失败？** 目录可见不代表每个模型都已验证。检查自己账号的权限、积分和网络；服务端限流或更新也可能导致失败。

**能接别人的账号吗？** 不能也不应该。桥接只用本机已登录的账号。

**macOS / Linux 能用吗？** Node 核心保留了相应的登录文件探测，但本发布只完成 Windows 验证。
其他平台可手动跑 `node src/cli.ts serve` 与 `install`，后台服务需自行配置。

## 卸载

```powershell
node src/cli.ts remove --region both        # 或双击 Uninstall.cmd
```

它会移除本桥接注册的 provider、停止桥接、删掉计划任务与启动快捷方式，保留你自己的其他
provider 和 WorkBuddy 桌面登录。删插件只需在 ZCode 的插件管理里卸载；已经运行的桥接请先按上面卸载。

## 开发

```powershell
npm test                # 单元测试（37 个，不访问真实 WorkBuddy 账号）
npm run build:plugin    # 把运行时代码同步进插件自包含目录
npm run check:plugin    # 校验插件内副本与源码一致
```

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
