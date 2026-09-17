import { useEffect, useRef, type RefObject } from 'react'
import { FilesetResolver, GestureRecognizer, type GestureRecognizerResult } from '@mediapipe/tasks-vision'
import {
  GestureStabilityTracker,
  classifyGesture,
  type GestureMode,
  type GestureStatus,
} from './gestureRecognition'

export type { GestureMode, GestureStatus } from './gestureRecognition'

type GestureControllerProps = {
  videoRef: RefObject<HTMLVideoElement | null>
  enabled: boolean
  onGesture: (mode: GestureMode) => void
  onStatus: (status: GestureStatus) => void
}

const assetPath = (relativePath: string) => `${import.meta.env.BASE_URL}${relativePath}`
const WASM_PATH = assetPath('mediapipe/wasm')
const MODEL_PATH = assetPath('mediapipe/gesture_recognizer.task')

export function GestureController({ videoRef, enabled, onGesture, onStatus }: GestureControllerProps) {
  const onGestureRef = useRef(onGesture)
  const onStatusRef = useRef(onStatus)

  useEffect(() => {
    onGestureRef.current = onGesture
    onStatusRef.current = onStatus
  }, [onGesture, onStatus])

  useEffect(() => {
    if (!enabled) {
      onStatusRef.current('idle')
      return undefined
    }

    let disposed = false
    let frameId: number | null = null
    let recognizer: GestureRecognizer | null = null
    let lastVideoTime = -1
    let currentStatus: GestureStatus | null = null
    const tracker = new GestureStabilityTracker()

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
        const result: GestureRecognizerResult = recognizer.recognizeForVideo(video, now)
        const tracked = tracker.update(classifyGesture(result), now)
        if (tracked.trigger) onGestureRef.current(tracked.trigger)
        updateStatus(tracked.status)
      }
      frameId = requestAnimationFrame(loop)
    }

    const start = async () => {
      updateStatus('loading')
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
        frameId = requestAnimationFrame(loop)
      } catch {
        if (!disposed) updateStatus('unavailable')
      }
    }

    void start()
    return () => {
      disposed = true
      stop()
    }
  }, [enabled, videoRef])

  return null
}
