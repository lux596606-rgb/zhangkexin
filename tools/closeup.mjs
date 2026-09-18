/**
 * 动作 4 放大取证：切换样式后，把舞台裁剪放大 3 倍截图，并读取该样式的粒子几何指标。
 * 运行：node tools/closeup.mjs <url> [modeKey...]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

process.env.CDP_PORT = '9227'
const { CdpSession, clickSelector, evaluate, pressKey, waitFor, waitForPageTarget } = await import('./cdp.mjs')

const URL_UNDER_TEST = process.argv[2] || 'http://127.0.0.1:5180/'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const USER_DATA_DIR = `${process.env.TEMP}\\dsh-birthday-closeup`
const ARTIFACT_DIR = `${process.cwd()}\\tmp-artifacts`

/** 舞台内 canvas 的点阵几何：包围盒、覆盖率、空隙、以及"笔画是否糊在一起"。 */
const GEOMETRY = `(() => {
  const canvas = document.querySelector('.particle-canvas');
  const { width, height } = canvas;
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, width, height).data;
  const lit = new Uint8Array(width * height);
  let count = 0, sumX = 0, sumY = 0, minX = width, minY = height, maxX = -1, maxY = -1, alphaSum = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const a = data[(y * width + x) * 4 + 3];
      if (a <= 40) continue;
      lit[y * width + x] = 1;
      count += 1; sumX += x; sumY += y; alphaSum += a;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  // 水平/垂直游程：连续点亮像素的长度分布 -> 反映笔画粗细（糊在一起会变长）
  const runs = [];
  for (let y = 0; y < height; y += 1) {
    let run = 0;
    for (let x = 0; x < width; x += 1) {
      if (lit[y * width + x]) run += 1;
      else { if (run > 0) runs.push(run); run = 0; }
    }
    if (run > 0) runs.push(run);
  }
  runs.sort((a, b) => a - b);
  const pick = (p) => runs.length ? runs[Math.min(runs.length - 1, Math.floor(runs.length * p))] : 0;
  // 前景连通块数量：糊成一团时块数很少、块面积很大
  const seen = new Uint8Array(width * height);
  const stack = [];
  const blobs = [];
  for (let i = 0; i < lit.length; i += 1) {
    if (!lit[i] || seen[i]) continue;
    let size = 0;
    stack.push(i); seen[i] = 1;
    let bMinX = width, bMaxX = -1, bMinY = height, bMaxY = -1;
    while (stack.length) {
      const cell = stack.pop();
      const cx = cell % width, cy = (cell - cx) / width;
      size += 1;
      if (cx < bMinX) bMinX = cx; if (cx > bMaxX) bMaxX = cx;
      if (cy < bMinY) bMinY = cy; if (cy > bMaxY) bMaxY = cy;
      if (cx > 0 && lit[cell - 1] && !seen[cell - 1]) { seen[cell - 1] = 1; stack.push(cell - 1); }
      if (cx < width - 1 && lit[cell + 1] && !seen[cell + 1]) { seen[cell + 1] = 1; stack.push(cell + 1); }
      if (cy > 0 && lit[cell - width] && !seen[cell - width]) { seen[cell - width] = 1; stack.push(cell - width); }
      if (cy < height - 1 && lit[cell + width] && !seen[cell + width]) { seen[cell + width] = 1; stack.push(cell + width); }
    }
    blobs.push({ size, w: bMaxX - bMinX + 1, h: bMaxY - bMinY + 1 });
  }
  blobs.sort((a, b) => b.size - a.size);
  return {
    canvas: { width, height },
    litCount: count,
    coverage: Math.round((count / (width * height)) * 10000) / 100,
    meanAlpha: count ? Math.round((alphaSum / count) * 10) / 10 : 0,
    bbox: count ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null,
    bboxFill: count ? Math.round(((maxX - minX + 1) * (maxY - minY + 1)) / (width * height) * 1000) / 10 : 0,
    runMedian: pick(0.5), runP90: pick(0.9), runMax: runs.length ? runs[runs.length - 1] : 0,
    blobCount: blobs.length,
    biggestBlob: blobs[0] ? Math.round((blobs[0].size / count) * 1000) / 10 : 0,
    topBlobs: blobs.slice(0, 8).map((b) => b.size),
    sampledPoints: canvas.dataset.sampledPoints || null,
    particleCount: canvas.dataset.particleCount || null,
    pixelRatio: canvas.dataset.pixelRatio || null,
  };
})()`

rmSync(USER_DATA_DIR, { recursive: true, force: true })
mkdirSync(ARTIFACT_DIR, { recursive: true })

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9227', `--user-data-dir=${USER_DATA_DIR}`,
  '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--window-size=1440,900', '--enable-unsafe-swiftshader', 'about:blank',
], { stdio: 'ignore' })

const targets = process.argv.slice(3)
const plan = targets.length ? targets.map((key) => [key, key]) : [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']]

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

  for (const [key, label] of plan) {
    await pressKey(session, key)
    await delay(3600)
    const stats = await evaluate(session, GEOMETRY)
    console.log(`\n########## ${label} ##########`)
    console.log(JSON.stringify(stats, null, 0))
    const box = await evaluate(
      session,
      `(() => { const el = document.querySelector('.stage'); const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), scale: 1 }; })()`,
    )
    const { data } = await session.send('Page.captureScreenshot', {
      format: 'png',
      clip: { ...box, scale: 3 },
    })
    writeFileSync(`${ARTIFACT_DIR}\\closeup-${label}.png`, Buffer.from(data, 'base64'))
    // 1:1 原尺寸：这才是使用者真正看到的画面，判断"能不能读懂"必须看它而不是放大图。
    const { data: actual } = await session.send('Page.captureScreenshot', {
      format: 'png',
      clip: { ...box, scale: 1 },
    })
    writeFileSync(`${ARTIFACT_DIR}\\actual-${label}.png`, Buffer.from(actual, 'base64'))
  }
} catch (error) {
  console.log(`失败: ${error.message}`)
} finally {
  session?.close()
  chrome.kill()
}
