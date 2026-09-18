# tools/ —— PM 用的真实浏览器验收工具

这些脚本用 Node 内置能力 + 本机 Chrome（CDP，无需额外依赖）在真实浏览器里驱动页面并读取真实 DOM/Canvas 状态。
**每次改动 `src/components/ParticleCanvas.tsx` 等渲染代码后，都必须跑一遍，而不是只看 lint/test/build。**

前置：另开一个终端跑 `npm run dev -- --port 5180 --strictPort --host 127.0.0.1`（localhost 才算安全上下文）。

| 脚本 | 作用 | 命令 |
| --- | --- | --- |
| `probe.mjs` | 全流程冒烟：落地页→开启星光→四样式切换→空格/R→鼠标入口→异常与控制台 | `node tools/probe.mjs http://127.0.0.1:5180/` |
| `where.mjs` | **形状是否成形**：点亮像素的 12×12 能量分布图 + 包围盒 + 中心区质量占比 | `node tools/where.mjs http://127.0.0.1:5180/` |
| `closeup.mjs` | **舞台放大取证**：逐样式截 3 倍放大图 + 1:1 原尺寸图，并读取笔画游程、连通块、采样点/粒子数 | `node tools/closeup.mjs http://127.0.0.1:5180/ 2 4` |
| `fullPage.mjs` | 整页取证（含左栏文案、底部模式入口、摄像头预览）+ canvas 是否铺满舞台 | `node tools/fullPage.mjs http://127.0.0.1:5180/ 4` |
| `layout.mjs` | 布局探针：读关键元素实际盒模型，排查"哪条规则把舞台挤小了" | `node tools/layout.mjs http://127.0.0.1:5180/` |
| `tierTrace.mjs` | 档位/FPS/分辨率随时间的变化，判断"画面变糊"是不是自动降档引起 | `node tools/tierTrace.mjs http://127.0.0.1:5180/ 4` |
| `meteorCheck.mjs` | **流星是否真的渲染**：逐帧读 `dataset.meteors` 并统计高亮像素分布 | `node tools/meteorCheck.mjs http://127.0.0.1:5180/ 1` |
| `sampleAudit.mjs` | **采样几何取证**：import 真实模块，读字号、步长、采样点数、每字点数 | `node tools/sampleAudit.mjs http://127.0.0.1:5180/` |
| `density.mjs` | 离线密度测算：采样点包围盒、点数、文字/猪头所需粒子数、输出 SVG 预览 | `node tools/density.mjs` |
| `converge.mjs` | 逐帧取证：粒子到目标距离、`follow`、过渡 elapsed、渲染循环数量 | `node tools/converge.mjs http://127.0.0.1:5180/` |
| `shapeAudit.mjs` | 形状随时间的覆盖率/包围盒采样 | `node tools/shapeAudit.mjs http://127.0.0.1:5180/` |

截图输出到 `tmp-artifacts/`（已 gitignore）。

## 判据（硬指标）

- **成形**：目标样式的点亮像素包围盒必须明显小于整个画布，且 `where.mjs` 的能量图应出现形状轮廓，而不是均匀铺满的 `.`。
- 参考：`祝福收束` 曾经正确成形时，`bbox≈397×302`、中心区质量占比 `83.8%`、能量图能看出文字块。
- **不成形**时能量图 12×12 全是 `.`（每格点亮率 3%~6%），中心区质量占比仅约 30%（等于均匀分布）。
- `converge.mjs` 里 `follow` 必须 > 0，`tElapsed` 必须持续增长（不能停在 0）；渲染循环数量必须稳定为 1。
- 这些脚本改动了源码时，必须打印「还原 … OK (哈希一致)」，否则说明源文件没被还原干净。

## 文字样式（动作 2 / 动作 4）专用判据

字形是"点阵画出来的"，清晰度由三个量的关系决定，缺一不可：

1. **采样点数 ≥ 粒子数**（`closeup.mjs` 的 `sampledPoints` 与 `particleCount`）。
   采样点少于粒子数时，粒子只能反复复用同一批点，笔画会退化成"串珠"而不是"实线"。
