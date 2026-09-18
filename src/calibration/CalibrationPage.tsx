import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FilesetResolver, GestureRecognizer, type GestureRecognizerResult } from '@mediapipe/tasks-vision'
import {
  CONFIDENCE_THRESHOLD,
  COOLDOWN_MS,
  FINGER_EXTENSION_MIN_ANGLE_DEG,
  FINGER_EXTENSION_WRIST_RATIO,
  GestureStabilityTracker,
  HOLD_MS,
  INDEX_EXTENSION_MIN_RATIO,
  MIN_OTHER_FINGERS_EXTENDED,
  PINCH_ENTER_RATIO,
  PINCH_EXIT_RATIO,
  PINCH_MIN_SAMPLES,
  PINCH_WINDOW_FRAMES,
  PinchSmoother,
  UNSTABLE_HOLD_PENALTY_MS,
  classifyGesture,
  describeHand,
  type HandDiagnostics,
  type Landmark,
} from '../components/gestureRecognition'
import { formatSummaryReport, summarizeSamples, type CalibrationSample, type CalibrationSummary } from './sampling'

/**
 * 手势自测校准台（开发者 / 验收者用，不进产品入口）。
 *
 * 它存在的唯一理由：捏合手势的阈值（尤其 130° 的 PIP 伸直判据）是用几何推算定的，
 * 没在真实手上验证过。这一页把**真实判定路径**用到的每个中间量摊开给人看：
 * 数值全部来自 `gestureRecognition.ts` 的只读导出（`describeHand` / 各阈值常量）与
 * 真实的 `classifyGesture` + `PinchSmoother` + `GestureStabilityTracker`，
 * 校准页自己不复刻任何判据 —— 否则校准的就是另一套假阈值。
 *
 * 隐私：与产品页一致。摄像头画面只在本机内存里，不录制、不上传、不保存任何帧或关键点。
 * 本页没有任何网络请求（MediaPipe 的 wasm / 模型与产品页共用同一份本地自托管资源）。
 */

const assetPath = (relativePath: string) => `${import.meta.env.BASE_URL}${relativePath}`
const WASM_PATH = assetPath('mediapipe/wasm')
const MODEL_PATH = assetPath('mediapipe/gesture_recognizer.task')

/** 诊断页特有的常量（不是判定阈值，只影响本页的展示与结论口径）。 */
/** 判定「几何已经稳定成立」需要连续保持的时长：比真实 HOLD_MS 长得多，避免一闪而过就下结论。 */
const STABLE_HOLD_MS = 3000
/** 滚动统计窗口：只统计最近这段时间的关键量，回答「刚才这几秒典型值是多少」。 */
const ROLLING_WINDOW_MS = 8000
/** UI 刷新间隔：判定每帧都在跑，但页面数字 8Hz 刷新足够看，也不会拖慢推理。 */
const UI_REFRESH_MS = 120

type CameraState = 'idle' | 'requesting' | 'running' | 'error'

type FrameState = {
  frames: number
  /** 这一帧有没有检测到手（没手时所有几何量都不可用）。 */
  handDetected: boolean
  category: string
  mediaPipeConfidence: number
  /** classifyGesture 的输出。 */
  detectedMode: string | null
  detectedConfidence: number
  /** 平滑后的捏合是否成立（页面显示的那个结论）。 */
  pinchConfirmed: boolean
  trackerStatus: string
  trackerProgress: number
  trackerCandidate: string | null
  trackerUnstable: boolean
  trackerTrigger: string | null
  hand: HandDiagnostics | null
}

const emptyFrame: FrameState = {
  frames: 0,
  handDetected: false,
  category: '（无帧）',
  mediaPipeConfidence: 0,
  detectedMode: null,
  detectedConfidence: 0,
  pinchConfirmed: false,
  trackerStatus: 'idle',
  trackerProgress: 0,
  trackerCandidate: null,
  trackerUnstable: false,
  trackerTrigger: null,
  hand: null,
}

type PinchRun = {
  /** 当前这一轮「几何上捏合成立」的开始时间。 */
  startedAt: number
  /** 这一轮里平滑确认的帧数（双阈值都过）。 */
  confirmedFrames: number
  /** 这一轮里单帧观测成立的帧数。 */
  observedFrames: number
  /** 这一轮里达标帧的最小捏合比值、最大食指 PIP 角度，用于给「需要放宽多少」定量。 */
  minRatio: number
  maxPipDeg: number
}

type Diagnosis = {
  level: 'ok' | 'warn' | 'bad' | 'idle'
  headline: string
  detail: string[]
}

const fmt = (value: number | null | undefined, digits = 3) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—'

/** 复制到剪贴板：navigator.clipboard 在非 HTTPS/无权限时会失败，失败则退回可选中文本框。 */
async function copyText(text: string): Promise<'clipboard' | 'manual'> {
  try {
    if (!navigator.clipboard?.writeText) return 'manual'
    await navigator.clipboard.writeText(text)
    return 'clipboard'
  } catch {
    return 'manual'
  }
}

