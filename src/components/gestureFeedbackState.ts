import type { GestureMode, GestureStatus } from './gestureRecognition'

/**
 * 手势反馈的「心跳」对象：GestureController 每帧就地修改它，GestureFeedback 每帧就地读取它。
 *
 * 刻意不用 React state 承载 progress/confidence：这两项每帧都在变，走 setState 等于每秒让
 * 整个体验页重渲染 30-60 次，会直接拖累粒子画布。只有 status/mode 这类离散变化才触发一次
 * 真正的 DOM 文本更新。
 */
export type GestureFeedbackState = {
  status: GestureStatus
  /** 当前识别到的姿势（holding / ready / recognized 时有值）。 */
  mode: GestureMode | null
  confidence: number
  /** 保持进度 0-1，对应 HOLD_MS 的保持窗口。 */
  progress: number
  /** 识别在反复抖动，提示使用者「手再稳一点」。 */
  unstable: boolean
  /** 活跃订阅者（GestureFeedback 的回调）；没有订阅者时为空。 */
  listeners: Set<(state: GestureFeedbackState) => void>
}

export function createGestureFeedbackState(overrides: Partial<GestureFeedbackState> = {}): GestureFeedbackState {
  return { status: 'idle', mode: null, confidence: 0, progress: 0, unstable: false, listeners: new Set(), ...overrides }
}

/** 就地更新并通知订阅者；引用保持不变，因此不会引起组件重渲染。 */
export function publishGestureFeedback(
  state: GestureFeedbackState,
  next: Partial<Omit<GestureFeedbackState, 'listeners'>>,
) {
  Object.assign(state, next)
  if (state.listeners.size === 0) return
  for (const listener of state.listeners) listener(state)
}
