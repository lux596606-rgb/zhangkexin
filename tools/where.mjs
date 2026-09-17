/**
 * 像素落点分析：点亮像素到底在哪 -> 判断"散成噪点"还是"聚成形状但太小/太暗"。
 * 运行：node tools/where.mjs <url>
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

process.env.CDP_PORT = '9225'
const { CdpSession, clickSelector, evaluate, pressKey, waitFor, waitForPageTarget } = await import('./cdp.mjs')

const URL_UNDER_TEST = process.argv[2] || 'http://127.0.0.1:5180/'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const USER_DATA_DIR = `${process.env.TEMP}\\dsh-birthday-where`
const ARTIFACT_DIR = `${process.cwd()}\\tmp-artifacts`

/** 12x12 网格点亮占比 + 包围盒 + 中心区质量占比。 */
const GRID = `(() => {
  const canvas = document.querySelector('.particle-canvas');
  const { width, height } = canvas;
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, width, height).data;
  const N = 12;
  const grid = Array.from({ length: N }, () => new Array(N).fill(0));
  let lit = 0, sumX = 0, sumY = 0, minX = width, minY = height, maxX = -1, maxY = -1;
  let alphaSum = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const a = data[(y * width + x) * 4 + 3];
      if (a <= 24) continue;
      lit += 1; sumX += x; sumY += y; alphaSum += a;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      grid[Math.min(N - 1, Math.floor((y / height) * N))][Math.min(N - 1, Math.floor((x / width) * N))] += 1;
    }
  }
  const total = width * height;
  const centerMass = (() => {
    let inner = 0;
    const lo = Math.floor(N * 0.3), hi = Math.ceil(N * 0.7);
    for (let r = lo; r < hi; r += 1) for (let c = lo; c < hi; c += 1) inner += grid[r][c];
    return lit ? Math.round((inner / lit) * 1000) / 10 : 0;
  })();
  // 每格点亮率（%），用字符密度直观展示能量分布
  const art = grid.map((row) => row.map((cell) => {
    const ratio = (cell / (total / (N * N))) * 100;
    return ratio > 60 ? '#' : ratio > 35 ? '+' : ratio > 15 ? '-' : ratio > 3 ? '.' : ' ';
  }).join(''));
  return {
    canvas: { width, height }, lit, coverage: Math.round((lit / total) * 10000) / 100,
    bbox: lit ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null,
    centroid: lit ? { x: Math.round(sumX / lit), y: Math.round(sumY / lit) } : null,
    meanAlpha: lit ? Math.round((alphaSum / lit) * 10) / 10 : 0,
    centerMassPercent: centerMass,
    art,
  };
})()`

rmSync(USER_DATA_DIR, { recursive: true, force: true })
mkdirSync(ARTIFACT_DIR, { recursive: true })

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9225', `--user-data-dir=${USER_DATA_DIR}`,
  '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--window-size=1440,900', '--enable-unsafe-swiftshader', 'about:blank',
], { stdio: 'ignore' })

let session = null
try {
  const target = await waitForPageTarget()
  session = await CdpSession.connect(target.webSocketDebuggerUrl)
  await session.send('Runtime.enable')
  await session.send('Page.enable')
  await session.send('Page.navigate', { url: URL_UNDER_TEST })
  await waitFor(session, 'document.readyState === "complete"', { label: '加载' })
  await delay(1200)
  await clickSelector(session, '.primary-button')
  await waitFor(session, 'Boolean(document.querySelector(".stage"))', { label: '进入体验页' })
  await delay(2500)

  for (const [label, key] of [['银河', null], ['生日快乐', '2'], ['猪头卡通', '3'], ['祝福收束', '4']]) {
    if (key) await pressKey(session, key)
    await delay(3200)
    const stats = await evaluate(session, GRID)
    console.log(`\n########## ${label} ##########`)
    console.log(`lit=${stats.lit} (${stats.coverage}%)  meanAlpha=${stats.meanAlpha}  中心区质量占比=${stats.centerMassPercent}%`)
    console.log(`bbox=${JSON.stringify(stats.bbox)} centroid=${JSON.stringify(stats.centroid)} canvas=${JSON.stringify(stats.canvas)}`)
    console.log(stats.art.join('\n'))
    const { data } = await session.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(`${ARTIFACT_DIR}\\where-${label}.png`, Buffer.from(data, 'base64'))
  }
} catch (error) {
  console.log(`失败: ${error.message}`)
} finally {
  session?.close()
  chrome.kill()
}
