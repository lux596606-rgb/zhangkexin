/**
 * 形状成形诊断：直接读 canvas 像素，判断粒子是"聚成形状"还是"散成噪点"。
 * 运行：node tools/shapeAudit.mjs <url>
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

// 必须在导入 cdp.mjs 之前设置：端口在模块加载时读取。
process.env.CDP_PORT = '9223'
const { CdpSession, clickSelector, evaluate, pressKey, waitFor, waitForPageTarget } = await import('./cdp.mjs')

const URL_UNDER_TEST = process.argv[2] || 'http://127.0.0.1:5180/'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const USER_DATA_DIR = `${process.env.TEMP}\\dsh-birthday-shape`
const ARTIFACT_DIR = `${process.cwd()}\\tmp-artifacts`

/** 点亮像素的包围盒 + 覆盖率 + 六宫格分布：散点与成形在统计上完全不同。 */
const SHAPE_STATS = `(() => {
  const canvas = document.querySelector('.particle-canvas');
  if (!canvas) return { found: false };
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1, lit = 0, sumX = 0, sumY = 0;
  const cells = new Array(6).fill(0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const a = data[(y * width + x) * 4 + 3];
      if (a <= 24) continue;
      lit += 1; sumX += x; sumY += y;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      const col = x < width / 3 ? 0 : x < (width * 2) / 3 ? 1 : 2;
      const row = y < height / 2 ? 0 : 1;
      cells[row * 3 + col] += 1;
    }
  }
  const total = width * height;
  if (lit === 0) return { found: true, lit: 0, width, height };
  return {
    found: true, width, height, lit,
    coverage: Math.round((lit / total) * 10000) / 100,
    bbox: { w: Math.round(((maxX - minX) / width) * 100), h: Math.round(((maxY - minY) / height) * 100), x: Math.round((minX / width) * 100), y: Math.round((minY / height) * 100) },
    centroid: { x: Math.round((sumX / lit / width) * 100), y: Math.round((sumY / lit / height) * 100) },
    cells: cells.map((c) => Math.round((c / lit) * 100)),
  };
})()`

const QUALITY = `(() => ({ q: document.querySelector('.particle-canvas')?.dataset?.quality, label: document.querySelector('.stage-quality')?.textContent, stage: document.querySelector('.stage')?.className }))()`

rmSync(USER_DATA_DIR, { recursive: true, force: true })
mkdirSync(ARTIFACT_DIR, { recursive: true })

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9223', `--user-data-dir=${USER_DATA_DIR}`,
  '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--window-size=1440,900', '--enable-unsafe-swiftshader', 'about:blank',
], { stdio: 'ignore' })

process.env.CDP_PORT = '9223'
const session = await (async () => {
  const target = await waitForPageTarget()
  const s = await CdpSession.connect(target.webSocketDebuggerUrl)
  await s.send('Runtime.enable')
  await s.send('Page.enable')
  return s
})()

try {
  await session.send('Page.navigate', { url: URL_UNDER_TEST })
  await waitFor(session, 'document.readyState === "complete"', { label: '加载' })
  await delay(1000)
  await clickSelector(session, '.primary-button')
  await waitFor(session, 'Boolean(document.querySelector(".stage"))', { label: '进入体验页' })
  await delay(3000)

  // 采样窗口长度：形状成形需要时间，且通过时应当逐帧查看，而不是只看最后一帧。
  for (const [label, keys, waitMs] of [
    ['银河(默认)', [], 3000],
    ['生日快乐', ['2'], 6000],
    ['猪头卡通', ['3'], 6000],
    ['祝福收束', ['4'], 6000],
    ['回到银河', ['1'], 6000],
  ]) {
    for (const key of keys) await pressKey(session, key)
    // 过程中多次采样，观察是否"先散后聚"并且在等待后真的聚到位
    const samples = []
    const step = Math.max(600, Math.round(waitMs / 5))
    for (let index = 0; index < 5; index += 1) {
      await delay(step)
      const stats = await evaluate(session, SHAPE_STATS)
      samples.push(`t+${((index + 1) * step) / 1000}s cov=${stats.coverage}% bbox=${stats.bbox.w}x${stats.bbox.h}@${stats.bbox.x},${stats.bbox.y} c=${stats.centroid.x},${stats.centroid.y}`)
    }
    const final = await evaluate(session, SHAPE_STATS)
    const quality = await evaluate(session, QUALITY)
    console.log(`\n### ${label} ${quality.label ?? ''}`)
    for (const line of samples) console.log(`  ${line}`)
    console.log(`  最终: ${JSON.stringify(final)}`)
    const { data } = await session.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(`${ARTIFACT_DIR}\\audit-${label}.png`, Buffer.from(data, 'base64'))
  }
} finally {
  session.close()
  chrome.kill()
}
