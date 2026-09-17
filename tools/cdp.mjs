/**
 * 极简 Chrome DevTools Protocol 客户端：只用 Node 内置 WebSocket，不引入依赖。
 * 用途：PM 验收时在真实浏览器里驱动页面、读取真实 DOM/Canvas 状态。
 */
import { setTimeout as delay } from 'node:timers/promises'

const DEBUG_PORT = Number(process.env.CDP_PORT || 9222)

async function fetchJson(pathname) {
  const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}${pathname}`)
  if (!response.ok) throw new Error(`CDP HTTP ${response.status} for ${pathname}`)
  return response.json()
}

/** 等待 Chrome 的调试端口就绪，返回可连接的 page target。 */
export async function waitForPageTarget(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson('/json/list')
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page) return page
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }
  throw new Error(`Chrome 调试端口未就绪: ${lastError?.message ?? 'timeout'}`)
}

export class CdpSession {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.listeners = []
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(`${message.error.message} (${JSON.stringify(message.error.data ?? '')})`))
        else resolve(message.result)
        return
      }
      for (const listener of this.listeners) listener(message)
    })
  }

  static async connect(webSocketDebuggerUrl) {
    const socket = new WebSocket(webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true })
    })
    return new CdpSession(socket)
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    this.socket.send(JSON.stringify(payload))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 超时: ${method}`))
      }, 40000)
    })
  }

  onEvent(listener) {
    this.listeners.push(listener)
  }

  close() {
    this.socket.close()
  }
}

/** 在页面里求值并返回 JSON 化结果；异常会带堆栈抛出，避免静默失败。 */
export async function evaluate(session, expression) {
  const result = await session.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  if (result.exceptionDetails) {
    throw new Error(`页面求值异常: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
  }
  return result.result.value
}

export async function waitFor(session, expression, { timeoutMs = 20000, label = '条件', intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(session, expression)) return true
    await delay(intervalMs)
  }
  throw new Error(`等待超时: ${label}`)
}

/** 键盘事件要带真实 keyCode/text，React 的 keydown 处理才认。 */
export async function pressKey(session, key) {
  const map = {
    Enter: { code: 'Enter', keyCode: 13, text: '\r' },
    ' ': { code: 'Space', keyCode: 32, text: ' ' },
    '1': { code: 'Digit1', keyCode: 49, text: '1' },
    '2': { code: 'Digit2', keyCode: 50, text: '2' },
    '3': { code: 'Digit3', keyCode: 51, text: '3' },
    '4': { code: 'Digit4', keyCode: 52, text: '4' },
    r: { code: 'KeyR', keyCode: 82, text: 'r' },
    R: { code: 'KeyR', keyCode: 82, text: 'R' },
  }
  const info = map[key]
  if (!info) throw new Error(`未支持的按键: ${key}`)
  const base = { key, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode }
  await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: info.text })
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

/** 通过真实鼠标事件点击元素中心，走完整的命中测试，而不是直接调用 DOM click()。 */
export async function clickSelector(session, selector) {
  const box = await evaluate(
    session,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
      const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()`,
  )
  if (!box || box.w === 0 || box.h === 0) throw new Error(`元素不可点击: ${selector}`)
  const point = { x: Math.round(box.x), y: Math.round(box.y), button: 'left', clickCount: 1 }
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point })
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point })
  return point
}
