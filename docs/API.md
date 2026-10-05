# DSH 视频工作台：数据与场景接口

本文描述首版插件的稳定业务语义。类型入口为 `src/shared/types.ts`，业务函数入口为 `src/core/index.ts`。第三方图引擎的节点和连线对象不写入项目文件。

## 项目文件与编辑真源

`VideoProject.schemaVersion` 为 `1`。项目保存标题、主题、目标时长、输出规格、资产、镜头、镜头顺序、画布布局、输出记录和扩展数据。

- `shots` 保存镜头内容，镜头 ID 在参数编辑、AI 修改和顺序调整后保持稳定。
- `shotOrder` 是播放顺序的真源；镜头从其顺序累加整数帧区间。画布横纵坐标不影响时间和播放顺序。
- `graph.positions`、`graph.groups` 只保存画布布局。位置使用画布坐标，图片构图参数使用画面百分比，两者互不混用。
- `assetIds` 是生产资产绑定；`referenceIds` 是设计参考。图片未绑定到镜头时不会自动出现在画面里。
- `params` 保存可即时编辑的文案、颜色、图片位置/缩放、字号和运动方式。生成源码须读取这些参数。
- `sourcePath` 是项目内源码目录，默认 `shots/<shot-id>`。一个镜头的文件为 `index.html`、`style.css`、`scene.js` 和便于搬运的 `source.json`。独立源码文件可继续编辑。
- 复制镜头时 `extensions.sourceCopies[newShotId]` 记录原源码目录，宿主将当前已编辑代码复制到新目录。新镜头不与原镜头共享源码文件。
- `targetDuration` 是初始规划目标。实际片长由镜头帧数求和得到；手动增删镜头不会机械缩放其余镜头来凑目标时长。
- `revision` 表达内容版本。导出使用启动任务时的一份项目和源码快照，输出记录注明对应版本。

默认新项目为 1920 × 1080、30/1 FPS、30 秒目标、无声，初始三个各 300 帧的手动镜头，无资产。

## 连线与断链草稿

主链连线保存为可选 `extensions.graphEdges`：

```json
[
  {"from": "shot-a", "to": "shot-b"},
  {"from": "shot-b", "to": "film-output"}
]
```

`from` 是镜头 ID，`to` 是下一镜头 ID 或固定输出节点 `film-output`。图没有独立开始节点；唯一零入度镜头是起点。末镜头必须连接输出节点。生产主链恰好经过每个镜头一次，拒绝循环、分叉、合流、重复线、未知节点、遗漏镜头和断链。

没有 `graphEdges` 字段时，按 `shotOrder` 理解为完整隐含主链。显式空数组代表用户断开全部连线，不能恢复成隐含主链。`reorderFromGraph` 保留原始连线，最多遍历实际能走通的部分，不凭空补线或补镜头。

未完成的图可以保存。`validateProject` 对图缺口返回警告；`validateGraph` 和 `compileSpec` 在制作前要求主链完整。这样，保存画布草案不会受到“还没有完整影片”的限制，预览和导出也不会悄悄遗漏镜头。

## 核心函数

所有项目编辑函数返回新对象，保留调用者的原对象，实际编辑使 revision 加一。已经绑定的同一资产再次绑定不改变版本。

| 函数 | 输入与结果 |
|---|---|
| `createProject(title, topic?)` | 新建默认 `VideoProject` |
| `defaultShot(index?, fps?)` | 新建具有独立 ID 的十秒镜头；时长四舍五入为整数帧 |
| `validateProject(project)` | `{ok, errors, warnings}`；检查项目数据、参数、资产引用和路径；允许图草稿 |
| `validateGraph(project)` | `{ok, errors, warnings}`；检查完整生产主链 |
| `compileSpec(project)` | 返回 `VideoSpec`；遇到无效项目或断链抛出带具体原因的错误 |
| `specMarkdown(spec)` | 输出中文可读制作要求，含镜头、帧区间、素材、参数和验收要求 |
| `normalizeSceneDurations(shots, targetFrames)` | 根据原时长权重分配精确整数帧预算，每镜头至少一帧；总和严格等于 targetFrames |
| `reorderShots(project, ids)` | 显式重排，必须包含全部镜头且每镜头出现一次 |
| `reorderFromGraph(project, edges)` | 保存连线并求可遍历顺序；无效图保留为草稿 |
| `addShot(project, shot?, afterId?)` | 插入镜头，默认追加至最后 |
| `duplicateShot(project, id)` | 复制镜头数据，分配新镜头 ID 与源码目录，放在原镜头之后；宿主负责复制对应源码文件 |
| `deleteShot(project, id)` | 删除镜头及对应布局，衔接剩余顺序链；原素材仍保留 |
| `updateShot(project, id, patch)` | 更新字段，不能改变镜头 ID；共享参数在 `params` 中提交 |
| `addAsset(project, asset)` | 添加图片或文字资产；素材导入和本地文件写入由宿主完成 |
| `bindAsset` / `unbindAsset` | `(project, shotId, assetId, kind?)`，kind 为 `asset` 或 `reference`，默认生产资产 |
| `deleteAsset(project, assetId)` | 删除资产与布局，并移除所有镜头中的生产/参考绑定 |

