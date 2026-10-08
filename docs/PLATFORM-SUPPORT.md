# DSH 视频工作台操作系统适配进度

更新日期：2026-10-08（Asia/Shanghai）。当前版本 0.4.0，宿主版本 0.2.0-rc.2。本轮已实现三系统基础适配；各平台官方 Desktop 的原生验收尚需分别完成。

[首轮环境基线](platform-baseline.json)保留适配前记录；本轮实现与验证见 [platform-adaptation.json](platform-adaptation.json)。独立应用的包、凭据或桌面结论不能作为插件验收。

本轮 Linux 类型检查与构建通过，179 项测试中 177 项通过、2 项 macOS 系统语音跳过。`artifacts/dsh-video-studio-0.4.0.tgz` 已构建，入口、文档与当前构建逐文件一致；包外导入宿主代码及包内浏览器驱动解析通过。实际 Desktop 安装仍待验收。

## 平台状态

| 目标 | 当前实现 | 验收边界 |
| --- | --- | --- |
| macOS arm64/x64 | 保留 `open` 与 `say`；共用新存储、路径与工具规则 | 已有 macOS 进度保留，本轮未重验官方 Desktop/系统语音 |
| Windows 11 x64 | 目录同步兼容、盘符/UNC包含检查、Explorer打开、Chrome/Chromium/Edge与FFmpeg搜索、CLI/npm shim与junction | Linux注入测试已覆盖规则，尚未真机执行官方Desktop、媒体和文件打开 |
| Ubuntu 24.04 LTS / Debian 13 x64 | `xdg-open`、浏览器/PATH/Snap搜索、可移植官方CLI预览入口 | 当前Debian13.6已有Web与真实媒体验证，没有显示会话或Desktop验收 |

`.github/workflows/platform-checks.yml` 已配置三系统基础检查，远端矩阵未运行。Windows/macOS 真机结论不能由当前 Linux 回归或模拟分支推导。

## 已实现

| 项目 | 入口 | 当前行为 |
| --- | --- | --- |
| 原子持久化 | `src/host/directory-sync.ts`、`store.ts` | 目录打开和同步不支持时按平台处理；文件写入、同步、重命名及真实I/O错误保持失败语义 |
| 工程路径 | `src/core/project-paths.ts`、`core/index.ts`、`host/store.ts` | 新写入拒绝Windows不便携名字、大小写/Unicode别名与嵌套冲突；保留精确共享媒体引用 |
| 文件打开 | `src/host/file-opener.ts`、`service.ts` | macOS `open`、Linux `xdg-open`、Windows `explorer.exe`；参数数组且不启用shell，检查lexical和realpath边界，仅清理所属helper |
| 工具发现 | `src/host/tool-environment.ts`、`renderer.ts`、`audio.ts` | 共用平台搜索与可执行文件规则；用户错误路径不被自动搜索掩盖 |
| 配音能力 | `src/shared/tts-capability.ts`、`AudioPanel.tsx`、`service.ts` | 本机 `say` 只在实际可用时启用；其他平台使用导入音频或自有HTTP语音接口；清除密钥独立于旧端点是否合法 |
| 开发环境 | `scripts/dev-environment.mjs`、`preview.mjs`、`prepare-local.mjs` | 显式CLI优先、PATH搜索、Windows npm shim定位官方JS bin；无个人目录默认值，Windows目录链接使用junction |
| 宿主依赖 | `scripts/link-host-dependencies.mjs` | 从用户指定的官方运行库核对并链接所需peer dependencies，缺失明确失败 |
| 媒体验收fixture | `tests/export-revision.test.ts` | 在测试中生成真实PNG并检查解码，不再依赖gitignored历史图片；仍使用真实浏览器捕帧与FFmpeg/AAC |

Windows Explorer退出1只表示系统接收请求，不能证明窗口已出现。Linux文件打开需要图形桌面及默认应用。本机语音不读取无关语音API Key，密钥继续由DSH管理，不复用聊天模型密钥。

旧Unix快照保留；核心校验以warnings描述便携性问题，新提交严格校验。物理源码访问、投影与迁移前检查冲突，Windows拒绝不可表示的旧名字。不自动改名或覆盖原工程。

## 当前环境与复验

当前环境为Debian13.6/Linuxx64、Node24.19.0、npm11.9.0，具备Chromium151、FFmpeg/ffprobe7.1.5。官方宿主安装在 `/workspace/.onboarding/dsh-runtime`，peer dependencies已链接，无需重装或改锁文件。

```sh
npm run typecheck
npm test
npm run build
```

测试需要本地socket和进程通信权限。首次受限环境的失败与给予命令级网络权限后的标准复验分别保留，不将文件级输出冒充逐用例通过。

官方Web预览可使用：

```sh
DSH_CLI=/workspace/.onboarding/dsh-runtime/node_modules/.bin/dsh \
DSH_TELEMETRY_DISABLED=1 DSH_SESSION_FIXTURE=1 DSH_PREVIEW_PORT=19405 \
DSH_PREVIEW_EXTRA_PATCH=/workspace/.onboarding/dsh-preview.patch.yml npm run preview
```

其他机器应使用自己安装的官方CLI/运行库，开发步骤见README。预览使用独立profile与固定模型提供方，只验证功能与工具，不证明真实模型质量。登录URL令牌只在检查进程内处理；不打印完整启动日志，仅停止自己的服务。

## 仍待验证

1. Windows、macOS两架构和Linux显示会话中的官方Desktop安装、打开文件、窗口、键盘焦点、取消与正常重启。
2. 目标平台的实际中文空格/盘符/长路径、存储恢复、文件句柄释放与媒体进程清理。
3. Chrome/Chromium与FFmpeg实际执行、H.264/AAC、Range播放、历史版本捕帧和完整解码；macOS系统语音单独记录。
4. 在实际宿主安装TGZ并核对内容哈希，验证新机器可依文档准备开发与验收环境；本轮仅验证Linux TGZ内容与包外导入。
5. 整理其余历史 `verify-*.mjs` 的平台默认路径；`prepare-native.mjs`继续仅适用于macOS，Windows/Linux需要独立原生验收入口。

已有v0.4首页在780px窗口的2px横向溢出未修，后续焦点断言未执行。本轮没有修改该断言或注入样式。历史云端辅助图片仅为fixture，不代表原生30秒示例验收；新回归不再需要它。

Windows文件symlink权限不足时明确跳过，配置 `DSH_REQUIRE_SYMLINK_TESTS=1` 可要求缺少权限时失败。该跳过不算安全边界通过。真实模型/语音质量、完整人工观看听音和公开发行仍未验收。
