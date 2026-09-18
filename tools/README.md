# tools/ —— PM 用的真实浏览器验收工具

这些脚本用 Node 内置能力 + 本机 Chrome（CDP，无需额外依赖）在真实浏览器里驱动页面并读取真实 DOM/Canvas 状态。
**每次改动 `src/components/ParticleCanvas.tsx` 等渲染代码后，都必须跑一遍，而不是只看 lint/test/build。**

前置：另开一个终端跑 `npm run dev -- --port 5180 --strictPort --host 127.0.0.1`（localhost 才算安全上下文）。

| 脚本 | 作用 | 命令 |
| --- | --- | --- |
| `probe.mjs` | 全流程冒烟：落地页→开启星光→四样式切换→空格/R→鼠标入口→异常与控制台 | `node tools/probe.mjs http://127.0.0.1:5180/` |
| `where.mjs` | **形状是否成形**：点亮像素的 12×12 能量分布图 + 包围盒 + 中心区质量占比 | `node tools/where.mjs http://127.0.0.1:5180/` |
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

## 已知环境细节

- `--headless=new` 下 rAF 不受 vsync 限制，会跑到 200~300fps，属正常；不要把它误判成性能问题。
- `index.css` 与 `src/components/particleShapes.ts` 的 canvas 字体栈必须**逐项一致**，否则粒子字形与页面文字会不同源。
- 字体已自托管（`src/assets/fonts/`：Manrope 可变 + DM Mono 400，约 40KB），中文走系统字体栈；
  页面不依赖任何外网请求，可用 `node tools/networkCheck.mjs <url>` 复核（判据：外网请求数必须为 0）。
- 断言"元素存在/类名切换"只能证明接线正确，**不能证明画面正确**，必须结合 `where.mjs` 的能量图与截图。
