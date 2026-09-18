/**
 * 采样几何取证：直接 import 真实的 particleShapes 模块，读取字号、步长、采样点数，
 * 离线用同样的算法算出"每个字分到多少粒子"，用来定量判断字形是"点阵够密"还是"在循环复用"。
 * 运行：node tools/sampleAudit.mjs <url>
 */
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

process.env.CDP_PORT = '9233'
const { CdpSession, clickSelector, evaluate, waitFor, waitForPageTarget } = await import('./cdp.mjs')

const URL_UNDER_TEST = process.argv[2] || 'http://127.0.0.1:5180/'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const USER_DATA_DIR = `${process.env.TEMP}\\dsh-birthday-sampleaudit`

const AUDIT = `(async () => {
  const shapes = await import('/src/components/particleShapes.ts');
  const stage = document.querySelector('.stage');
  const canvas = document.querySelector('.particle-canvas');
  const rect = stage.getBoundingClientRect();
  const width = rect.width, height = rect.height;
  const out = { stage: { width, height }, modes: {} };

  const measure = (label, lines, sampler) => {
    const points = sampler();
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const p of points) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    const inkW = maxX - minX + 1, inkH = maxY - minY + 1;
    // 步长：由相邻点 x 差的最小公值反推
    const xs = [...new Set(points.map((p) => p.x))].sort((a, b) => a - b);
    let stride = 0;
    for (let i = 1; i < xs.length; i += 1) { const d = xs[i] - xs[i - 1]; if (d > 0) { stride = stride ? Math.min(stride, d) : d; } }
    const totalChars = lines.join('').length;
    out.modes[label] = {
      lines, chars: totalChars, sampledPoints: points.length,
      ink: { w: inkW, h: inkH },
      inkShareOfStage: Math.round((inkW * inkH) / (width * height) * 1000) / 10,
      stride,
      pointsPerChar: Math.round(points.length / totalChars),
      pointsPerParticleAt2475: Math.round((points.length / 2475) * 100) / 100,
    };
  };

  measure('birthday', shapes.BIRTHDAY_LINES, () => shapes.sampleText(shapes.BIRTHDAY_LINES, width, height, shapes.birthdayPalette));
  measure('closing', shapes.CLOSING_LINES, () => shapes.makeClosingPoints(width, height).filter((p) => p.shapeBand === 'text'));

  // 字号反推：画一次已知字号的文字，量出宽度
  const probe = document.createElement('canvas');
  const ctx = probe.getContext('2d');
  ctx.font = '600 100px "Manrope", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif';
  out.charWidthAt100px = shapes.CLOSING_LINES.map((line) => Math.round(ctx.measureText(line).width / line.length));
  out.canvas = { width: canvas.width, height: canvas.height, quality: canvas.dataset.quality, pixelRatio: canvas.dataset.pixelRatio || null };
  out.canvasCss = Math.round(canvas.getBoundingClientRect().width) + 'x' + Math.round(canvas.getBoundingClientRect().height);
  return out;
})()`

rmSync(USER_DATA_DIR, { recursive: true, force: true })

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9233', `--user-data-dir=${USER_DATA_DIR}`,
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
  await delay(900)
  await clickSelector(session, '.primary-button')
  await waitFor(session, 'Boolean(document.querySelector(".stage"))', { label: '进入体验页' })
  await delay(2000)
  console.log(JSON.stringify(await evaluate(session, AUDIT), null, 2))
} catch (error) {
  console.log(`失败: ${error.message}`)
} finally {
  session?.close()
  chrome.kill()
}
