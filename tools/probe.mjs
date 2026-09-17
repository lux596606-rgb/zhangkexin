/**
 * 任务 1 验收探针：在真实 Chrome 里跑一遍，用真实 DOM/Canvas 状态判断实现是否成立。
 * 运行：node tools/probe.mjs <url>
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { CdpSession, clickSelector, evaluate, pressKey, waitFor, waitForPageTarget } from './cdp.mjs'

const URL_UNDER_TEST = process.argv[2] || 'http://127.0.0.1:5180/'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const USER_DATA_DIR = `${process.env.TEMP}\\dsh-birthday-probe`
const ARTIFACT_DIR = `${process.cwd()}\\tmp-artifacts`
const DEBUG_PORT = 9222

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | ${detail}`)
}

rmSync(USER_DATA_DIR, { recursive: true, force: true })
mkdirSync(ARTIFACT_DIR, { recursive: true })

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--window-size=1440,900',
    '--enable-unsafe-swiftshader',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

let session = null
const consoleMessages = []
const pageErrors = []

/** 读取 canvas 的实际像素，确认不是空白画布（"代码看起来对"和"真的画出来"是两件事）。 */
const CANVAS_PROBE = `(() => {
  const canvas = document.querySelector('.particle-canvas');
  if (!canvas) return { found: false };
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let lit = 0, sum = 0, maxAlpha = 0;
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i];
    if (a > 12) lit += 1;
    sum += a;
    if (a > maxAlpha) maxAlpha = a;
  }
  const total = data.length / 4;
  return {
    found: true,
    width: canvas.width,
    height: canvas.height,
    litRatio: Math.round((lit / total) * 10000) / 100,
    avgAlpha: Math.round((sum / total) * 10) / 10,
    maxAlpha,
  };
})()`

const STATE_PROBE = `(() => {
  const stage = document.querySelector('.stage');
  const quality = document.querySelector('.stage-quality');
  const caption = document.querySelector('.stage-caption');
  const title = document.querySelector('#experience-title');
  const gesture = document.querySelector('.gesture-status');
  const camera = document.querySelector('.camera-status');
  return {
    stageClass: stage ? stage.className : null,
    canvasQuality: document.querySelector('.particle-canvas')?.dataset?.quality ?? null,
    qualityLabel: quality ? quality.textContent : null,
    qualityOpacity: quality ? getComputedStyle(quality).opacity : null,
    caption: caption ? caption.textContent : null,
    title: title ? title.textContent : null,
    gesture: gesture ? gesture.textContent : null,
    camera: camera ? camera.textContent : null,
    paused: document.querySelector('.experience')?.className.includes('is-paused') ?? null,
  };
})()`

