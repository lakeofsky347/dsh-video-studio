# 映流 0.3 交付与验收说明

这份说明固定记录验收方法、交付内容与证据边界。实际测试数量、最终安装包 SHA-256、原生检查结果和清理状态，以 `artifacts/verification/v0.3/acceptance.md` 与 `delivery.json` 为准；本文件不提前宣布原生验收或正式发行完成。

## 本版验证范围

0.3 将工程数据、每个镜头的完整 HTML/CSS/JavaScript 和修改历史一起保存。制作任务固定启动时的 revision；后续改源码或删镜头时，既有任务仍读取那个版本。历史成片与任务记录保存在项目中，重新打开后可查看成片、错误与重试记录。

本版验收重点覆盖这些实际操作：

| 场景 | 检查内容 | 证据位置 |
| --- | --- | --- |
| 工程保存 | 完整版本提交、并发 revision 冲突、未完成写入恢复、重启撤销/重做 | `tests.tap`、存储与服务回归测试 |
| 源码编辑 | 切换镜头和页面保留草稿；显式保存后预览更新；源码与工程一起撤销/重做 | `ui/verification.json`、`native/verification.json` |
| 工程列表 | 搜索、重命名、独立复制、归档与恢复 | `ui/verification.json`、`native/verification.json` |
| 历史成片 | 两次实际导出各自保留；可在插件面板中分别播放 | `native/verification.json`、`native/restart.json` |
| 任务记录 | 失败导出保留错误；修正环境后从界面重试；重启恢复已完成任务 | `native/verification.json`、`native/restart.json`、`media/verification.json` |
| 会话创作 | 官方 agent loop 发出真实插件工具调用；两个 Session 分别关联工程、素材、声音与导出任务 | `native-session/session-acceptance.json` |
| 会话恢复 | 重启后两个 Session 保留各自绑定与最新参数、音轨、镜头和输出 | `native/restart.json` |
| 固定版本导出 | 修改源码、删除第二镜头及其物理目录后，旧 revision 仍导出原画面 | `media/verification.json`、`media/old-media.json` |
| 新版本导出 | 重启后当前版本实际导出，第二次重启保留两条输出与任务 | `media/verification.json`、`media/new-media.json` |
| 可搬运工程 | ZIP 保留 `.studio`、素材、源码、输出与任务；临时解压后重新打开、读取历史源码和播放两成片 | `example-readback.json`、`archives.json` |
| 安装一致性 | 最终 TGZ、实体安装和当前生产文件逐项 SHA-256 相等 | `native/installation-integrity.json` |

上述证据路径相对于 `artifacts/verification/v0.3/`。只有对应记录实际为 `PASS`，才将该项列入最终交付结果。

## 执行与封存顺序

1. 完成生产源码与本说明，运行完整回归和类型检查，构建 candidate 安装包。源码和文档在原生验收期间保持冻结。
2. 使用 `scripts/prepare-native.mjs` 将该 candidate 实体安装到独立的官方 DSH Desktop 副本中。原生 profile 和项目目录独立，真实供应商禁用。
3. 在官方 Web 与 Desktop 上验证工程库、源码草稿、历史成片、任务重试；在 Desktop 官方 agent loop 中验证会话工具与两个 Session 的隔离。
4. 正常关闭自己启动的验收副本后重新启动，验证工程、源码、历史、两条成片、任务及 Session 绑定恢复。关闭本轮启动的进程并记录清理结果。
5. 最后执行 `node --import tsx scripts/finalize-v03.mjs`，核对报告使用的 package SHA、当前生产文件和实际安装字节。脚本不运行构建，不调用 `npm pack`，不安装插件，也不调用真实模型或配音供应商。
6. 脚本从已验收的 candidate 复制正式 TGZ，制作源码 ZIP 和可继续编辑的示例 ZIP，逐文件回读后写入 SHA-256 与最终交付清单。它不会覆盖 0.1 或 0.2 的历史交付。

`finalize-v03.mjs` 默认读取 `artifacts/candidate/dsh-video-studio-0.3.0.tgz` 和由该包 SHA 前 12 位定位的 `.local/native/<sha>/prepared.json`。可以通过前两个命令行参数指定这两个路径；`DSH_V03_VERIFY_DIR` 可指定验收报告目录。默认报告包括 `tests.tap`、`ui/verification.json`、`native/verification.json`、`native/restart.json`、`native-session/session-acceptance.json`、`media/verification.json` 和 `cleanup.json`。

## 可继续编辑的示例

示例来自本轮独立的 0.3 媒体验收工程。旧版本为两个镜头，新版本为一个镜头，各自实际导出 2 秒 H.264/AAC 成片。画面包含中文与一张已有真实图片，声音是本地 FFmpeg 合成的正弦验收音。旧版关键帧在源码修改、镜头删除前后应保持相同 SHA-256，旧成片的输入源码哈希必须对应旧版本。

交付目录包含当前工程、资产、当前镜头源码、全部 `.studio/versions` 与 `.studio/revisions`、历史任务、两部实际成片和原来源记录。解压示例后，在工作台中打开 `v0.3-revision-project` 目录；不要只搬运 `project.json`，隐藏的 `.studio` 目录是完整版本与历史的保存依据。

封存仅在示例副本中将旧机器的输出路径改为项目相对路径、去掉已失效的 loopback URL。源码、素材、实际 MP4 字节、镜头 ID 与 revision 保持不变。重新打开时由插件为当前目录生成新的预览与成片 URL。

## 证据边界

- 官方 DSH 宿主与真实插件工具链通过离线模型 fixture 验证。fixture 的响应与工具顺序是固定验收输入，不代表已配置真实供应商的可用性或创作质量。
- Chrome、FFmpeg、ffprobe 和本地媒体是实际运行结果。完整解码、规格核对、关键帧哈希与插件中的播放分别记录，不能用导出状态代替可播放证据。
- 本轮版本导出样例的声音为合成验收音。0.2 曾验证的本地中文配音结果属于历史证据；除非 0.3 本轮记录明确包含复验，不将它计作本轮配音验收。
- 没有调用真实云端聊天模型、外部配音供应商或付费生成接口，也不宣称跨机器性能、真人全片观看或听音验收完成。
- 验收副本的安装与正式用户 profile 的安装是不同操作。最终清单说明本轮实际安装位置；不据隔离副本的结果宣称已升级用户正式 DSH。

0.1 和 0.2 的已封存交付包均在执行前、执行后核对已知 SHA-256。0.3 的最终结果、交付包大小、哈希、报告数量及真实供应商的 `NOT_CHECKED` 状态保存在独立的最终交付记录中。
