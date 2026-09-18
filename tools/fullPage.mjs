/**
 * 整页取证：进入体验页并切到指定样式后，截取整页（含左栏文案与底部模式入口）。
 * 运行：node tools/fullPage.mjs <url> [key]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

process.env.CDP_PORT = '9237'
const { CdpSession, clickSelector, evaluate, pressKey, waitFor, waitForPageTarget } = await import('./cdp.mjs')

const URL_UNDER_TEST = process.argv[2] || 'http://127.0.0.1:5180/'
const KEY = process.argv[3] || '4'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const USER_DATA_DIR = `${process.env.TEMP}\\dsh-birthday-fullpage`
const ARTIFACT_DIR = `${process.cwd()}\\tmp-artifacts`

rmSync(USER_DATA_DIR, { recursive: true, force: true })
mkdirSync(ARTIFACT_DIR, { recursive: true })

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9237', `--user-data-dir=${USER_DATA_DIR}`,
  '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--window-size=1440,900', '--enable-unsafe-swiftshader', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' })

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
  await delay(2200)
  await pressKey(session, KEY)
  await delay(6000)

  const metrics = await evaluate(
    session,
    `(() => { const canvas = document.querySelector('.particle-canvas');
      const stage = document.querySelector('.stage').getBoundingClientRect();
      return {
        tier: canvas.dataset.quality, backing: canvas.width + 'x' + canvas.height,
        css: Math.round(canvas.getBoundingClientRect().width) + 'x' + Math.round(canvas.getBoundingClientRect().height),
        stage: Math.round(stage.width) + 'x' + Math.round(stage.height),
        canvasFillsStage: Math.abs(canvas.getBoundingClientRect().width - stage.width) < 2,
        sampledPoints: canvas.dataset.sampledPoints, particleCount: canvas.dataset.particleCount,
        qualityLabel: document.querySelector('.stage-quality').textContent.trim(),
        gesture: document.querySelector('.gesture-status').textContent.trim(),
      }; })()`,
  )
  console.log(JSON.stringify(metrics))

  const box = await evaluate(
    session,
    `(() => ({ x: 0, y: 0, width: window.innerWidth, height: Math.min(window.innerHeight, document.documentElement.scrollHeight) }))()`,
  )
  const { data } = await session.send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 } })
  const out = `${ARTIFACT_DIR}\\fullpage-${KEY}.png`
  writeFileSync(out, Buffer.from(data, 'base64'))
  console.log(`saved ${out}`)
} catch (error) {
  console.log(`失败: ${error.message}`)
} finally {
  session?.close()
  chrome.kill()
}
