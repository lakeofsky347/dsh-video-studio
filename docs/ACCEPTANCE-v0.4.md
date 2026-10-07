# 映流 0.4 验收与交付方法

本版验收目录为 artifacts/verification/v0.4。最终安装包哈希、测试数量、原生结果和清理状态以该目录 delivery.json 与 acceptance.md 为准。

## 检查范围

- 独立影片首页、已有项目与会话搜索、关联与更换当前工程、解除指定关联、多个会话共用影片。
- 普通侧栏进入首页、工具卡片直达工程和帧、返回实际调用会话、源码草稿与参数保存状态。
- v1 索引迁移、原子关联提交、过期关系检查、关联不改变影片内容 revision。
- subagent、嵌套子代理、agent team 成员继承最近工程、专属绑定、显式工程 ID、普通 fork 独立。
- 子代理写入需要 revision，两个并发修改不会互相覆盖；Job 保留调用者及启动工程。
- 官方 DSH Web 与 Desktop 页面、深浅主题、窄窗口、键盘与弹窗焦点、重启恢复。
- 原有本地媒体、音轨、源码、版本与导出回归。

## 可重复执行

运行 npm run typecheck、npm test、npm run build。完整测试需要本机 Chrome/Chromium、FFmpeg、ffprobe、macOS 系统语音及回环测试服务；本地服务受沙箱限制时应授予相应运行权限后复验。

scripts/verify-home-v04.mjs 使用独立 DSH profile 中的真实会话与插件接口。DSH_V04_SESSION_FIXTURE=1 使用固定离线模型响应，通过宿主 Agent loop、实际工具和渲染验证指定帧入口。scripts/verify-theme-v04.mjs 通过宿主设置切换主题。Session 目录与关联的单元检查见 tests/session-directory-v04.test.ts、home-controller-v04.test.ts、session-relations.test.ts。

安装包使用 npm pack 生成；原生验收通过 prepare-native.mjs 将包实体安装到独立官方 Desktop 副本，与用户日常 profile 分开。验收报告保存安装包 SHA，封存时逐文件核对包、实际安装和生产源码产物。源码 ZIP 回读验证每个文件。

## 证据边界

模型 fixture 与真实供应商分开记录。离线响应不代表云端模型的可用性或导演质量；代理与团队检查应说明使用了宿主实际运行机制还是模拟目录。系统配音、实际媒体回读与真人听音观看也分别记录。

隔离验收安装不代表用户日常 DSH 已升级。最终结果说明真实安装位置、已完成检查和 NOT_CHECKED 项。验收结束后只关闭本轮启动的进程。
