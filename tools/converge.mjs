/**
 * 收敛取证 v2：直接暴露 transition 内部 elapsed/running、follow 与当前帧参数，
 * 并统计每秒真实渲染帧数，用来识别"是否有多个渲染循环/陈旧闭包"。
 * 运行：node tools/converge.mjs <url>
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

process.env.CDP_PORT = '9226'
const { CdpSession, clickSelector, evaluate, pressKey, waitFor, waitForPageTarget } = await import('./cdp.mjs')

const URL_UNDER_TEST = process.argv[2] || 'http://127.0.0.1:5180/'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const USER_DATA_DIR = `${process.env.TEMP}\\dsh-birthday-converge`

const CANVAS_PATH = `${process.cwd()}\\src\\components\\ParticleCanvas.tsx`
const hash = (text) => createHash('sha256').update(text).digest('hex')
const original = readFileSync(CANVAS_PATH, 'utf8')
const digest = hash(original)

const DBG = [
  '        if (index === 0) {',
  '          const w = (window as unknown as { __dbg?: Record<string, unknown> })',
  '          const tv = transition as unknown as { elapsed: number; running: boolean }',
  // 给每个 renderFrame 实例打唯一编号，并统计"同一 timestamp 被渲染多少次"
  '          const g = window as unknown as { __loops?: Record<string, number>; __tags?: Record<string, number> }',
  '          if (!g.__loops) g.__loops = {}',
  '          if (!g.__tags) g.__tags = { sameTick: 0, lastTs: -1, switches: 0, lastTag: "" }',
  '          const tag = (w.__dbg?.tag as string) ?? "?"',
  '          const tags = g.__tags',
  '          if (tags.lastTs === timestamp) tags.sameTick += 1',
  '          if (tags.lastTag && tags.lastTag !== tag && tags.lastTs === timestamp) tags.switches += 1',
  '          tags.lastTs = timestamp',
  '          tags.lastTag = tag',
  '          g.__loops[tag] = (g.__loops[tag] ?? 0) + 1',
  '          w.__dbg = {',
  '            tag, loops: Object.entries(g.__loops).map(([k, v]) => `${k}:${v}`).join(" "),',
  '            sameTick: tags.sameTick, switches: tags.switches,',
  '            mode: activeMode, hasTargets: Boolean(targets), follow, frameScale, delta,',
  '            ts: timestamp, prev: previous,',
  '            tElapsed: Math.round(tv.elapsed * 1000) / 1000,',
  '            w0: Math.round(transition.gatherWeight(1) * 10000) / 10000,',
  '            avgDist: targets ? Math.round(particles.reduce((sum, p, i) => sum + (targets.buffer[i] ? Math.hypot(p.x - targets.buffer[i].x, p.y - targets.buffer[i].y) : 0), 0) / particles.length) : null,',
  '          }',
  '        }',
].join('\n')

const anchor = `        const follow = activeMode === 'galaxy' ? 0 : Math.min(1, transition.gatherWeight(particle.slot + 1) * 0.86 * frameScale)`
if (!original.includes(anchor)) throw new Error('未找到注入锚点')
// 第一处注入：给每个 renderFrame 闭包打唯一标记（每次 effect 挂载都会生成新闭包）
const tagAnchor = `    function renderFrame(timestamp: number) {
      animationRef.current = null`
if (!original.includes(tagAnchor)) throw new Error('未找到 renderFrame 锚点')
const tagged = original.replace(
  tagAnchor,
  `    function renderFrame(timestamp: number) {
      ;(window as unknown as { __seq?: number }).__seq = ((window as unknown as { __seq?: number }).__seq ?? 0) + 1
      const __tag = 'L' + String((window as unknown as { __seq?: number }).__seq)
      animationRef.current = null`,
)
writeFileSync(CANVAS_PATH, tagged.replace(anchor, `${anchor}\n${DBG}`).replace("tag, loops:", "tag: __tag, loops:"))

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9226', `--user-data-dir=${USER_DATA_DIR}`,
  '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--window-size=1440,900', '--enable-unsafe-swiftshader', 'about:blank',
], { stdio: 'ignore' })

await delay(1500)

let session = null
try {
  const target = await waitForPageTarget()
  session = await CdpSession.connect(target.webSocketDebuggerUrl)
  await session.send('Runtime.enable')
  await session.send('Page.enable')
  await session.send('Page.navigate', { url: URL_UNDER_TEST })
  await waitFor(session, 'document.readyState === "complete"', { label: '加载' })
  await delay(1500)
  await clickSelector(session, '.primary-button')
  await waitFor(session, 'Boolean(document.querySelector(".stage"))', { label: '进入体验页' })
  await delay(2000)

  const report = async (label) => {
    const dbg = await evaluate(session, 'window.__dbg ? JSON.parse(JSON.stringify(window.__dbg)) : null')
    if (!dbg) { console.log(`\n### ${label}: 无数据`); return }
    console.log(`\n### ${label}`)
    console.log(` 循环标记=${dbg.tag}  各实例帧数=[${dbg.loops}]  同帧重复渲染=${dbg.sameTick}  同帧内换实例=${dbg.switches}`)
    console.log(` mode=${dbg.mode} targets=${dbg.hasTargets} tElapsed=${dbg.tElapsed}s w0=${dbg.w0}`)
    console.log(` timestamp=${dbg.ts} previous=${dbg.prev} delta=${dbg.delta} frameScale=${dbg.frameScale} follow=${dbg.follow}`)
    console.log(` 全体平均距离=${dbg.avgDist}`)
  }

  await report('银河（默认）')
  await pressKey(session, '2')
  await delay(500); await report('生日快乐 t+0.5s')
  await delay(1500); await report('生日快乐 t+2.0s')
  await delay(3000); await report('生日快乐 t+5.0s')
  await pressKey(session, '3')
  await delay(4000); await report('猪头卡通 t+4.0s')
  await pressKey(session, '4')
  await delay(4000); await report('祝福收束 t+4.0s')
} catch (error) {
  console.log(`失败: ${error.message}`)
} finally {
  session?.close()
  chrome.kill()
  writeFileSync(CANVAS_PATH, original)
  console.log(`\n还原 ParticleCanvas.tsx : ${hash(readFileSync(CANVAS_PATH, 'utf8')) === digest ? 'OK (哈希一致)' : '失败！'}`)
}
