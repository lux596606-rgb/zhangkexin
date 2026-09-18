import { useEffect, useRef } from 'react'
import { CONFIDENCE_THRESHOLD, HOLD_MS, type GestureMode, type GestureStatus } from './gestureRecognition'
import type { GestureFeedbackState } from './gestureFeedbackState'

type GestureFeedbackProps = {
  state: GestureFeedbackState
  /** 无障碍标签前缀，默认「手势反馈」。 */
  title?: string
}

const modeLabels: Record<GestureMode, string> = {
  galaxy: '银河态',
  birthday: '生日快乐',
  pig: '猪头卡通',
  closing: '许愿收束',
}

/** 与键盘 1 / 2 / 3 / 4 一致的手势入口编号，让使用者一眼对上提示。 */
const modeKeys: Record<GestureMode, string> = {
  galaxy: '1',
  birthday: '2',
  pig: '3',
  closing: '4',
}

const holdSeconds = (HOLD_MS / 1000).toFixed(1)
const confidencePercent = Math.round(CONFIDENCE_THRESHOLD * 100)

const formatConfidence = (value: number) =>
  value >= CONFIDENCE_THRESHOLD ? `${Math.round(value * 100)}%` : `低于 ${confidencePercent}%`

type FeedbackCopy = {
  status: GestureStatus
  label: string
  mode: GestureMode | null
  hint: string
  showProgress: boolean
  showConfidence: boolean
}

/**
 * 七种状态的文案，与 GestureStatus 一一对应：
 * idle 未启动 / loading 加载中 / ready 已识别 / holding 保持中（进度）/
 * recognized 已触发 / unrecognized 没识别到 / unavailable 不可用。
 * 标签与 App 顶部状态行（gestureLabel）逐字一致：同一个状态全站只有一个名字。
 * 键盘一律写「键盘 1 / 2 / 3 / 4」，与落地页引导、降级提示保持同一种空格风格。
 */
function copyFor(state: GestureFeedbackState): FeedbackCopy {
  const modeLabel = state.mode ? modeLabels[state.mode] : ''

  switch (state.status) {
    case 'idle':
      return {
        status: state.status,
        label: '手势未启动',
        mode: null,
        hint: '开启摄像头即可用手势切换，键盘 1 / 2 / 3 / 4 始终可用',
        showProgress: false,
        showConfidence: false,
      }
    case 'loading':
      return {
        status: state.status,
        label: '手势识别加载中',
        mode: null,
        hint: '模型在本地加载，画面不会上传',
        showProgress: false,
        showConfidence: false,
      }
    case 'holding':
      return {
        status: state.status,
        label: state.unstable ? '手势不稳定' : '保持中',
        mode: state.mode,
        hint: state.unstable
          ? `手再稳一点，保持 ${holdSeconds} 秒就切换`
          : `保持一下，就会切到「${modeLabel}」`,
        showProgress: true,
        showConfidence: true,
      }
    case 'ready':
      return {
        status: state.status,
        label: '已识别手势',
        mode: state.mode,
        hint: `当前指向「${modeLabel}」，换姿势即可重新选择`,
        showProgress: false,
        showConfidence: true,
      }
    case 'recognized':
      return {
        status: state.status,
        label: '手势已触发',
        mode: state.mode,
        hint: `已切换到「${modeLabel}」`,
        showProgress: false,
        showConfidence: false,
      }
    case 'unrecognized':
      return {
        status: state.status,
        label: '未识别到手势',
        mode: null,
        hint: '张开手掌 / 捏合 / 握拳 / 竖拇指，保持一下就能切换',
        showProgress: false,
        showConfidence: false,
      }
    case 'unavailable':
      return {
        status: state.status,
        label: '手势识别不可用',
        mode: null,
        hint: '键盘 1 / 2 / 3 / 4 与鼠标点选仍然完全可用',
        showProgress: false,
        showConfidence: false,
      }
  }
}

/**
 * 克制的识别反馈条：贴在舞台左上角，不压住粒子画面中央，也不抢祝福文案的视线。
 * 进度条对应 HOLD_MS 的保持窗口，让别人看得出「系统正在等你保持住」。
 */
export function GestureFeedback({ state, title = '手势反馈' }: GestureFeedbackProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const labelRef = useRef<HTMLSpanElement | null>(null)
  const modeRef = useRef<HTMLSpanElement | null>(null)
  const confidenceRef = useRef<HTMLSpanElement | null>(null)
  const hintRef = useRef<HTMLParagraphElement | null>(null)
  const barWrapRef = useRef<HTMLDivElement | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)
  const lastRef = useRef<{ status: GestureStatus | null; mode: GestureMode | null; progress: number; confidence: number }>({
    status: null,
    mode: null,
    progress: -1,
    confidence: -1,
  })

  useEffect(() => {
    const apply = () => {
      const copy = copyFor(state)
      const last = lastRef.current
      const discrete = copy.status !== last.status || copy.mode !== last.mode

      // 离散变化：重写文案与可见性（每次切换只有几行文本，成本可忽略）。
      if (discrete) {
        const root = rootRef.current
        if (root) {
          root.className = `gesture-feedback gesture-feedback--${copy.status}`
          root.setAttribute('aria-label', `${title}：${copy.label}${copy.mode ? ` · ${modeLabels[copy.mode]}` : ''}`)
        }
        if (labelRef.current) labelRef.current.textContent = copy.label
        if (modeRef.current) {
          modeRef.current.hidden = copy.mode === null
          modeRef.current.textContent = copy.mode ? `${modeKeys[copy.mode]} ${modeLabels[copy.mode]}` : ''
        }
        if (confidenceRef.current) {
          confidenceRef.current.hidden = !copy.showConfidence
          confidenceRef.current.textContent = copy.showConfidence ? formatConfidence(state.confidence) : ''
        }
        if (hintRef.current) hintRef.current.textContent = copy.hint
        if (barWrapRef.current) barWrapRef.current.hidden = !copy.showProgress
        last.status = copy.status
        last.mode = copy.mode
      }

      // 逐帧变化：只改一个 transform 和一小段数字文本。
      if (barRef.current) {
        const percent = copy.showProgress ? Math.round(Math.min(1, Math.max(0, state.progress)) * 100) : 0
        if (percent !== last.progress) {
          barRef.current.style.transform = `scaleX(${percent / 100})`
          last.progress = percent
        }
      }
      if (confidenceRef.current && copy.showConfidence) {
        const percent = Math.round(Math.min(1, Math.max(0, state.confidence)) * 100)
        if (percent !== last.confidence) {
          confidenceRef.current.textContent = formatConfidence(state.confidence)
          last.confidence = percent
        }
      }
    }

    state.listeners.add(apply)
    apply()
    return () => {
      state.listeners.delete(apply)
    }
  }, [state, title])

  return (
    <div className="gesture-feedback gesture-feedback--idle" ref={rootRef} role="status" aria-live="polite" aria-label={title}>
      <p className="gesture-feedback__head">
        <span className="gesture-feedback__dot" />
        <span ref={labelRef}>手势未启动</span>
      </p>
      <p className="gesture-feedback__detail">
        <span className="gesture-feedback__mode" ref={modeRef} hidden />
        <span className="gesture-feedback__confidence" ref={confidenceRef} hidden />
      </p>
      <p className="gesture-feedback__hint" ref={hintRef} />
      <div className="gesture-feedback__bar" ref={barWrapRef} hidden aria-hidden="true">
        <div className="gesture-feedback__bar-fill" ref={barRef} />
      </div>
    </div>
  )
}