/** 页面副标题用的模式名映射：让不懂代码的人也能把英文枚举读成中文。 */
const modeLabel: Record<string, string> = {
  galaxy: 'galaxy（银河态）',
  birthday: 'birthday（生日快乐）',
  pig: 'pig（猪头卡通）',
  closing: 'closing（祝福收束）',
}

export function CalibrationPage() {
  const [camera, setCamera] = useState<CameraState>('idle')
  const [cameraError, setCameraError] = useState('')
  const [recognizerState, setRecognizerState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [frame, setFrame] = useState<FrameState>(emptyFrame)
  const [sampling, setSampling] = useState(false)
  const [sampleCount, setSampleCount] = useState(0)
  const [summary, setSummary] = useState<{ summary: CalibrationSummary; seconds: number } | null>(null)
  const [rolling, setRolling] = useState<{ seconds: number; ratioMin: number | null; ratioMax: number | null; ratioMedian: number | null; pipMedian: number | null; closeFrames: number } | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'clipboard' | 'manual'>('idle')

  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const frameRef = useRef<FrameState>(emptyFrame)
  /** 捏合几何「成立」的连续保持计时（页面结论的核心输入）。 */
  const pinchRef = useRef<{ bestMs: number; closeSince: number; run: PinchRun | null }>({
    bestMs: 0,
    closeSince: 0,
    run: null,
  })
  /** 自动诊断结论要用到「本轮最佳持续时长」，所以单独存一份到 state。 */
  const [hold, setHold] = useState({ currentMs: 0, bestMs: 0, closeCurrentMs: 0 })
  /** 滚动窗口样本（只留最近 ROLLING_WINDOW_MS）。 */
  const rollingRef = useRef<{ at: number; sample: CalibrationSample }[]>([])
  /** 用户按「开始采样」之后收集的样本。 */
  const recordingRef = useRef<{ startedAt: number; samples: CalibrationSample[] } | null>(null)
  const reportRef = useRef<HTMLTextAreaElement>(null)

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setCamera('idle')
    setRecognizerState('idle')
  }, [])

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
  }, [])

  /** 显式按钮触发的 getUserMedia：浏览器要求用户手势，产品页也是这个流程。 */
  const startCamera = useCallback(async () => {
    if (camera === 'requesting' || camera === 'running') return
    setCameraError('')
    setCamera('requesting')
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamera('error')
      setCameraError('这个浏览器没有 navigator.mediaDevices.getUserMedia')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play().catch(() => undefined)
      }
      setCamera('running')
    } catch (error) {
      setCamera('error')
      setCameraError(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    }
  }, [camera])

  /**
   * 识别主循环：与产品页 `GestureController` 用同样的调用次序（每帧一次 recognizeForVideo，
   * 结果同时喂给 classifyGesture、PinchSmoother 与 GestureStabilityTracker），
   * 所以这里看到的进度/候选/抖动就是产品页的真实状态。
   */
  useEffect(() => {
    if (camera !== 'running') return undefined
    let disposed = false
    let frameId: number | null = null
    let recognizer: GestureRecognizer | null = null
    let lastVideoTime = -1
    let lastUiAt = 0
    const tracker = new GestureStabilityTracker()
    const smoother = new PinchSmoother()

    const publish = (now: number, force: boolean) => {
      // 采样帧数必须每帧都记（它体现的是「采到了多少」，与 UI 刷新节流无关）。
      if (recordingRef.current) setSampleCount(recordingRef.current.samples.length)
      if (!force && now - lastUiAt < UI_REFRESH_MS) return
      lastUiAt = now
      setFrame({ ...frameRef.current })
      const pinch = pinchRef.current
      const currentMs = pinch.run ? now - pinch.run.startedAt : 0
      const closeCurrentMs = pinch.closeSince > 0 ? now - pinch.closeSince : 0
      setHold({ currentMs, bestMs: Math.max(pinch.bestMs, currentMs), closeCurrentMs })

      const cutoff = now - ROLLING_WINDOW_MS
      const window = rollingRef.current.filter((entry) => entry.at >= cutoff)
      rollingRef.current = window
      const ratios = window.map((entry) => entry.sample.pinchRatio).filter((value): value is number => value !== null)
      const pips = window.map((entry) => entry.sample.indexPipDeg).filter((value): value is number => value !== null)
      const sortAsc = (values: number[]) => [...values].sort((a, b) => a - b)
      const med = (values: number[]) => (values.length === 0 ? null : sortAsc(values)[Math.floor(values.length / 2)])
      setRolling({
        seconds: window.length === 0 ? 0 : (now - window[0].at) / 1000,
        ratioMin: ratios.length === 0 ? null : Math.min(...ratios),
        ratioMax: ratios.length === 0 ? null : Math.max(...ratios),
        ratioMedian: med(ratios),
        pipMedian: med(pips),
        closeFrames: window.filter((entry) => entry.sample.pinchRatio !== null && entry.sample.pinchRatio <= PINCH_ENTER_RATIO).length,
      })
    }

    const loop = () => {
      if (disposed) return
      const video = videoRef.current
      if (recognizer && video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime
        const now = performance.now()
        const result: GestureRecognizerResult = recognizer.recognizeForVideo(video, now)
        const detected = classifyGesture(result, smoother)
        const tracked = tracker.update(detected, now)

        const landmarks = result.landmarks?.[0] as readonly Landmark[] | undefined
        const hand = landmarks ? describeHand(landmarks) : null
        const category = result.gestures?.[0]?.[0]
        const pinchConfirmed = detected?.mode === 'birthday'
        const geometryOk = hand?.pinchObserved === true

        // —— 捏合几何连续性：这一轮「几何成立」从什么时候开始、最佳保持了多久 ——
        const pinch = pinchRef.current
        if (geometryOk) {
          if (!pinch.run) {
            pinch.run = {
              startedAt: now,
              confirmedFrames: 0,
              observedFrames: 0,
              minRatio: hand.pinchRatio,
              maxPipDeg: hand.fingers.find((finger) => finger.key === 'index')?.pipAngleDeg ?? 0,
            }
          }
          const run = pinch.run
          run.observedFrames += 1
          if (pinchConfirmed) run.confirmedFrames += 1
          run.minRatio = Math.min(run.minRatio, hand.pinchRatio)
          run.maxPipDeg = Math.max(run.maxPipDeg, hand.fingers.find((finger) => finger.key === 'index')?.pipAngleDeg ?? 0)
          pinch.closeSince = 0
        } else {
          if (pinch.run) {
            pinch.bestMs = Math.max(pinch.bestMs, now - pinch.run.startedAt)
            pinch.run = null
          }
          // 退出门槛（迟滞）：距离已经进入阈值但伸直判据没过，算「差一点」。
          const ratio = hand?.pinchRatio ?? Number.POSITIVE_INFINITY
          if (ratio <= PINCH_ENTER_RATIO) {
            if (pinch.closeSince === 0) pinch.closeSince = now
          } else {
            pinch.closeSince = 0
          }
        }

        frameRef.current = {
          frames: frameRef.current.frames + 1,
          handDetected: Boolean(landmarks),
          category: category?.categoryName ?? (landmarks ? 'None' : '未检测到手'),
          mediaPipeConfidence: category?.score ?? 0,
          detectedMode: detected?.mode ?? null,
          detectedConfidence: detected?.confidence ?? 0,
          pinchConfirmed,
          trackerStatus: tracked.status,
          trackerProgress: tracked.progress,
          trackerCandidate: tracked.candidate,
          trackerUnstable: tracked.unstable,
          trackerTrigger: tracked.trigger,
          hand,
        }

        const sample: CalibrationSample = {
          category: frameRef.current.category,
          mode: detected?.mode ?? null,
          pinchRatio: hand?.pinchRatio ?? null,
          indexPipDeg: hand?.fingers.find((finger) => finger.key === 'index')?.pipAngleDeg ?? null,
          indexExtended: hand?.indexExtended ?? false,
          otherExtended: hand?.otherExtended ?? 0,
          pinchObserved: geometryOk,
          pinchConfirmed,
        }
        rollingRef.current.push({ at: now, sample })
        if (rollingRef.current.length > 600) rollingRef.current.splice(0, rollingRef.current.length - 600)
        recordingRef.current?.samples.push(sample)

        publish(now, false)
      }
      frameId = requestAnimationFrame(loop)
    }

    const start = async () => {
      setRecognizerState('loading')
      try {
        const vision = await FilesetResolver.forVisionTasks(WASM_PATH)
        const options = {
          baseOptions: { modelAssetPath: MODEL_PATH },
          runningMode: 'VIDEO',
          numHands: 1,
          minHandDetectionConfidence: 0.6,
          minHandPresenceConfidence: 0.6,
          minTrackingConfidence: 0.6,
        } as const
        let nextRecognizer: GestureRecognizer
        try {
          nextRecognizer = await GestureRecognizer.createFromOptions(vision, {
            ...options,
            baseOptions: { ...options.baseOptions, delegate: 'GPU' },
          })
        } catch {
          nextRecognizer = await GestureRecognizer.createFromOptions(vision, options)
        }
        if (disposed) {
          nextRecognizer.close()
          return
        }
        recognizer = nextRecognizer
        setRecognizerState('ready')
        frameId = requestAnimationFrame(loop)
      } catch (error) {
        if (!disposed) {
          setRecognizerState('failed')
          setCameraError(error instanceof Error ? error.message : String(error))
        }
      }
    }

    void start()
    return () => {
      disposed = true
      if (frameId !== null) cancelAnimationFrame(frameId)
      recognizer?.close()
      frameRef.current = emptyFrame
      pinchRef.current = { bestMs: 0, closeSince: 0, run: null }
      rollingRef.current = []
    }
  }, [camera])

  // 诊断结论所需的连续保持时长按真实时钟推进（推理循环只在有新帧时更新）。
  useEffect(() => {
    if (camera !== 'running') return undefined
    const timer = window.setInterval(() => {
      const now = performance.now()
      const pinch = pinchRef.current
      const currentMs = pinch.run ? now - pinch.run.startedAt : 0
      const closeCurrentMs = pinch.closeSince > 0 ? now - pinch.closeSince : 0
      setHold({ currentMs, bestMs: Math.max(pinch.bestMs, currentMs), closeCurrentMs })
    }, 200)
    return () => window.clearInterval(timer)
  }, [camera])

  const diagnosis = useMemo<Diagnosis>(() => {
    if (camera === 'error') {
      return { level: 'bad', headline: '摄像头打不开，先把授权/设备问题解决掉', detail: [cameraError || '未知错误'] }
    }
    if (camera !== 'running' || recognizerState !== 'ready') {
      return { level: 'idle', headline: '点「开始摄像头」后坐正、把手举到画面里', detail: ['本页只在本机内存里算，不录制、不上传、不保存。'] }
    }
    if (frame.frames < 5) {
      return { level: 'idle', headline: '识别器已就绪，正在等第一帧…', detail: [] }
    }
    if (!frame.handDetected || !frame.hand) {
      return {
        level: 'warn',
        headline: '画面里没有检测到手（或关键点不足 21 个）',
        detail: [`已跑 ${frame.frames} 帧`, '把手掌完整放进画面、离摄像头 40~80cm，光线别逆光。'],
      }
    }

    const hand = frame.hand
    const indexFinger = hand.fingers.find((finger) => finger.key === 'index')
    const heldSeconds = hold.currentMs / 1000
    const bestSeconds = Math.max(hold.bestMs, hold.currentMs) / 1000
    const detail: string[] = [
      `食指：腕-指尖/腕-PIP ${fmt(indexFinger?.wristTipRatio)}（需 > ${FINGER_EXTENSION_WRIST_RATIO}）、PIP ${fmt(indexFinger?.pipAngleDeg, 1)}°（需 ≥ ${FINGER_EXTENSION_MIN_ANGLE_DEG}°）→ ${hand.indexExtended ? '伸直 ✅' : '判为未伸直 ❌'}`,
      `其余三指伸直 ${hand.otherExtended} 指（需 ≥ ${MIN_OTHER_FINGERS_EXTENDED} 指）`,
      `捏合比值 ${fmt(hand.pinchRatio)}，进入阈值 ${PINCH_ENTER_RATIO}、退出阈值 ${PINCH_EXIT_RATIO} → ${hand.pinchRatio <= PINCH_ENTER_RATIO ? '已进入' : hand.pinchRatio <= PINCH_EXIT_RATIO ? '在迟滞区（保持住才算进入）' : '未进入（两指还不够近）'}`,
      `当前几何成立已连续保持 ${heldSeconds.toFixed(1)}s / 本轮最佳 ${bestSeconds.toFixed(1)}s（判「可稳定触发」需要 ≥ ${STABLE_HOLD_MS / 1000}s）`,
    ]

    // 1) 几何成立 + 平滑确认，且稳定保持 → 这个阈值在真实手上是能用的。
    if (frame.pinchConfirmed && hold.currentMs >= STABLE_HOLD_MS) {
      return {
        level: 'ok',
        headline: `当前阈值可稳定触发：捏合几何连续保持 ${heldSeconds.toFixed(1)}s，已超过产品保持窗口 ${HOLD_MS}ms 的要求`,
        detail,
      }
    }
    if (frame.pinchConfirmed) {
      return {
        level: 'ok',
        headline: `捏合已经成立，正在计时：还差 ${((STABLE_HOLD_MS - hold.currentMs) / 1000).toFixed(1)}s 就能给出「可稳定触发」结论`,
        detail,
      }
    }

    // 2) 几何成立但平滑器不认（窗口内过半帧、且比值 ≤ 退出阈值）。
    if (hand.pinchObserved) {
      return {
        level: 'warn',
        headline: `单帧几何成立，但平滑器还没确认（最近 ${PINCH_WINDOW_FRAMES} 帧需 ≥ ${PINCH_MIN_SAMPLES} 帧成立且中位比值 ≤ ${PINCH_EXIT_RATIO}）`,
        detail,
      }
    }

    // 3) 差一点：两指已经够近，是伸直判据挡住了 —— 这是本次校准最关心的失败形态。
    const nearMiss = hand.pinchRatio <= PINCH_ENTER_RATIO
    if (nearMiss) {
      const pipDeficit = FINGER_EXTENSION_MIN_ANGLE_DEG - (indexFinger?.pipAngleDeg ?? FINGER_EXTENSION_MIN_ANGLE_DEG)
      const ratioDeficit = (indexFinger?.wristTipRatio ?? FINGER_EXTENSION_WRIST_RATIO) - FINGER_EXTENSION_WRIST_RATIO
      const suggestsPipRelax = indexFinger !== undefined && indexFinger.pipAngleDeg < FINGER_EXTENSION_MIN_ANGLE_DEG && ratioDeficit > 0
      return {
        level: 'bad',
        headline: frame.trackerTrigger === 'birthday'
          ? '捏合已经触发过，但这一帧的判据又掉出来了（阈值贴线）'
          : `捏合差一点成立：两指距离已经达标（${fmt(hand.pinchRatio)} ≤ ${PINCH_ENTER_RATIO}），是伸直判据挡住了`,
        detail: [
          ...hand.blockers,
          suggestsPipRelax
            ? `供参考：把 FINGER_EXTENSION_MIN_ANGLE_DEG 从 ${FINGER_EXTENSION_MIN_ANGLE_DEG}° 放宽到 ${Math.floor(indexFinger?.pipAngleDeg ?? FINGER_EXTENSION_MIN_ANGLE_DEG)}° 这一帧就能通过（不要照单全收，要连做几次看最小值）`
            : `供参考：食指伸直角度不是瓶颈（PIP 阈值 ${FINGER_EXTENSION_MIN_ANGLE_DEG}°），瓶颈在「其余三指伸直数」`,
          `角度缺口 ${pipDeficit > 0 ? `${pipDeficit.toFixed(1)}°` : '无'}；腕比值余量 ${ratioDeficit.toFixed(3)}`,
          `本轮最佳保持 ${bestSeconds.toFixed(1)}s`,
        ],
      }
    }

    // 4) 两指距离根本没到。先分清是「手还没捏上」还是「手被误判成别的样子」。
    const mediaPipeMode = modeLabel[frame.detectedMode ?? ''] ?? frame.detectedMode ?? '无'
    if (frame.detectedMode && frame.detectedMode !== 'birthday') {
      return {
        level: 'warn',
        headline: `这一帧判成了 ${mediaPipeMode}，不是捏合`,
        detail: [...detail, '如果这是误判（你明明在捏合），请把这一帧的数值抄给 PM：误判比漏判更值得处理。'],
      }
    }
    return {
      level: 'idle',
      headline: `还没捏上：两指距离 ${fmt(hand.pinchRatio)} 需要 ≤ ${PINCH_ENTER_RATIO}（拇指与食指要真的贴上）`,
      detail: [
        ...detail,
        `差一点（距离已达标但判据未过）已连续 ${(hold.closeCurrentMs / 1000).toFixed(1)}s`,
      ],
    }
  }, [camera, cameraError, frame, hold, recognizerState])

  const report = useMemo(
    () => (summary
      ? formatSummaryReport(summary.summary, {
        thresholds: {
          pinchEnter: PINCH_ENTER_RATIO,
          pinchExit: PINCH_EXIT_RATIO,
          wristRatio: FINGER_EXTENSION_WRIST_RATIO,
          minAngleDeg: FINGER_EXTENSION_MIN_ANGLE_DEG,
        },
        seconds: summary.seconds,
      })
      : ''),
    [summary],
  )

  const handleToggleSampling = useCallback(() => {
    if (recordingRef.current) {
      const recording = recordingRef.current
      recordingRef.current = null
      setSampling(false)
      setSummary({
        summary: summarizeSamples(recording.samples, PINCH_ENTER_RATIO),
        seconds: (performance.now() - recording.startedAt) / 1000,
      })
      setCopyState('idle')
      return
    }
    recordingRef.current = { startedAt: performance.now(), samples: [] }
    setSampling(true)
    setSampleCount(0)
    setSummary(null)
    setCopyState('idle')
  }, [])

  const handleCopy = useCallback(async () => {
    if (!report) return
    const result = await copyText(report)
    setCopyState(result)
    if (result === 'manual') {
      reportRef.current?.focus()
      reportRef.current?.select()
    }
  }, [report])

  const hand = frame.hand

  return (
    <main className="cal-page">
      <header className="cal-header">
        <h1>手势自测校准台</h1>
        <p className="cal-sub">
          内部诊断页，只给开发者 / 验收者用。用来在**真实摄像头前**看：捏合手势的阈值到底合不合适。
          数值全部来自产品同一套实现（<code>gestureRecognition.ts</code>）的只读导出，判定逻辑与阈值一个字都没改。
        </p>
        <p className="cal-privacy">
          隐私：与产品页一致 —— 画面只在本机内存里参与计算，<strong>不录制、不上传、不保存</strong>任何视频帧或关键点；本页没有任何网络请求。
        </p>
      </header>

      <div className="cal-grid">
        <section className="cal-card cal-camera">
          <div className="cal-card-title">① 摄像头与识别</div>
          <div className="cal-controls">
            <button type="button" className="cal-button" onClick={() => void startCamera()} disabled={camera === 'running' || camera === 'requesting'} data-testid="start-camera">
              {camera === 'running' ? '摄像头已开启' : camera === 'requesting' ? '授权中…' : '开始摄像头'}
            </button>
            <button type="button" className="cal-button cal-button-ghost" onClick={stopCamera} disabled={camera !== 'running'} data-testid="stop-camera">
              停止
            </button>
            <span className={`cal-badge cal-badge-${camera}`} data-testid="camera-state">摄像头：{camera}</span>
            <span className={`cal-badge cal-badge-${recognizerState}`} data-testid="recognizer-state">识别器：{recognizerState}</span>
          </div>
          {cameraError && <p className="cal-error">错误：{cameraError}</p>}
          <div className="cal-video-wrap">
            {/* 镜像显示与产品页一致：像照镜子，抬右手画面里也是右边。 */}
            <video ref={videoRef} autoPlay playsInline muted className="cal-video" data-testid="video" />
            {camera !== 'running' && <div className="cal-video-hint">点上面的「开始摄像头」（浏览器要求用户手势）</div>}
          </div>
          <dl className="cal-kv">
            <div><dt>已处理帧数</dt><dd data-testid="frames">{frame.frames}</dd></div>
            <div><dt>检测到手</dt><dd data-testid="hand-detected">{hand ? '是' : '否'}</dd></div>
            <div><dt>MediaPipe 类别</dt><dd data-testid="category">{frame.category}</dd></div>
            <div><dt>MediaPipe 置信度</dt><dd data-testid="category-score">{fmt(frame.mediaPipeConfidence, 3)}（阈值 {CONFIDENCE_THRESHOLD}）</dd></div>
            <div><dt>classifyGesture 结果</dt><dd data-testid="detected-mode">{frame.detectedMode ?? 'null'}</dd></div>
            <div><dt>识别置信度</dt><dd data-testid="detected-confidence">{fmt(frame.detectedConfidence, 3)}</dd></div>
            <div><dt>平滑后捏合成立</dt><dd data-testid="pinch-confirmed">{frame.pinchConfirmed ? '是' : '否'}</dd></div>
          </dl>
        </section>

        <section className="cal-card cal-verdict">
          <div className="cal-card-title">② 自动诊断结论</div>
          <p className={`cal-verdict-line cal-verdict-${diagnosis.level}`} data-testid="verdict" data-level={diagnosis.level}>
            {diagnosis.headline}
          </p>
          <ul className="cal-verdict-detail" data-testid="verdict-detail">
            {diagnosis.detail.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <div className="cal-hold">
            <span>几何成立连续保持</span>
            <progress max={STABLE_HOLD_MS} value={Math.min(hold.currentMs, STABLE_HOLD_MS)} />
            <strong data-testid="hold-current">{(hold.currentMs / 1000).toFixed(1)}s</strong>
            <span>/ 最佳 {(Math.max(hold.bestMs, hold.currentMs) / 1000).toFixed(1)}s</span>
            <span>（≥ {STABLE_HOLD_MS / 1000}s 判定「可稳定触发」）</span>
          </div>
        </section>

        <section className="cal-card cal-card-half">
          <div className="cal-card-title">③ 捏合几何（本页核心数值）</div>
          <dl className="cal-kv">
            <div>
              <dt>pinchRatio = 拇指尖-食指尖 / 掌尺度</dt>
              <dd data-testid="pinch-ratio">{fmt(hand?.pinchRatio)}</dd>
            </div>
            <div><dt>进入阈值 PINCH_ENTER_RATIO</dt><dd data-testid="pinch-enter">{PINCH_ENTER_RATIO}</dd></div>
            <div><dt>退出阈值 PINCH_EXIT_RATIO</dt><dd data-testid="pinch-exit">{PINCH_EXIT_RATIO}</dd></div>
            <div>
              <dt>与阈值的关系</dt>
              <dd data-testid="pinch-zone">
                {hand === null
                  ? '—'
                  : hand.pinchZone === 'below-enter'
                    ? `低于进入阈值 ✅（${fmt(hand.pinchRatio)} ≤ ${PINCH_ENTER_RATIO}）`
                    : hand.pinchZone === 'hysteresis'
                      ? `在迟滞区（${PINCH_ENTER_RATIO} < ${fmt(hand.pinchRatio)} ≤ ${PINCH_EXIT_RATIO}）`
                      : `高于退出阈值 ❌（${fmt(hand.pinchRatio)} > ${PINCH_EXIT_RATIO}）`}
              </dd>
            </div>
            <div><dt>两指距离 / 掌尺度原值</dt><dd>{fmt(hand?.pinchDistance, 4)} / {fmt(hand?.palmScale, 4)}</dd></div>
            <div><dt>单帧捏合观测 pinchObserved</dt><dd data-testid="pinch-observed">{hand ? (hand.pinchObserved ? '成立' : '不成立') : '—'}</dd></div>
            <div><dt>食指是否伸直 indexExtended</dt><dd data-testid="index-extended">{hand ? (hand.indexExtended ? '伸直' : '未伸直') : '—'}</dd></div>
            <div><dt>其余三指伸直数 / 下限</dt><dd data-testid="other-extended">{hand ? `${hand.otherExtended} / ${hand.minOtherFingersExtended}` : '—'}</dd></div>
            <div><dt>阻塞原因（逐条）</dt><dd data-testid="blockers">{hand?.blockers.length ? hand.blockers.join('；') : '无'}</dd></div>
          </dl>
        </section>

        <section className="cal-card cal-card-half">
          <div className="cal-card-title">④ 四指伸直判据逐指明细</div>
          <p className="cal-note">
            伸直 = 腕-指尖 / 腕-PIP &gt; 1.02（FINGER_EXTENSION_WRIST_RATIO）且 PIP 夹角 ≥ 130°（FINGER_EXTENSION_MIN_ANGLE_DEG）。
            拇指不参与伸直判定（它没有 PIP），这里列出仅供对照。食指另有 INDEX_EXTENSION_MIN_RATIO = {INDEX_EXTENSION_MIN_RATIO} 的说明口径。
          </p>
          <table className="cal-table" data-testid="finger-table">
            <thead>
              <tr><th>手指</th><th>腕-指尖/腕-PIP</th><th>PIP 夹角</th><th>伸直？</th><th>计入判定</th></tr>
            </thead>
            <tbody>
              {(hand?.fingers ?? []).map((finger) => (
                <tr key={finger.key} data-testid={`finger-row-${finger.key}`}>
                  <td>{finger.label}</td>
                  <td data-testid={`finger-ratio-${finger.key}`}>
                    {fmt(finger.wristTipRatio)}
                    <span className={finger.wristTipRatio > FINGER_EXTENSION_WRIST_RATIO ? 'cal-ok' : 'cal-no'}>
                      {finger.wristTipRatio > FINGER_EXTENSION_WRIST_RATIO ? ' ✅' : ' ❌'}
                    </span>
                  </td>
                  <td data-testid={`finger-angle-${finger.key}`}>
                    {fmt(finger.pipAngleDeg, 1)}°
                    <span className={finger.pipAngleDeg >= FINGER_EXTENSION_MIN_ANGLE_DEG ? 'cal-ok' : 'cal-no'}>
                      {finger.pipAngleDeg >= FINGER_EXTENSION_MIN_ANGLE_DEG ? ' ✅' : ' ❌'}
                    </span>
                  </td>
                  <td data-testid={`finger-extended-${finger.key}`}>{finger.extended ? '伸直' : '未伸直'}</td>
                  <td>{finger.countsTowardExtension ? '是' : '否（参考）'}</td>
                </tr>
              ))}
              {hand === null && (
                <tr><td colSpan={5}>还没有可用的手部关键点</td></tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="cal-card">
          <div className="cal-card-title">⑤ 保持进度（GestureStabilityTracker）</div>
          <dl className="cal-kv">
            <div><dt>status</dt><dd data-testid="tracker-status">{frame.trackerStatus}</dd></div>
            <div><dt>progress</dt><dd data-testid="tracker-progress">{frame.trackerProgress.toFixed(3)}</dd></div>
            <div><dt>candidate</dt><dd data-testid="tracker-candidate">{frame.trackerCandidate ?? 'null'}</dd></div>
            <div><dt>unstable</dt><dd data-testid="tracker-unstable">{frame.trackerUnstable ? '是（保持窗口 +200ms）' : '否'}</dd></div>
            <div><dt>trigger</dt><dd data-testid="tracker-trigger">{frame.trackerTrigger ?? 'null'}</dd></div>
          </dl>
          <progress max={1} value={frame.trackerProgress} />
          <p className="cal-note">
            产品侧参数（同样直接来自实现导出）：HOLD_MS = {HOLD_MS}、COOLDOWN_MS = {COOLDOWN_MS}、抖动惩罚 {UNSTABLE_HOLD_PENALTY_MS}ms、平滑窗口 {PINCH_WINDOW_FRAMES} 帧 / 至少 {PINCH_MIN_SAMPLES} 帧。
          </p>
        </section>

        <section className="cal-card">
          <div className="cal-card-title">⑥ 最近 {ROLLING_WINDOW_MS / 1000} 秒滚动统计</div>
          <dl className="cal-kv">
            <div><dt>窗口长度</dt><dd data-testid="rolling-seconds">{rolling ? `${rolling.seconds.toFixed(1)}s` : '—'}</dd></div>
            <div><dt>pinchRatio 最小 / 中位 / 最大</dt><dd data-testid="rolling-ratio">{rolling ? `${fmt(rolling.ratioMin)} / ${fmt(rolling.ratioMedian)} / ${fmt(rolling.ratioMax)}` : '—'}</dd></div>
            <div><dt>食指 PIP 中位角</dt><dd data-testid="rolling-pip">{rolling ? `${fmt(rolling.pipMedian, 1)}°` : '—'}</dd></div>
            <div><dt>距离达标帧数</dt><dd data-testid="rolling-close">{rolling ? rolling.closeFrames : 0}</dd></div>
          </dl>
        </section>

        <section className="cal-card cal-card-wide">
          <div className="cal-card-title">⑦ 采样汇总（一键复制回贴给 PM）</div>
          <div className="cal-controls">
            <button type="button" className="cal-button" onClick={handleToggleSampling} data-testid="toggle-sampling">
              {sampling ? '停止采样并出统计' : '开始采样'}
            </button>
            <button type="button" className="cal-button cal-button-ghost" onClick={() => void handleCopy()} disabled={!report} data-testid="copy-report">
              复制统计结果
            </button>
            <span className="cal-badge" data-testid="sample-count">已采样 {sampling ? sampleCount : summary?.summary.frames ?? 0} 帧</span>
            {copyState === 'clipboard' && <span className="cal-badge cal-badge-ok" data-testid="copy-state">已复制到剪贴板</span>}
            {copyState === 'manual' && <span className="cal-badge cal-badge-warn" data-testid="copy-state">剪贴板不可用，已全选下面文本，请按 Ctrl+C</span>}
          </div>
          {summary && (
            <ul className="cal-summary" data-testid="summary">
              <li>采样时长 {summary.seconds.toFixed(1)}s，共 {summary.summary.frames} 帧（可用几何 {summary.summary.framesWithGeometry} 帧）</li>
              <li>类别分布：{summary.summary.categoryCounts.map((entry) => `${entry.name}×${entry.count}`).join('，') || '无'}</li>
              <li>classifyGesture 分布：{summary.summary.modeCounts.map((entry) => `${entry.name}×${entry.count}`).join('，') || '无'}</li>
              <li>捏合成立帧数（单帧观测 / 平滑确认）：{summary.summary.observedFrames} / {summary.summary.confirmedFrames}</li>
              <li>捏合成立时食指 PIP 角 min/中位/max：{summary.summary.confirmedPip ? `${summary.summary.confirmedPip.min.toFixed(1)}° / ${summary.summary.confirmedPip.median.toFixed(1)}° / ${summary.summary.confirmedPip.max.toFixed(1)}°（n=${summary.summary.confirmedPip.samples}）` : '无样本'}</li>
              <li>差一点成立（距离达标但判据未过）帧数：{summary.summary.nearMissFrames}{summary.summary.nearMissPip ? `，其中食指 PIP 中位 ${summary.summary.nearMissPip.median.toFixed(1)}°` : ''}</li>
              <li>差一点成立卡在哪一条：{summary.summary.nearMissReasons.map((entry) => `${entry.reason}×${entry.count}`).join('，') || '无'}</li>
            </ul>
          )}
          <textarea
            ref={reportRef}
            className="cal-report"
            data-testid="report"
            readOnly
            value={report}
            placeholder="按「开始采样」→ 在镜头前做各手势 → 按「停止采样并出统计」，这里会出现可复制的纯文本报告。"
            rows={12}
          />
        </section>

        <section className="cal-card cal-card-wide">
          <div className="cal-card-title">⑧ 怎么用（3 分钟出结论）</div>
          <ol className="cal-steps">
            <li>点「开始摄像头」，把手举到画面里（40~80cm），先张开手掌确认④里四指都判成「伸直」。</li>
            <li>点「开始采样」，然后依次做：张开手掌 → 拇指食指捏合并保持 3 秒 → 握拳 → 竖拇指，每种做 2~3 次。</li>
            <li>回到「停止采样并出统计」，读②的诊断结论：重点是「捏合成立时食指 PIP 角中位数」和「差一点成立时卡在哪一条」。</li>
            <li>按「复制统计结果」把纯文本贴回给 PM；如果要放宽阈值，请附上这一份原始数值。</li>
          </ol>
          <p className="cal-note">
            阈值对照（产品当前生效值，本页只读不改）：捏合进入 {PINCH_ENTER_RATIO} / 退出 {PINCH_EXIT_RATIO}；
            伸直腕比值 &gt; {FINGER_EXTENSION_WRIST_RATIO}；伸直 PIP 角 ≥ {FINGER_EXTENSION_MIN_ANGLE_DEG}°；
            其余三指至少 {MIN_OTHER_FINGERS_EXTENDED} 指伸直；置信度 ≥ {CONFIDENCE_THRESHOLD}。
          </p>
        </section>
      </div>
    </main>
  )
}
