import { useEffect, useRef, type RefObject } from 'react'
import { FilesetResolver, GestureRecognizer, type GestureRecognizerResult } from '@mediapipe/tasks-vision'
import {
  GestureStabilityTracker,
  PinchSmoother,
  classifyGesture,
  type GestureMode,
  type GestureStatus,
} from './gestureRecognition'
import { publishGestureFeedback, type GestureFeedbackState } from './gestureFeedbackState'

export type { GestureMode, GestureStatus } from './gestureRecognition'

type GestureControllerProps = {
  videoRef: RefObject<HTMLVideoElement | null>
  enabled: boolean
  onGesture: (mode: GestureMode) => void
  onStatus: (status: GestureStatus) => void
  /**
   * 每帧就地更新的反馈心跳对象（由 App 持有，GestureFeedback 订阅）。刻意不走 React
   * state：进度条每帧都在变，setState 会让整个页面每秒重渲染几十次。
   */
  feedback: GestureFeedbackState
}

const assetPath = (relativePath: string) => `${import.meta.env.BASE_URL}${relativePath}`
const WASM_PATH = assetPath('mediapipe/wasm')
const MODEL_PATH = assetPath('mediapipe/gesture_recognizer.task')

export function GestureController({ videoRef, enabled, onGesture, onStatus, feedback }: GestureControllerProps) {
  const onGestureRef = useRef(onGesture)
  const onStatusRef = useRef(onStatus)
  const feedbackRef = useRef(feedback)

  useEffect(() => {
    onGestureRef.current = onGesture
    onStatusRef.current = onStatus
    feedbackRef.current = feedback
  }, [onGesture, onStatus, feedback])

  useEffect(() => {
    if (!enabled) {
      onStatusRef.current('idle')
      publishGestureFeedback(feedbackRef.current, { status: 'idle', mode: null, confidence: 0, progress: 0, unstable: false })
      return undefined
    }

    let disposed = false
    let frameId: number | null = null
    let recognizer: GestureRecognizer | null = null
    let lastVideoTime = -1
    let currentStatus: GestureStatus | null = null
    const tracker = new GestureStabilityTracker()
    /**
     * 捏合平滑器只消费**同一次** recognizeForVideo 已经给出的关键点，因此每帧仍然只有
     * 一次推理 —— 平滑不带来额外模型调用，也不增加任何网络请求。
     */
    const pinchSmoother = new PinchSmoother()

    const updateStatus = (status: GestureStatus) => {
      if (status === currentStatus) return
      currentStatus = status
      onStatusRef.current(status)
    }

    const stop = () => {
      if (frameId !== null) cancelAnimationFrame(frameId)
      frameId = null
      recognizer?.close()
      recognizer = null
    }

    const loop = () => {
      if (disposed) return
      const video = videoRef.current
      if (recognizer && video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime
        const now = performance.now()
        // 每帧最多一次推理：结果同时喂给分类器（含捏合平滑）与反馈 UI。
        const result: GestureRecognizerResult = recognizer.recognizeForVideo(video, now)
        const detected = classifyGesture(result, pinchSmoother)
        const tracked = tracker.update(detected, now)
        if (tracked.trigger) onGestureRef.current(tracked.trigger)
        updateStatus(tracked.status)
        publishGestureFeedback(feedbackRef.current, {
          status: tracked.status,
          mode: detected?.mode ?? null,
          confidence: detected?.confidence ?? 0,
          progress: tracked.progress,
          unstable: tracked.unstable,
        })
      }
      frameId = requestAnimationFrame(loop)
    }

    const start = async () => {
      updateStatus('loading')
      publishGestureFeedback(feedbackRef.current, { status: 'loading', mode: null, confidence: 0, progress: 0, unstable: false })
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
        updateStatus('ready')
        publishGestureFeedback(feedbackRef.current, { status: 'ready', mode: null, confidence: 0, progress: 0, unstable: false })
        frameId = requestAnimationFrame(loop)
      } catch {
        if (!disposed) {
          updateStatus('unavailable')
          publishGestureFeedback(feedbackRef.current, { status: 'unavailable', mode: null, confidence: 0, progress: 0, unstable: false })
        }
      }
    }

    void start()
    return () => {
      disposed = true
      stop()
      publishGestureFeedback(feedbackRef.current, { status: 'idle', mode: null, confidence: 0, progress: 0, unstable: false })
    }
  }, [enabled, videoRef])

  return null
}
