# 可重复的图交互验收

从插件工程根目录运行，先启动隔离的官方 DSH Web 环境。使用当前启动输出中的完整 URL 设置 `DSH_TEST_URL`；脚本不内置或保存认证 token。

```sh
node scripts/verify-graph.mjs
node scripts/verify-graph-lifecycle.mjs
```

环境变量：

| 变量 | 用途与默认值 |
| --- | --- |
| `DSH_TEST_URL` | 当前隔离 DSH 地址；默认 `http://127.0.0.1:19405/`，有认证时必须设置完整地址。 |
| `DSH_TEST_BROWSER` | Chrome / Chromium 可执行文件；默认 macOS Google Chrome 路径。 |
| `DSH_VIDEO_PROJECTS` | 隔离 host 的项目目录；默认 `.local/projects`，图脚本从这里读取已保存 JSON。 |
| `DSH_TEST_IMAGE` | 可选本地 PNG / JPEG / WebP 图片；未设置时图脚本通过浏览器 canvas 生成 WebP 测试资产。 |

`verify-graph.mjs` 新建独立验收项目，用真实鼠标、滚轮、键盘操作检查 18 个步骤，核验保存的项目 JSON 与底部镜头条，并断言镜头端口与正文间距。`verify-graph-lifecycle.mjs` 使用已有当前项目，独立检查页面卸载的监听、渲染和节点清理及重新进入的唯一画布。先运行图脚本，可以保证存在当前项目。

两份脚本均自行启动并关闭浏览器；报告与截图写入 `artifacts/verification/graph/`。同一隔离 host 只有一个当前项目，验收时应避免其他 UI 任务同时操作该 host。

`graph-listener-probe.mjs` 仅通过 Playwright 注入到测试页面，记录 canvas、画布父元素与 LiteGraph document keyup 的监听。产品代码没有加入测试接口。图脚本读取 LiteGraph 的公共 `canvas.data` 定位端口与检查显示数据，产品变更操作由实际输入事件完成。