`UndoHistory<T>` 保存独立快照：`current`、`canUndo`、`canRedo` getter，以及 `push(value)`、`undo()`、`redo()`、`reset(value)`。新的编辑清除 redo 分支，默认最多保存 50 个快照。此工具处理内存中的编辑历史；宿主的源码备份与恢复是另一层文件操作。

## 镜头要求编译

每个镜头的帧区间为 `[startFrame, endFrame)`；首镜头从 0 开始，最后镜头结束于 `durationFrames`。第零帧对应 0 秒，时间为 `frame × fps.den / fps.num`。编译结果按主链排序并解析生产资产，画布位置不会改变编译结果。

`specMarkdown` 描述主题、输出规格、片长，每镜头的意图、构图、动作、转场、文案、生产/参考资产与参数。这是模型和人的制作接口；它不会把尚未生成的源码或尚未执行的媒体检查写成已经成功的影片。

## 场景源码接口

场景使用 HTML、CSS 和 ES 模块 JavaScript，支持 DOM 和 Canvas2D。HTML 是镜头根节点内的静态初始内容；CSS 使用镜头局部 class；JS 导出 `render`，可选导出异步 `ready`。

模型在修改镜头时可返回可选 `shotPatch`，更新标题、意图、构图、动作、正整数帧时长、绑定、转场和参数。参数 patch 合并到现有参数；镜头 ID 和源码目录不由模型改写。初始分镜按目标时长使用最大余数法分配整数帧，防止逐镜头四舍五入后全片超时。

```js
export async function ready(ctx) {
  // 图片与字体由宿主准备。这里可以验证镜头所需的 DOM 或轻量资源。
}

export function render(ctx) {
  const heading = ctx.root.querySelector('.heading');
  heading.textContent = ctx.params.text;
  heading.style.opacity = String(ctx.helpers.easeOutCubic(Math.min(1, ctx.time / 0.4)));
  ctx.ctx2d.fillStyle = ctx.params.background;
  ctx.ctx2d.fillRect(0, 0, ctx.width, ctx.height);
}
```

| ctx 字段 | 含义 |
|---|---|
| `root` | 覆盖画布的本镜头 DOM 根节点 |
| `canvas`, `ctx2d` | 目标尺寸画布及其 Canvas2D context |
| `params` | 当前镜头共享参数；文字与颜色应从这里读取 |
| `assets` | 本镜头可用资产；图片具有 `url` 和预解码的 `image`，文字资产具有 `text` |
| `frame`, `localFrame` | 全片整数帧和镜头局部整数帧，均从 0 开始 |
| `progress` | `localFrame / max(durationFrames - 1, 1)`，范围 0–1 |
| `time`, `duration` | 当前镜头局部秒数、镜头时长秒数 |
| `width`, `height` | 完整目标画面尺寸，与预览显示缩放无关 |
| `seed` | 根据镜头 ID 得到的稳定种子 |
| `helpers` | `clamp`、`lerp`、`smoothstep`、`easeOutCubic`、`easeInOutCubic`、按 key 稳定的 `random` |

共享参数中 `imageX`、`imageY` 是画面百分比，例如 `74` 表示画面宽度的 74%；`imageScale` 是正比例缩放，`fontSize` 是目标画面字号参数。`imageFit` 为 `cover`/`contain`，`motion` 为 `fade`/`slide`/`zoom`/`none`。

`render` 必须每次按给定帧完整求值。重复、逆序与跨镜头 seek 应成立。不要通过 `Date.now()`、`Math.random()`、独立计时器或自动播放动画累积状态。DOM 初始状态可被宿主重建，`ready` 应轻量且可重复；不要假定上一次帧调用已经执行。

镜头必须读取共享参数，而不是把全部文字、图片位置和颜色写死。模型仍可创建新的布局和动作；参数契约保障已暴露属性能够即时编辑。任意源码不能可靠地反向还原为节点图或可视对象，源码修改后也不自动反推镜头语义。

首版不要求场景安装依赖、加载外网或读取本地任意文件。第三方 runtime 能力需要由插件实现并明示，不能在生成的源码里自动安装。

## 验证范围

核心单元测试检查：主链帧区间、分数 FPS、精确整数帧预算、资产删除清理、镜头增删复制、断链/分叉/循环拒绝、无效引用/路径、undo/redo，以及执行默认源码时文案/图片绘制与重复取帧。这些测试证明核心逻辑和受控场景逻辑；浏览器真实布局、生成模型质量、DSH 原生接入和最终媒体输出由对应的运行与回读测试证明。
