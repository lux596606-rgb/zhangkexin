/**
 * 手势反馈 UI 的在线检查：确认反馈条真的渲染、状态文案随摄像头状态变化、不遮挡粒子画面。
 * 运行：node tools/feedbackCheck.mjs <url>
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

process.env.CDP_PORT = '9228'
const { CdpSession, clickSelector, evaluate, waitFor, waitForPageTarget } = await import('./cdp.mjs')

const URL_UNDER_TEST = process.argv[2] || 'http://127.0.0.1:5180/'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const USER_DATA_DIR = `${process.env.TEMP}\\dsh-birthday-feedback`
const ARTIFACT_DIR = `${process.cwd()}\\tmp-artifacts`

const FEEDBACK = `(() => {
  const el = document.querySelector('.gesture-feedback');
  if (!el) return { found: false };
  const rect = el.getBoundingClientRect();
  const stage = document.querySelector('.stage')?.getBoundingClientRect();
  const canvas = document.querySelector('.particle-canvas')?.getBoundingClientRect();
  const bar = document.querySelector('.gesture-feedback__bar');
  const fill = document.querySelector('.gesture-feedback__bar-fill');
  return {
    found: true,
    className: el.className,
    ariaLabel: el.getAttribute('aria-label'),
    label: document.querySelector('.gesture-feedback__head')?.textContent?.trim() ?? null,
    mode: document.querySelector('.gesture-feedback__mode')?.textContent?.trim() ?? null,
    modeHidden: document.querySelector('.gesture-feedback__mode')?.hidden ?? null,
    confidence: document.querySelector('.gesture-feedback__confidence')?.textContent?.trim() ?? null,
    hint: document.querySelector('.gesture-feedback__hint')?.textContent?.trim() ?? null,
    barHidden: bar ? bar.hidden : null,
    barTransform: fill ? getComputedStyle(fill).transform : null,
    box: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
    stageBox: stage ? { x: Math.round(stage.x), y: Math.round(stage.y), w: Math.round(stage.width), h: Math.round(stage.height) } : null,
    canvasBox: canvas ? { x: Math.round(canvas.x), y: Math.round(canvas.y), w: Math.round(canvas.width), h: Math.round(canvas.height) } : null,
    cameraText: document.querySelector('.camera-status')?.textContent?.trim() ?? null,
  };
})()`

rmSync(USER_DATA_DIR, { recursive: true, force: true })
mkdirSync(ARTIFACT_DIR, { recursive: true })

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9228', `--user-data-dir=${USER_DATA_DIR}`,
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

  console.log('=== 落地页阶段（摄像头未开启） ===')
  console.log(JSON.stringify(await evaluate(session, FEEDBACK), null, 2))

  await clickSelector(session, '.primary-button')
  await waitFor(session, 'Boolean(document.querySelector(".stage"))', { label: '进入体验页' })
  await delay(3000)

  console.log('\n=== 体验页（摄像头已开启，等待手势） ===')
  const inApp = await evaluate(session, FEEDBACK)
  console.log(JSON.stringify(inApp, null, 2))

  // 反馈条与粒子画面是否重叠
  if (inApp.box && inApp.canvasBox) {
    const overlap = !(inApp.box.x + inApp.box.w < inApp.canvasBox.x
      || inApp.box.x > inApp.canvasBox.x + inApp.canvasBox.w
      || inApp.box.y + inApp.box.h < inApp.canvasBox.y
      || inApp.box.y > inApp.canvasBox.y + inApp.canvasBox.h)
    console.log(`\n反馈条与粒子画布是否重叠: ${overlap ? '是（需关注是否遮挡主体）' : '否'}`)
  }

  const { data } = await session.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${ARTIFACT_DIR}\\feedback.png`, Buffer.from(data, 'base64'))
  console.log(`截图: ${ARTIFACT_DIR}\\feedback.png`)

  // 状态是否真的在随识别推进（而不是停在默认文案）
  console.log('\n=== 反馈条文案随时间变化（证明订阅在生效） ===')
  for (const wait of [0, 1500, 3000, 5000]) {
    if (wait > 0) await delay(wait === 1500 ? 1500 : 1500)
    const snapshot = await evaluate(
      session,
      `(() => { const el = document.querySelector('.gesture-feedback');
        return { cls: el?.className ?? null, label: document.querySelector('.gesture-feedback__head')?.textContent?.trim() ?? null,
                 keys: document.querySelector('.gesture-status')?.textContent?.trim() ?? null }; })()`,
    )
    console.log(` t+${wait}ms  反馈条="${snapshot.label}" (${snapshot.cls})  顶部状态="${snapshot.keys}"`)
  }
} catch (error) {
  console.log(`失败: ${error.message}`)
} finally {
  session?.close()
  chrome.kill()
}
