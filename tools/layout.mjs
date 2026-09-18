/**
 * 布局探针：读取体验页关键元素的实际盒模型，用于排查"哪条规则把舞台挤小了"。
 * 运行：node tools/layout.mjs <url>
 */
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

process.env.CDP_PORT = '9229'
const { CdpSession, clickSelector, evaluate, pressKey, waitFor, waitForPageTarget } = await import('./cdp.mjs')

const URL_UNDER_TEST = process.argv[2] || 'http://127.0.0.1:5180/'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const USER_DATA_DIR = `${process.env.TEMP}\\dsh-birthday-layout`

const BOXES = `(() => {
  const names = ['.experience', '.experience-grid', '.scene-copy', '.stage-column', '.stage', '.particle-canvas', '.stage-caption', '.mode-nav', '.camera-dock'];
  const out = { viewport: { w: window.innerWidth, h: window.innerHeight }, dpr: window.devicePixelRatio, items: {} };
  for (const name of names) {
    const el = document.querySelector(name);
    if (!el) { out.items[name] = null; continue; }
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    out.items[name] = {
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      maxWidth: cs.maxWidth, aspectRatio: cs.aspectRatio, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom,
      gridTemplateColumns: cs.gridTemplateColumns, overflow: cs.overflow,
    };
  }
  const canvas = document.querySelector('.particle-canvas');
  if (canvas) out.canvasBacking = { width: canvas.width, height: canvas.height, quality: canvas.dataset.quality };
  out.bodyScroll = { scrollHeight: document.documentElement.scrollHeight, clientHeight: document.documentElement.clientHeight };
  return out;
})()`

rmSync(USER_DATA_DIR, { recursive: true, force: true })

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9229', `--user-data-dir=${USER_DATA_DIR}`,
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
  console.log('--- 落地页 ---')
  console.log(JSON.stringify(await evaluate(session, BOXES), null, 2))
  await clickSelector(session, '.primary-button')
  await waitFor(session, 'Boolean(document.querySelector(".stage"))', { label: '进入体验页' })
  await delay(1500)
  console.log('--- 体验页（银河） ---')
  console.log(JSON.stringify(await evaluate(session, BOXES), null, 2))
  await pressKey(session, '4')
  await delay(2600)
  console.log('--- 体验页（动作4 许愿收束） ---')
  console.log(JSON.stringify(await evaluate(session, BOXES), null, 2))
} catch (error) {
  console.log(`失败: ${error.message}`)
} finally {
  session?.close()
  chrome.kill()
}
