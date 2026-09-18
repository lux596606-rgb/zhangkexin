/**
 * 落地页首屏完整性检查：内容是否需要滚动、主按钮是否被引导区遮挡、引导卡片是否可见。
 * 运行：node tools/landingCheck.mjs <url>
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

process.env.CDP_PORT = '9229'
const { CdpSession, evaluate, waitFor, waitForPageTarget } = await import('./cdp.mjs')

const URL_UNDER_TEST = process.argv[2] || 'http://127.0.0.1:5180/'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const USER_DATA_DIR = `${process.env.TEMP}\\dsh-birthday-landing`
const ARTIFACT_DIR = `${process.cwd()}\\tmp-artifacts`

const REPORT = `(() => {
  const vh = window.innerHeight, vw = window.innerWidth;
  const doc = document.documentElement;
  const btn = document.querySelector('.primary-button');
  const guide = document.querySelector('.landing-guide') ?? document.querySelector('[class*="landing-guide"]');
  const cards = document.querySelectorAll('[class*="landing-guide"] [class*="card"], .landing-guide__card');
  const footer = document.querySelector('.landing-footer');
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) }; };
  const b = box(btn), g = box(guide), f = box(footer);
  // 引导区四个手势名与图标
  const svgCount = guide ? guide.querySelectorAll('svg').length : 0;
  return {
    viewport: { vw, vh },
    scrollHeight: doc.scrollHeight,
    bodyScrollHeight: document.body.scrollHeight,
    needsScroll: doc.scrollHeight > vh + 1,
    button: b, guide: g, footer: f,
    overlapButtonGuide: Boolean(b && g && !(b.b < g.t || b.t > g.b)),
    guideVisibleInViewport: Boolean(g && g.t >= 0 && g.b <= vh + 1),
    footerVisibleInViewport: Boolean(f && f.b <= vh + 1),
    guideSvgCount: svgCount,
    cardCount: cards.length,
    cardTexts: Array.from(cards).map((c) => c.textContent.replace(/\\s+/g, ' ').trim()),
    guideText: guide ? guide.textContent.replace(/\\s+/g, ' ').trim().slice(0, 260) : null,
    ctaText: btn ? btn.textContent.trim() : null,
    ctaVisible: b ? b.t >= 0 && b.b <= vh : null,
  };
})()`

rmSync(USER_DATA_DIR, { recursive: true, force: true })
mkdirSync(ARTIFACT_DIR, { recursive: true })

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9229', `--user-data-dir=${USER_DATA_DIR}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
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
  await delay(1500)

  const report = await evaluate(session, REPORT)
  console.log(JSON.stringify(report, null, 2))

  // 只截引导区，放大后看清线稿
  const clip = await evaluate(
    session,
    `(() => { const g = document.querySelector('[class*="landing-guide"]'); if (!g) return null;
      const r = g.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, scale: 2.6 }; })()`,
  )
  if (clip) {
    const { data } = await session.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 2.6 } })
    writeFileSync(`${ARTIFACT_DIR}\\landing-guide-zoom.png`, Buffer.from(data, 'base64'))
    console.log(`\n引导区放大截图: ${ARTIFACT_DIR}\\landing-guide-zoom.png`)
  }
} catch (error) {
  console.log(`失败: ${error.message}`)
} finally {
  session?.close()
  chrome.kill()
}
