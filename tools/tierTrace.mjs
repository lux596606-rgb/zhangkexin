/**
 * 逐帧采样：读取档位、FPS、canvas 分辨率与点数随时间的变化，判断"降档是否是画面变糊的根因"。
 * 运行：node tools/tierTrace.mjs <url> [key]
 */
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

process.env.CDP_PORT = '9231'
const { CdpSession, clickSelector, evaluate, pressKey, waitFor, waitForPageTarget } = await import('./cdp.mjs')

const URL_UNDER_TEST = process.argv[2] || 'http://127.0.0.1:5180/'
const KEY = process.argv[3] || '4'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const USER_DATA_DIR = `${process.env.TEMP}\\dsh-birthday-tiertrace`

const SAMPLE = `(() => {
  const canvas = document.querySelector('.particle-canvas');
  const quality = document.querySelector('.stage-quality');
  return {
    t: Math.round(performance.now()),
    tier: canvas.dataset.quality || null,
    backing: canvas.width + 'x' + canvas.height,
    css: Math.round(canvas.getBoundingClientRect().width) + 'x' + Math.round(canvas.getBoundingClientRect().height),
    label: quality ? quality.textContent.trim() : null,
    stage: Math.round(document.querySelector('.stage').getBoundingClientRect().width),
  };
})()`

rmSync(USER_DATA_DIR, { recursive: true, force: true })

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9231', `--user-data-dir=${USER_DATA_DIR}`,
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
  await delay(1500)
  await pressKey(session, KEY)
  for (let i = 0; i < 22; i += 1) {
    await delay(500)
    console.log(JSON.stringify(await evaluate(session, SAMPLE)))
  }
} catch (error) {
  console.log(`失败: ${error.message}`)
} finally {
  session?.close()
  chrome.kill()
}
