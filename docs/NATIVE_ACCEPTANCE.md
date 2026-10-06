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

## V0.3 工程、草稿与持久历史验收

V0.3 的源码检查、真实媒体、官方 Web 和原生 Desktop 记录写入 `artifacts/verification/v0.3/`，保留前述 V0.2 目录。旧版报告可以作为回归参考，不能代替新版安装包的实际验收。DSH Session 继续负责对话与模型工具调用；本版工程列表用于管理工程，未迁入独立应用的对话入口。

### 最终包与原生副本

在插件目录执行检查、构建和打包。打包使用刚完成的构建，随后准备这个确切 TGZ 的原生副本：

```sh
npm run typecheck
npm test
npm run build
npm pack --ignore-scripts --pack-destination artifacts
DSH_SESSION_FIXTURE=1 node scripts/prepare-native.mjs /absolute/path/dsh-video-studio-0.3.0.tgz
```

从本次 `prepared.json` 读取 `archive.sha256`、`launchScript`、`installed`、`dshHome`、`userData` 和 `projects`。确认版本为 `0.3.0`、安装内容与包字节对应，之后再由当前任务安排启动。不要将构建后再次变化的源码作为这个包的验收对象。

```sh
/absolute/path/to/launch-native.sh --remote-debugging-port=19408
```

端口可改成本次隔离副本独占的空闲端口；下述 `DSH_NATIVE_CDP` 应使用同一个端口。`DSH_TEST_URL` 取自本次隔离宿主实际记录的本地 Web 地址，包含访问 token；示例中的占位值不能直接执行，也不要将实际 token 写入验收报告。

### 新版 UI 与正常重启

`verify-v03.mjs` 通过 HTTP 请求准备本地验收工程，通过真实页面操作验证交互。原生模式连接自己的 Desktop webContents，不启动第二个浏览器实例；省略 `DSH_NATIVE_CDP` 时使用官方隔离 Web 页面。

```sh
DSH_TEST_URL='http://127.0.0.1:LOCAL_PORT/?token=LOCAL_TOKEN' \
DSH_NATIVE_CDP='http://127.0.0.1:19408' \
DSH_PACKAGE_SHA='SHA256_FROM_PREPARED_JSON' \
DSH_V03_REPORT_DIR='artifacts/verification/v0.3/native' \
node scripts/verify-v03.mjs
```

脚本覆盖以下操作，成功或失败均写入 `verification.json`，截图保存在同一报告目录：

- 编辑源码草稿，切换镜头和面板后恢复；未保存时预览操作提示处理草稿。刷新 DSH 页面后重新找到草稿，明确保存后读取正式源码。
- 将 Chromium 路径临时设为 `/bin/false`，实际触发导出失败；修正环境后从任务记录重试，核对新任务的 `retryOf` 和实际 MP4 结果。
- 生成两条 H.264/AAC 成片记录，分别在插件播放器播放，读取尺寸、时长、播放时间推进和媒体错误状态。
- 保存参数后撤销，刷新页面再重做，核对工程内容及持久历史。
- 在工程列表重命名、复制、归档、恢复及搜索；核对副本新 ID、源码与素材，并确认不继承原工程的 Session 和成片。

第一次流程结束后，使用正常退出关闭自己启动的 Desktop 副本，再启动**同一个** `launch-native.sh`。重新读取该次启动的实际本地地址，保持同一个 `DSH_V03_REPORT_DIR`，执行：

```sh
DSH_TEST_URL='http://127.0.0.1:NEW_LOCAL_PORT/?token=NEW_LOCAL_TOKEN' \
DSH_NATIVE_CDP='http://127.0.0.1:19408' \
DSH_PACKAGE_SHA='SHA256_FROM_PREPARED_JSON' \
DSH_V03_REPORT_DIR='artifacts/verification/v0.3/native' \
DSH_V03_RESTART=1 \
node scripts/verify-v03.mjs
```

重启流程读取首轮 `verification.json` 中的工程 ID，核对源码、两条成片、可重做历史及持久任务，并实际播放历史 MP4，另存 `restart.json`。脚本结束会关闭其浏览器连接；Desktop 进程是否正常退出应由启动者另行核实，不能用脚本退出代替进程清理记录。

### 历史源码与真实媒体链路

```sh
node --import tsx scripts/verify-media-v03.mjs
```

此脚本使用已有本地图片、受控中文源码和本地合成的正弦验收音，不调用聊天或配音供应商。它先固定两镜头的完整版本，再修改当前源码并移除一个镜头的当前源码目录，仍按旧版本实际捕获与导出。核对旧关键帧哈希、输入源码哈希、H.264/AAC、帧数、尺寸、时长、完整解码和 Range 读取；随后按当前版本再次导出，并重启服务检查两条历史记录与完成任务。

结果位于 `artifacts/verification/v0.3/media/verification.json`，同时保存项目、源码、关键帧和两份媒体回读文件。媒体脚本通过不代表真实模型创作质量、配音模型质量或全片人工观看通过。

### 补充的接口边界回归

下列边界需要额外的定向测试或实际操作记录，基础 `verify-v03.mjs` 通过不等于这些边界已覆盖：

- 在工程 A 留下源码草稿，打开工程 B 再返回 A，确认只恢复 A 对应镜头的草稿；运行任务、切回 Session 或离开工作台后仍保留。保存提交失败或返回 `REVISION_CONFLICT` 时草稿不得清空。
- 留下草稿后由 Session 工具更新同一工程，重新读取最新工程，对照当前源码后明确将草稿保存到当前版本。检查自己的参数自动保存完成后仍能保存源码；保存期间继续输入的新草稿也应保留。
- 连续撤销跨过导出和 Session 关联操作，确认已经完成的 MP4 仍在历史成片列表，并且会话工具仍按当前关联打开同一工程；重做后也应一致。
- 同一 Session 从工程 A 改绑到 B，再从工程列表打开 A。A 的返回会话入口与实际工具路由要一致；普通打开/焦点跳帧不得改变另一个 Session 已有的关联。
- 当前选中 A 时，在工程库重命名 B，继续当前工程及刷新页面后应保持选择一致；随后从 Session 卡片打开明确工程与帧，核对当前镜头和局部帧。

分别记录源码/接口检查、固定模型的真实宿主交互、实际媒体回读、原生正常重启，以及仍未进行的真人观看或真实供应商验证。最终包若重新构建，应按新包 SHA 准备新的隔离副本并重新验收。
