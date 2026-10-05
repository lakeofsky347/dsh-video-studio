# 映流 · DSH 视频工作台

`dsh-video-studio` 0.1.0 是 DSH Desktop 的独立插件。在一个页面中把图文变成可编辑分镜，生成前端画面代码，再预览、修改和导出无声 MP4。

## 安装与环境

在 DSH 的「插件管理 → 添加插件」中输入发行 `.tgz` 的绝对路径，安装完成后启用。适配 DSH `0.2.0-rc.2`，首版以 macOS Desktop 为验收平台。

插件包含独立 LiteGraph 客户端和 Playwright 驱动，不需要安装 ComfyUI/Python/生成模型。渲染使用本机 Chrome/Chromium、FFmpeg、ffprobe。在工作台「环境」页查看探测结果或配置执行文件路径。模型复用 DSH 已配置供应商；插件不管理 API Key。

新项目默认保存到 `~/Documents/DSHVideoProjects`。组合包配置 `baseDirectory` 可以修改位置。开发验收使用独立 `.local/projects`，不修改正式桌面 profile。

## 开始制作

1. 从 DSH 侧栏打开「映流 · 视频工作台」，新建项目，填写标题、主题、目标时长与横竖屏。默认 1080p、30 FPS、30 秒、无声。
2. 上传 PNG/JPEG/WebP，或粘贴文字、导入 TXT/Markdown。图片复制到项目内；资产名称和说明可以编辑。
3. 选择 DSH 供应商和模型，点击「生成分镜」。也可以手动添加镜头、连接素材。支持图片的模型可通过 DSH attachment 服务接收图片；文字模型使用素材名称和说明。
4. 检查镜头目标、构图、动作和文字。资产的「使用」或「参考」端口连接镜头；镜头的「下一镜头」串成主链，最后连接成片节点。拖动画布节点用于整理；图片在视频中的位置通过镜头属性修改。
5. 点击「生成画面」，模型逐镜头编写 HTML/CSS/JavaScript。插件检查关键帧，运行错误自动修复一次；持续错误显示对应镜头和日志。
6. 在「预览」中播放、拖动时间或跳到镜头。常见参数即时刷新画面；复杂设计可通过自然语言修改选中镜头或整片。高级「源码」页可以分别编辑 HTML、CSS、JS，保存并检查。
7. 点击「导出 MP4」。导出使用启动时的项目快照，编辑不会改变正在输出的版本。完成后在插件中播放视频或打开输出目录。

页面自动保存项目。可以离开页面再返回，或者重启 DSH 后继续编辑。撤销/重做作用于当前编辑过程；上个可用源码单独保存，供运行错误时恢复。

## 编辑与项目结构

`project.json` 保存分镜、共享参数、资产引用和画布布局；`assets/` 保存图片；`shots/<id>/index.html`、`style.css`、`scene.js` 是每个镜头的可编辑源码。`runtime/` 与项目根运行页由插件生成；`exports/<id>/` 保存成片、输入快照与检查信息。整个项目目录可复制或搬走。

分镜顺序和参数负责内容编排，源码负责具体画面。改文字、素材、颜色、位置和时长无需重新生成整片；自然语言设计修改以当前源码为基础。任意自定义源码不自动反向解析成图形对象。代码中写死的值需要源码或 AI 修改。

默认场景及模型场景遵循 `ready(ctx)` / `render(ctx)`，整片由 `window.__VIDEO_WORKPACK__.ready()` 与 `renderFrame({frame,fps})` 驱动。重复、倒序、拖动与导出均使用同一时间输入。API、参数与扩展位置见 [docs/API.md](docs/API.md)。

首版输入仅图片和文字；不包含音轨、上传视频、图层关键帧时间线、云端队列或多人编辑。图编辑器、场景生成器、帧渲染器和导出器分别具有替换接口。

## 开发与验收

```sh
npm ci --legacy-peer-deps --ignore-scripts
npm run typecheck
npm test
npm run build
npm pack --pack-destination artifacts
```

构建工具需要 Node 22.18+ 或 24+。DSH 同版本 peer packages 由宿主提供。当前本机也可运行 `node scripts/prepare-local.mjs`，只将已有开发工具链接到本插件；用于交付的锁文件不包含本机绝对路径。

`npm run preview` 启动官方 DSH 运行库的隔离 profile，默认端口 19405。测试供应商「本地验收 · 模拟模型」只验证业务与宿主集成，不会调用真实 API，也不会被打入发行包。退出脚本会结束它启动的宿主。原生隔离验收脚本与截图在验收记录中列出。

测试覆盖分镜编译、帧预算、编辑与撤销、源码复制与恢复、重启、实际图片加载、浏览器关键帧/逆序/冷重载、FFmpeg 编码、MP4 Range 播放与取消。离线模拟、真实媒体导出、原生界面和真实模型结果分别记录。

许可与来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
