/**
 * 运行时取证 v2：临时给两个模块追加 window 暴露，跑完诊断后按哈希还原源文件。
 * 运行：node tools/diag.mjs <url>
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

process.env.CDP_PORT = '9224'
const { CdpSession, clickSelector, evaluate, pressKey, waitFor, waitForPageTarget } = await import('./cdp.mjs')

const URL_UNDER_TEST = process.argv[2] || 'http://127.0.0.1:5180/'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const USER_DATA_DIR = `${process.env.TEMP}\\dsh-birthday-diag`
const ARTIFACT_DIR = `${process.cwd()}\\tmp-artifacts`

const SHAPES = `${process.cwd()}\\src\\components\\particleShapes.ts`
const TRANSITION = `${process.cwd()}\\src\\components\\particleTransition.ts`
const QUALITY = `${process.cwd()}\\src\\components\\particleQuality.ts`

const hash = (text) => createHash('sha256').update(text).digest('hex')
const backups = new Map()

const instrument = (path, code) => {
  const original = readFileSync(path, 'utf8')
  backups.set(path, { original, digest: hash(original) })
  writeFileSync(path, `${original}\n${code}\n`)
}

instrument(SHAPES, `;(window as any).__shapes = { buildShapePoints, resample, samplePig, sampleText, pigRegionAt }`)
instrument(TRANSITION, `;(window as any).__transition = { ParticleTransition, scrambleTargetOrder, dispersionOffset, hashUnit, delayDuration }`)
instrument(QUALITY, `;(window as any).__quality = { QualityController, FrameStats, baseParticleBudget, particleCountForTier, devicePixelRatioForTier }`)

const CLUSTER_STATS = `(() => {
  const canvas = document.querySelector('.particle-canvas');
  const { width, height } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) mask[i] = data[i * 4 + 3] > 24 ? 1 : 0;
  const seen = new Uint8Array(width * height);
  const sizes = [];
  const stack = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    let size = 0; stack.length = 0; stack.push(start); seen[start] = 1;
    while (stack.length) {
      const index = stack.pop(); size += 1;
      const x = index % width, y = (index - x) / width;
      if (x > 0 && mask[index - 1] && !seen[index - 1]) { seen[index - 1] = 1; stack.push(index - 1); }
      if (x < width - 1 && mask[index + 1] && !seen[index + 1]) { seen[index + 1] = 1; stack.push(index + 1); }
      if (y > 0 && mask[index - width] && !seen[index - width]) { seen[index - width] = 1; stack.push(index - width); }
      if (y < height - 1 && mask[index + width] && !seen[index + width]) { seen[index + width] = 1; stack.push(index + width); }
    }
    sizes.push(size);
  }
  sizes.sort((a, b) => b - a);
  const lit = sizes.reduce((sum, value) => sum + value, 0);
  return { width, height, lit, clusters: sizes.length, largest: sizes[0] ?? 0, top5: sizes.slice(0, 5), largestShare: lit ? Math.round((sizes[0] / lit) * 1000) / 10 : 0 };
})()`

const MODULE_PROBE = `(async () => {
  const shapes = window.__shapes, transition = window.__transition, quality = window.__quality;
  if (!shapes) return { loaded: false };
  const canvas = document.querySelector('.particle-canvas');
  const rect = canvas.parentElement.getBoundingClientRect();
  const width = Math.round(rect.width), height = Math.round(rect.height);
  // 真实加载参考图，避免用 null 走 fallback 分支得出错误结论
  const pigImage = await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = new URL('../assets/pink-pig-reference.png', import.meta.url).href;
  }).catch(() => null);
  const budget = quality.baseParticleBudget(width, height, false);
  const count = quality.particleCountForTier(budget, 'high', false);
  const out = { canvas: { width, height }, budget, count, pigImageLoaded: Boolean(pigImage), shapes: {} };
  for (const mode of ['birthday', 'pig', 'closing']) {
    const points = shapes.buildShapePoints(mode, width, height, pigImage);
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const p of points) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
    const resampled = shapes.resample(points, count);
    // 估算"如果粒子真的落在目标上"的理论覆盖率，与实际像素覆盖率对比
    const radius = 1.5;
    const theoretical = (resampled.length * Math.PI * radius * radius) / (width * height);
    out.shapes[mode] = {
      raw: points.length, resampled: resampled.length,
      bbox: points.length ? { x: Math.round(minX), y: Math.round(minY), w: Math.round(maxX - minX), h: Math.round(maxY - minY) } : null,
      theoreticalCoverage: Math.round(theoretical * 10000) / 100,
      first3: resampled.slice(0, 3).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })),
      last3: resampled.slice(-3).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })),
    };
  }
  if (transition) {
    const t = new transition.ParticleTransition();
    out.transition = [0, 0.2, 0.4, 0.46, 0.6, 0.8, 1.0, 1.2, 1.45, 1.6, 3.0].map((step) => {
      t.restart(); t.advance(step);
      return { t: step, disp: Math.round(t.dispersionBlend * 1000) / 1000, w1: Math.round(t.gatherWeight(1) * 1000) / 1000, w500: Math.round(t.gatherWeight(500) * 1000) / 1000, running: t.isRunning };
    });
  }
  return out;
})()`

rmSync(USER_DATA_DIR, { recursive: true, force: true })
mkdirSync(ARTIFACT_DIR, { recursive: true })

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9224', `--user-data-dir=${USER_DATA_DIR}`,
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
  await waitFor(session, 'Boolean(window.__shapes)', { label: '模块暴露生效', timeoutMs: 20000 })
  await delay(1500)
  await clickSelector(session, '.primary-button')
  await waitFor(session, 'Boolean(document.querySelector(".stage"))', { label: '进入体验页' })
  await delay(2500)

  console.log('=== 银河态 ===')
  console.log(JSON.stringify(await evaluate(session, CLUSTER_STATS)))

  for (const [label, key] of [['生日快乐', '2'], ['猪头卡通', '3'], ['祝福收束', '4']]) {
    await pressKey(session, key)
    await delay(3200)
    console.log(`\n=== ${label} ===`)
    console.log(JSON.stringify(await evaluate(session, CLUSTER_STATS)))
    const { data } = await session.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(`${ARTIFACT_DIR}\\diag-${label}.png`, Buffer.from(data, 'base64'))
  }

  console.log('\n=== 模块取证 ===')
  console.log(JSON.stringify(await evaluate(session, MODULE_PROBE), null, 2))
} catch (error) {
  console.log(`诊断失败: ${error.message}`)
} finally {
  session?.close()
  chrome.kill()
  // 无论成败都还原源文件，并用哈希确认字节完全一致
  for (const [path, { original, digest }] of backups) {
    writeFileSync(path, original)
    const restored = hash(readFileSync(path, 'utf8'))
    console.log(`还原 ${path.split('\\').pop()} : ${restored === digest ? 'OK (哈希一致)' : '失败！哈希不一致'}`)
  }
}
