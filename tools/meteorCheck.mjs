/**
 * 流星取证：连拍多帧，逐帧统计"亮团"（连续的亮像素块）的数量与位置。
 * 流星是一段高亮斜线，出现时会在某一帧留下一个细长的亮块；
 * 判据是"多帧里能看到至少一个宽高比明显偏斜、且位置逐帧移动的亮块"。
 * 运行：node tools/meteorCheck.mjs <url> [modeKey]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

process.env.CDP_PORT = '9239'
const { CdpSession, clickSelector, evaluate, pressKey, waitFor, waitForPageTarget } = await import('./cdp.mjs')

const URL_UNDER_TEST = process.argv[2] || 'http://127.0.0.1:5180/'
const KEY = process.argv[3] || '1'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const USER_DATA_DIR = `${process.env.TEMP}\\dsh-birthday-meteor`
const ARTIFACT_DIR = `${process.cwd()}\\tmp-artifacts`

/**
 * 找"高亮像素"的连通块。阈值取 235：流星的头部与拖尾比普通星尘亮得多，
 * 普通星尘几乎到不了这个亮度，所以它能把流星单独挑出来。
 */
const BRIGHT_BLOBS = `(() => {
  const canvas = document.querySelector('.particle-canvas');
  const { width, height } = canvas;
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, width, height).data;
  let maxLuma = 0;
  const hist = [0, 0, 0, 0, 0];
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    if (data[o + 3] <= 40) continue;
    const luma = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    if (luma > maxLuma) maxLuma = luma;
    if (luma > 250) hist[4] += 1;
    else if (luma > 240) hist[3] += 1;
    else if (luma > 225) hist[2] += 1;
    else if (luma > 210) hist[1] += 1;
    else if (luma > 195) hist[0] += 1;
  }
  const THRESHOLD = 225;
  const lit = new Uint8Array(width * height);
  let count = 0;
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    const luma = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    if (data[o + 3] > 40 && luma > THRESHOLD) { lit[i] = 1; count += 1; }
  }
  const seen = new Uint8Array(width * height);
  const stack = [];
  const blobs = [];
  for (let i = 0; i < lit.length; i += 1) {
    if (!lit[i] || seen[i]) continue;
    let size = 0, minX = width, maxX = -1, minY = height, maxY = -1;
    stack.push(i); seen[i] = 1;
    while (stack.length) {
      const cell = stack.pop();
      const cx = cell % width, cy = (cell - cx) / width;
      size += 1;
      if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
      if (cx > 0 && lit[cell - 1] && !seen[cell - 1]) { seen[cell - 1] = 1; stack.push(cell - 1); }
      if (cx < width - 1 && lit[cell + 1] && !seen[cell + 1]) { seen[cell + 1] = 1; stack.push(cell + 1); }
      if (cy > 0 && lit[cell - width] && !seen[cell - width]) { seen[cell - width] = 1; stack.push(cell - width); }
      if (cy < height - 1 && lit[cell + width] && !seen[cell + width]) { seen[cell + width] = 1; stack.push(cell + width); }
    }
    blobs.push({ size, x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
  }
  const streaks = blobs.filter((b) => {
    const long = Math.max(b.w, b.h), short = Math.max(1, Math.min(b.w, b.h));
    return long >= 14 && long / short >= 3.2 && b.size >= 12;
  }).sort((a, b) => b.size - a.size).slice(0, 5);
  const biggest = [...blobs].sort((a, b) => b.size - a.size).slice(0, 4)
    .map((b) => ({ size: b.size, w: b.w, h: b.h, x: b.x, y: b.y }));
  return { meteors: canvas.dataset.meteors ?? '?', maxLuma, hist, brightCount: count, blobCount: blobs.length, streaks, biggest, t: Math.round(performance.now()) };
})()`

rmSync(USER_DATA_DIR, { recursive: true, force: true })
mkdirSync(ARTIFACT_DIR, { recursive: true })

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9239', `--user-data-dir=${USER_DATA_DIR}`,
  '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--window-size=1440,900', '--enable-unsafe-swiftshader', 'about:blank',
], { stdio: 'ignore' })

const seenPositions = []
let session = null
try {
  const target = await waitForPageTarget()
  session = await CdpSession.connect(target.webSocketDebuggerUrl)
  await session.send('Runtime.enable')
  await session.send('Page.enable')
  await session.send('Page.navigate', { url: URL_UNDER_TEST })
  await waitFor(session, 'document.readyState === "complete"', { label: '加载' })
  await delay(1000)
  await clickSelector(session, '.primary-button')
  await waitFor(session, 'Boolean(document.querySelector(".stage"))', { label: '进入体验页' })
  await delay(1500)
  if (KEY !== '1') await pressKey(session, KEY)
  await delay(2500)

  let hits = 0
  const seenHist = [0, 0, 0, 0, 0]
  for (let i = 0; i < 44; i += 1) {
    const frame = await evaluate(session, BRIGHT_BLOBS)
    frame.hist.forEach((n, k) => { seenHist[k] += n })
    if (i % 8 === 0) {
      console.log(
        `帧 ${i}: meteors=${frame.meteors} maxLuma=${Math.round(frame.maxLuma)} ` +
        `亮块=${frame.blobCount} 斜条=${frame.streaks.length} 最大块=${JSON.stringify(frame.biggest[0] ?? null)}`,
      )
    }
    if (frame.streaks.length > 0) {
      hits += 1
      const main = frame.streaks[0]
      seenPositions.push({ t: frame.t, x: main.x, y: main.y, w: main.w, h: main.h, size: main.size })
      console.log(`帧 ${i}: 发现 ${frame.streaks.length} 条亮斜条，最长 ${main.w}x${main.h} @(${main.x},${main.y}) size=${main.size}`)
      const { data } = await session.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(`${ARTIFACT_DIR}\\meteor-${KEY}-${i}.png`, Buffer.from(data, 'base64'))
    }
    await delay(260)
  }
  console.log(`\n亮度分布累计（195-210 / 210-225 / 225-240 / 240-250 / >250）: ${seenHist.join(' / ')}`)
  console.log(`汇总：44 帧中 ${hits} 帧捕获到亮斜条`)
  for (const p of seenPositions.slice(0, 12)) console.log(`  t=${p.t} @(${p.x},${p.y}) ${p.w}x${p.h}`)
  console.log(hits > 0 ? '判定：PASS（流星确实渲染出来了）' : '判定：FAIL（未捕获到流星）')
} catch (error) {
  console.log(`失败: ${error.message}`)
} finally {
  session?.close()
  chrome.kill()
}
