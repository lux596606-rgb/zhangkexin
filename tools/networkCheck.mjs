/**
 * 外网依赖检查：真实浏览器抓取全部网络请求，确认页面不依赖任何外网资源。
 * 运行：node tools/networkCheck.mjs <url>
 */
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

process.env.CDP_PORT = '9230'
const { CdpSession, clickSelector, evaluate, waitFor, waitForPageTarget } = await import('./cdp.mjs')

const URL_UNDER_TEST = process.argv[2] || 'http://127.0.0.1:5180/'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const USER_DATA_DIR = `${process.env.TEMP}\\dsh-birthday-net`

rmSync(USER_DATA_DIR, { recursive: true, force: true })

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9230', `--user-data-dir=${USER_DATA_DIR}`,
  '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--window-size=1440,900', '--enable-unsafe-swiftshader', 'about:blank',
], { stdio: 'ignore' })

const requests = []
let session = null
try {
  const target = await waitForPageTarget()
  session = await CdpSession.connect(target.webSocketDebuggerUrl)
  session.onEvent((message) => {
    if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url)
    if (message.method === 'Network.loadingFailed') {
      requests.push(`FAILED:${message.params.errorText}:${message.params.requestId}`)
    }
  })
  await session.send('Runtime.enable')
  await session.send('Page.enable')
  await session.send('Network.enable')
  await session.send('Page.navigate', { url: URL_UNDER_TEST })
  await waitFor(session, 'document.readyState === "complete"', { label: '加载' })
  await delay(1500)
  await clickSelector(session, '.primary-button')
  await waitFor(session, 'Boolean(document.querySelector(".stage"))', { label: '进入体验页' })
  // 给 MediaPipe 模型与 wasm 足够时间发起请求
  await delay(8000)

  const external = requests.filter((url) => url.startsWith('http') && !url.includes('127.0.0.1') && !url.includes('localhost'))
  const internal = requests.filter((url) => url.startsWith('http') && (url.includes('127.0.0.1') || url.includes('localhost')))
  const other = requests.filter((url) => !url.startsWith('http'))

  console.log(`总请求数: ${requests.length}`)
  console.log(`  本机请求: ${internal.length}`)
  console.log(`  外网请求: ${external.length}`)
  console.log(`  非 http（data:/blob: 等）: ${other.length}`)

  if (external.length > 0) {
    console.log('\n=== 外网请求明细 ===')
    for (const url of [...new Set(external)]) console.log(`  ${url}`)
  } else {
    console.log('\n外网请求: 无')
  }

  const fonts = internal.filter((url) => /\.(woff2?|ttf|otf)(\?|$)/i.test(url))
  console.log(`\n字体请求（本机 ${fonts.length} 个）:`)
  for (const url of [...new Set(fonts)]) console.log(`  ${url.replace(/^https?:\/\/[^/]+/, '')}`)

  // 页面里是否还有 css 变量指向外部字体
  const cssExternal = await evaluate(
    session,
    `(() => {
       const out = [];
       for (const sheet of Array.from(document.styleSheets)) {
         let rules; try { rules = sheet.cssRules } catch { continue }
         for (const rule of Array.from(rules ?? [])) {
           const text = rule.cssText ?? '';
           if (text.includes('googleapis') || text.includes('gstatic')) out.push(text.slice(0, 120));
           if (rule instanceof CSSFontFaceRule && rule.style?.src) out.push('FONT-FACE ' + rule.style.src.slice(0, 120));
         }
       }
       const links = Array.from(document.querySelectorAll('link')).map((l) => l.href);
       return { externalInCss: out.filter((t) => t.includes('google')), fontFaces: out.filter((t) => t.startsWith('FONT-FACE')), links };
     })()`,
  )
  console.log('\n=== 页面内字体声明 ===')
  console.log(JSON.stringify(cssExternal, null, 2))
} catch (error) {
  console.log(`失败: ${error.message}`)
} finally {
  session?.close()
  chrome.kill()
}
