# 原生 DSH 验收隔离

`scripts/prepare-native.mjs` 准备一个用于验收的独立 DSH Desktop 副本，不启动它，也不修改 `/Applications/DeepSeek Harness.app` 或用户正式 DSH profile。

## 准备

先构建插件并取得最终安装包，之后执行：

```sh
node scripts/prepare-native.mjs /absolute/path/dsh-video-studio-0.2.0.tgz
```

脚本将安装包复制并提取到 `.local/native/<archive-sha256-prefix>/home/profiles/desktop/node_modules/dsh-video-studio/`。插件目录是安装包中的真实文件，不是指向源码的 symlink；逐文件 SHA-256 与归档回读相等后才进入后续准备。宿主外部依赖 `playwright-core` 从已有本地同版本安装物理复制，无网络安装。

准备目录包含独立 DSH_HOME、Electron userData/sessionData、日志、Documents、插件视频项目目录、模拟模型 provider、官方 Desktop 的应用副本以及 `prepared.json`。同哈希准备目录已存在时拒绝覆盖；继续验收前检查原记录和实际文件。

## 应用副本的最小修改

官方原生程序是 `/Applications/DeepSeek Harness.app`。通过 APFS clone 或 ditto 复制到当前工作区，保持官方应用与其进程不变。副本修改如下：

- 独立 CFBundleIdentifier、JavaScript 包名和显示名；保留 CFBundleName 为 `DeepSeek Harness`，以便 Electron 找到已打包的 helper。
- ASAR 内只修改 `package.json` 和官方的主入口。所有其他 packed entries 字节与 unpacked/link 描述逐项保持一致。
- 在主入口请求单实例锁之前设置验收 userData、sessionData、logs 和 documents 路径。
- 关闭副本中 `setAsDefaultProtocolClient("dsh")` 调用，并删除副本 plist 的 URL 声明，避免修改系统 dsh:// 默认处理器。仅删除 plist 不足够：官方主入口在 packaged 启动时会主动注册。
- 移除副本的 mandatory update policy、启动自动更新调用和 app-update.yml，避免验收副本进行 vendor 更新查询或安装。
- 更新副本的 ASAR header integrity，使用独立 ad-hoc 签名并执行 deep strict 验证。

源码替换必须每项恰好命中一次；官方入口变化时脚本停止，不猜测其他位置。准备记录保存官方/副本 ASAR 哈希、修改项、其他条目对照结果和隔离路径。

## 启动与证据

准备成功后 `prepared.json.status` 为 `prepared-not-launched`，并产生 `launch-native.sh`。启动需当前任务根代理明确安排；准备脚本不启动应用。

启动脚本直接运行这个应用副本的 executable，传入独立 `--user-data-dir` 和日志路径；设置 DSH_HOME 与所有验收路径，并移除 `ELECTRON_RUN_AS_NODE`。不用 `open` 选择正式应用，不退出或停止其他 DSH 进程。

profile 禁用真实 provider adapters，account/inference origins 设置为 loopback，不读取或复制正式凭据。验收的 `video-studio-offline/offline-video` 是明确的模拟模型，用于真实原生宿主中的插件交互和代码渲染，不证明任何真实生成模型质量或付费 API 成功。

原生验收应分别记录：安装包实体读取、插件页面载入、图与参数编辑、模拟生成、共享参数与源码联动、完整预览、实际 MP4 导出与媒体回读、错误/取消/恢复、重开项目和 own-process 清理。构建通过、准备通过、原生界面观察、模拟提供商测试和真实提供商测试是不同证据，不能互相替代。

准备本身不会生成原生 UI 或导出成功的结论。原生启动后还应回读实际 DSH_HOME、profile、项目目录及输出版本，最后正常退出自己启动的副本，保留准备和验收记录。


## V0.2 会话与声音验收

准备最终发行包时设置 `DSH_SESSION_FIXTURE=1`，将 profile 模型切换为 `video-studio-session-offline/offline-session-video`。该固定提供方通过官方 agent loop 发出真实工具调用，可覆盖图片附件、源码提交、帧捕获、后台导出、音频导入、Jobs 取结果与取消。

启动原生副本时设置 `DSH_VIDEO_SESSION_LOG` 和 `DSH_VIDEO_SESSION_AUDIO` 为本次隔离目录里的记录和测试 WAV 路径，可加 `--remote-debugging-port=19408` 让专用验收脚本连接自己启动的 webContents。`scripts/verify-session.mjs` 支持 `DSH_TEST_URL`、`DSH_NATIVE_CDP` 和 `DSH_SESSION_REPORT_DIR`，原生模式实际点击卡片、进入工作台、编辑参数、返回同一会话。日志不保存登录 token 或真实凭据。

V0.2 的记录独立写入 `artifacts/verification/v0.2/`。原生验收仍要检查最终 TGZ 与实体安装字节一致，并正常关闭验收副本；正式应用和用户 profile 的安装状态另行说明。
