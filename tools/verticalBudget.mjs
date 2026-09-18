/**
 * 体验页纵向预算诊断：逐段量出各区块实际占用的高度，找出滚动条到底是谁撑出来的。
 * 运行：node tools/verticalBudget.mjs <url>
 */
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

process.env.CDP_PORT = '9231'
const { CdpSession, clickSelector, evaluate, waitFor, waitForPageTarget } = await import('./cdp.mjs')

const URL_UNDER_TEST = process.argv[2] || 'http://127.0.0.1:5180/'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const USER_DATA_DIR = `${process.env.TEMP}\\dsh-birthday-vbudget`

rmSync(USER_DATA_DIR, { recursive: true, force: true })

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9231', `--user-data-dir=${USER_DATA_DIR}`,
  '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--window-size=1440,900', '--enable-unsafe-swiftshader', 'about:blank',
], { stdio: 'ignore' })

const BUDGET = `(() => {
  const vh = window.innerHeight;
  const innerW = window.innerWidth;
  const stage = document.querySelector('.stage');
  const sc = stage ? getComputedStyle(stage) : null;
  const stageInfo = stage ? {
    rectW: Math.round(stage.getBoundingClientRect().width),
    rectH: Math.round(stage.getBoundingClientRect().height),
    computedMaxWidth: sc.maxWidth,
    computedWidth: sc.width,
    computedAspect: sc.aspectRatio,
    computedJustifySelf: sc.justifySelf,
    offsetWidth: stage.offsetWidth,
    parentW: Math.round(stage.parentElement.getBoundingClientRect().width),
    colW: Math.round(stage.parentElement.getBoundingClientRect().width),
  } : null;
  const parts = ['.experience', '.topbar', '.experience-grid', '.scene-copy', '.stage', '.camera-dock', '.mode-nav'];
  const rows = parts.map((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { sel, missing: true };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { sel, top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height),
             mt: cs.marginTop, mb: cs.marginBottom, pt: cs.paddingTop, pb: cs.paddingBottom };
  });
  const nav = document.querySelector('.mode-nav');
  const navBottom = nav ? Math.round(nav.getBoundingClientRect().bottom) : null;
  return {
    viewportH: vh,
    innerW,
    stageInfo,
    scrollHeight: document.documentElement.scrollHeight,
    overflow: document.documentElement.scrollHeight - vh,
    navBottom,
    spaceBelowNav: navBottom === null ? null : vh - navBottom,
    rows,
  };
})()`

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

  const report = await evaluate(session, BUDGET)
  console.log(`视口 ${report.innerW}x${report.viewportH}  文档高 ${report.scrollHeight}  溢出 ${report.overflow}`)
  console.log(`stage 计算样式: ${JSON.stringify(report.stageInfo)}`)
  console.log(`底部模式入口 bottom=${report.navBottom}  其下方剩余 ${report.spaceBelowNav}`)
  console.log('')
  for (const row of report.rows) {
    if (row.missing) { console.log(`${row.sel.padEnd(18)} (不存在)`); continue }
    console.log(`${row.sel.padEnd(18)} top=${String(row.top).padStart(5)} bottom=${String(row.bottom).padStart(5)} h=${String(row.h).padStart(4)}  mt=${row.mt} mb=${row.mb}`)
  }
} catch (error) {
  console.log(`失败: ${error.message}`)
} finally {
  session?.close()
  chrome.kill()
}
