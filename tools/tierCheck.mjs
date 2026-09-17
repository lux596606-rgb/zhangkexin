/**
 * 低档画质下的形状可辨识度：强制 medium/low 档，截图并统计形状指标。
 * 这是自适应降档的真实边界条件——没人验证过猪头在低档是否还能认出来。
 * 运行：node tools/tierCheck.mjs <url>
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

process.env.CDP_PORT = '9227'
const { CdpSession, clickSelector, evaluate, pressKey, waitFor, waitForPageTarget } = await import('./cdp.mjs')

const URL_UNDER_TEST = process.argv[2] || 'http://127.0.0.1:5180/'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const USER_DATA_DIR = `${process.env.TEMP}\\dsh-birthday-tier`
const ARTIFACT_DIR = `${process.cwd()}\\tmp-artifacts`

/** 降低 CPU 能力使自适应逻辑自己降档，这才是真实路径（而不是直接改 DOM）。 */
const CPU_THROTTLE_RATES = [1, 6, 14]

const STATS = `(() => {
  const canvas = document.querySelector('.particle-canvas');
  const { width, height } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  let lit = 0, minX = width, minY = height, maxX = -1, maxY = -1, sum = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const a = data[(y * width + x) * 4 + 3];
      if (a <= 24) continue;
      lit += 1; sum += a;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const label = document.querySelector('.stage-quality');
  return {
    tier: canvas.dataset.quality ?? null,
    label: label ? label.textContent.trim() : null,
    bbox: lit ? { w: maxX - minX, h: maxY - minY } : null,
    lit,
    coverage: Math.round((lit / (width * height)) * 10000) / 100,
    meanAlpha: lit ? Math.round((sum / lit) * 10) / 10 : 0,
    stage: document.querySelector('.stage')?.className,
  };
})()`

/** 通过 Vite 模块图直接读取真实预算函数，算出各档位下的粒子数。 */
const BUDGET = `(async () => {
  const q = await import('/src/components/particleQuality.ts');
  const canvas = document.querySelector('.particle-canvas');
  const base = q.baseParticleBudget(canvas.clientWidth, canvas.clientHeight, false);
  const out = { canvas: [canvas.clientWidth, canvas.clientHeight], base, tiers: {} };
  for (const tier of ['high', 'medium', 'low']) {
    out.tiers[tier] = {
      shape: q.particleCountForTier(base, tier, false, q.SHAPE_PARTICLE_SCALE),
      galaxy: q.particleCountForTier(base, tier, false, 1),
    };
  }
  return out;
})()`

rmSync(USER_DATA_DIR, { recursive: true, force: true })
mkdirSync(ARTIFACT_DIR, { recursive: true })

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9227', `--user-data-dir=${USER_DATA_DIR}`,
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
  await delay(2000)

  console.log('=== 各档位实际粒子预算 ===')
  console.log(JSON.stringify(await evaluate(session, BUDGET)))

  for (const rate of CPU_THROTTLE_RATES) {
    await session.send('Emulation.setCPUThrottlingRate', { rate })
    await pressKey(session, '3')
    // 给自适应逻辑足够时间降档（晚降 0.9s 确认 + 3s 最短驻留 + 2.4s 升档确认）
    await delay(12000)
    const stats = await evaluate(session, STATS)
    console.log(`\n=== CPU 节流 ×${rate} ===`)
    console.log(` 档位=${stats.tier} (${stats.label})  样式=${stats.stage}`)
    console.log(` 包围盒=${JSON.stringify(stats.bbox)} 点亮=${stats.lit} (${stats.coverage}%) 平均不透明度=${stats.meanAlpha}`)
    const { data } = await session.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(`${ARTIFACT_DIR}\\tier-${rate}x.png`, Buffer.from(data, 'base64'))
  }
} catch (error) {
  console.log(`失败: ${error.message}`)
} finally {
  session?.close()
  chrome.kill()
}