2. **步长要跟着字号走**（`sampleAudit.mjs` 的 `stride`）。步长一旦相对字号偏大，
   采样网格就会被肉眼看见，字形上出现一层"格子布"纹理。
3. **点径要与笔画宽度相匹配**。点径太大会把相邻笔画粘成一块（`blobCount` 骤降、`biggestBlob` 占比升高），
   太小则笔画断成虚线（`runMedian` ≤ 2、`coverage` 偏低）。

判读用的两个指标：
- `runMedian` / `runP90`：水平游程长度分布，反映笔画"实不实"。文字样式在 3~6 之间比较健康。
- `biggestBlob`：最大连通块占全部点亮像素的比例。**超过 ~20% 通常意味着糊成一块**；文字样式宜低于 ~5%。

**1:1 原尺寸图（`actual-<样式>.png`）才是判据**，3 倍放大图只用来看细节——
放大后每个人都会觉得"能认出来"，那不是使用者的真实观感。

**参数试验台**（一次性工具，已删）：把候选的字号/步长/点径/密度画成格子对照，
用来在没有"反复改线上代码"代价的情况下选出档位。本节描述的三个量就是它的坐标系；
需要重新调参时照这个思路再搭一次即可（`public/_preview-*.html` + 一个 CDP 截图脚本）。

## 找"这一层是哪来的"

舞台上有 canvas、星尘、光环、扫光、网格、简笔画等多个图层，肉眼看到一个"框"或一块怪颜色时，
**不要靠猜是哪一层的**。做法是逐个隐藏再截图：`closeup.mjs` 取 `.stage` 的裁剪框，
配合 `Page.addScriptToEvaluateOnNewDocument` 或直接注入一段样式，按下面的顺序各截一张——

1. 全部打开（基线）
2. `.stage-grid` / `.stage-halo` / `.stage-sweep` / `.sketch-decor` 逐个 `visibility: hidden`
3. `.stage::before, .stage::after { display: none }`（伪元素只能用注入样式关）
4. 全部关掉，只剩 canvas

对比第 1 张和第 4 张就能立刻分清"框是 DOM/CSS 画的"还是"canvas 里画的"。
**本项目踩过的坑**：`动画4 文字框突兀` 一开始怀疑是舞台的方形边框，
用这个方法一步步关下去，最后定位到**是 canvas 内部的文字底衬层**——
它在 2 倍放大下是一圈等宽实线，远看就是套在字外面的框。
改成"多层递减的柔光"后才消失。若没有这个流程，很容易去改一堆无辜的 CSS。

## 短命特效（流星）的取证方式

流星只活 1 秒多，**截图和肉眼都容易正好错过**，所以不能靠"截一张图看看有没有"来判断。
做法是让渲染层自己报数：`drawStarMeteors` 每帧把"这一帧画了几颗"写进
`canvas.dataset.meteors`，脚本读这个值来抓帧。

- `meteorCheck.mjs`：逐帧读计数 + 统计高亮像素分布，确认"确实在画"。
- 想肉眼确认时，用同一个计数挑出 `meteors >= 2` 的一帧和 `meteors === 0` 的一帧做 A/B。

**踩过的坑**：一开始用"找细长亮条"的像素判据，结果 0 命中——
画面里本来就有 400 多个亮块（粒子、星光、文字），斜条判据被噪声淹没，
而真正的问题是流量本身**在屏幕上很靠外的地方生成**，进来时已经划过一半。
所以这类特效的判据要用"渲染层自报的计数"，不要用事后从像素里反推的几何形状。

## 已知环境细节

- `--headless=new` 下 rAF 不受 vsync 限制，会跑到 200~300fps，属正常；不要把它误判成性能问题。
- `index.css` 与 `src/components/particleShapes.ts` 的 canvas 字体栈必须**逐项一致**，否则粒子字形与页面文字会不同源。
- 字体已自托管（`src/assets/fonts/`：Manrope 可变 + DM Mono 400，约 40KB），中文走系统字体栈；
  页面不依赖任何外网请求，可用 `node tools/networkCheck.mjs <url>` 复核（判据：外网请求数必须为 0）。
- 断言"元素存在/类名切换"只能证明接线正确，**不能证明画面正确**，必须结合 `where.mjs` 的能量图与截图。