const shot = async (name) => {
  const { data } = await session.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${ARTIFACT_DIR}\\${name}.png`, Buffer.from(data, 'base64'))
}

try {
  const target = await waitForPageTarget()
  session = await CdpSession.connect(target.webSocketDebuggerUrl)
  session.onEvent((message) => {
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) {
      consoleMessages.push(`${message.params.type}: ${message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`)
    }
    if (message.method === 'Runtime.exceptionThrown') {
      pageErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
    }
  })
  await session.send('Runtime.enable')
  await session.send('Page.enable')
  await session.send('Page.navigate', { url: URL_UNDER_TEST })
  await waitFor(session, 'document.readyState === "complete"', { label: '页面加载' })
  await delay(1200)

  // --- 1. 落地页 ---
  const landing = await evaluate(
    session,
    `(() => {
      const h1 = document.querySelector('#landing-title');
      const button = document.querySelector('.primary-button');
      const privacy = document.querySelector('.privacy-note');
      return { title: h1 ? h1.textContent : null, button: button ? button.textContent.trim() : null, privacy: privacy ? privacy.textContent.trim() : null };
    })()`,
  )
  record('落地页渲染 + 中文正常', Boolean(landing.title?.includes('张珂欣') && landing.button?.includes('开启星光')), JSON.stringify(landing))
  await shot('01-landing')

  // --- 2. 点击「开启星光」，走真实鼠标事件 ---
  await clickSelector(session, '.primary-button')
  await waitFor(session, 'Boolean(document.querySelector(".stage"))', { label: '进入体验页', timeoutMs: 15000 })
  await delay(2500)

  const started = await evaluate(session, STATE_PROBE)
  record('进入体验页并默认银河态', started.stageClass?.includes('stage-galaxy') === true, JSON.stringify(started))

  const canvasInfo = await evaluate(session, CANVAS_PROBE)
  record('粒子画布真的画出了东西', canvasInfo.found && canvasInfo.litRatio > 0.2, JSON.stringify(canvasInfo))
  await shot('02-galaxy')

  record('摄像头授权成功（假设备）', started.camera?.includes('已开启') === true, started.camera ?? 'null')
  record('手势识别状态可见', typeof started.gesture === 'string' && started.gesture.length > 0, started.gesture ?? 'null')

  // --- 3. 键盘 1/2/3/4 切换 ---
  const expected = { 2: 'stage-birthday', 3: 'stage-pig', 4: 'stage-closing', 1: 'stage-galaxy' }
  for (const [key, className] of Object.entries(expected)) {
    await pressKey(session, key)
    await delay(2600)
    const state = await evaluate(session, STATE_PROBE)
    const pixels = await evaluate(session, CANVAS_PROBE)
    record(
      `按键 ${key} 切到 ${className}`,
      state.stageClass?.includes(className) === true && pixels.litRatio > 0.2,
      `class=${state.stageClass} lit=${pixels.litRatio}% quality=${state.canvasQuality} label=${state.qualityLabel}`,
    )
    await shot(`03-mode-${key}-${className}`)
  }

  // --- 4. 空格暂停 / R 重置 ---
  await pressKey(session, ' ')
  await delay(400)
  const pausedState = await evaluate(session, STATE_PROBE)
  record('空格暂停生效', pausedState.paused === true, `paused=${pausedState.paused}`)
  await pressKey(session, ' ')
  await delay(400)
  const resumed = await evaluate(session, STATE_PROBE)
  record('空格恢复生效', resumed.paused === false, `paused=${resumed.paused}`)

  await pressKey(session, '3')
  await delay(1200)
  await pressKey(session, 'R')
  await delay(1200)
  const reset = await evaluate(session, STATE_PROBE)
  record('R 回到银河态', reset.stageClass?.includes('stage-galaxy') === true, `class=${reset.stageClass}`)

  // --- 5. 鼠标点击模式入口 ---
  const tabBox = await evaluate(
    session,
    `(() => { const tabs = document.querySelectorAll('.mode-tab'); return { count: tabs.length, labels: Array.from(tabs).map(t => t.textContent.trim()) }; })()`,
  )
  record('四个模式入口存在', tabBox.count === 4, JSON.stringify(tabBox.labels))
  await evaluate(session, `document.querySelectorAll('.mode-tab')[2].click()`)
  await delay(2400)
  const clicked = await evaluate(session, STATE_PROBE)
  record('鼠标点击入口切到猪头卡通', clicked.stageClass?.includes('stage-pig') === true, `class=${clicked.stageClass}`)
  await shot('04-pig-clicked')

  // --- 6. 长时间运行：帧率与档位是否稳定/是否触发降档 ---
  await evaluate(session, `document.querySelectorAll('.mode-tab')[3].click()`)
  await delay(6000)
  const closing = await evaluate(session, STATE_PROBE)
  const closingPixels = await evaluate(session, CANVAS_PROBE)
  record('收束样式持续渲染', closing.stageClass?.includes('stage-closing') === true && closingPixels.litRatio > 0.2, `lit=${closingPixels.litRatio}% ${closing.qualityLabel}`)
  await shot('05-closing')

  const fpsSeries = []
  for (let index = 0; index < 6; index += 1) {
    await delay(2000)
    const state = await evaluate(session, STATE_PROBE)
    fpsSeries.push(`${state.canvasQuality}/${state.qualityLabel}`)
  }
  record('画质档位与帧率持续上报', fpsSeries.every((entry) => entry.includes('FPS')), fpsSeries.join(' → '))

  record('无未捕获的页面异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' || ') || 'none')
  console.log('\n--- 控制台 error/warning ---')
  console.log(consoleMessages.length === 0 ? '(无)' : consoleMessages.slice(0, 12).join('\n'))
  console.log('\n--- 截图 ---')
  console.log(ARTIFACT_DIR)
} catch (error) {
  record('探针执行', false, `${error.message}`)
} finally {
  session?.close()
  chrome.kill()
}

const failed = results.filter((item) => !item.ok)
console.log(`\n===== 汇总: ${results.length - failed.length}/${results.length} 通过 =====`)
if (failed.length > 0) {
  console.log('失败项:')
  for (const item of failed) console.log(` - ${item.name}: ${item.detail}`)
  process.exitCode = 1
}
