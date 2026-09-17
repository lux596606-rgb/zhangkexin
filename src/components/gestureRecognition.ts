export type GestureMode = 'galaxy' | 'birthday' | 'pig' | 'closing'

export type GestureStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'holding'
  | 'recognized'
  | 'unrecognized'
  | 'unavailable'

type Landmark = {
  x: number
  y: number
}

type GestureCategory = {
  categoryName: string
  score: number
}

export type GestureRecognitionInput = {
  landmarks?: readonly (readonly Landmark[])[]
  gestures?: readonly (readonly GestureCategory[])[]
}

export type DetectedGesture = {
  mode: GestureMode
  confidence: number
}

export const CONFIDENCE_THRESHOLD = 0.64
export const HOLD_MS = 700
export const COOLDOWN_MS = 500
export const RELEASE_MS = 250

const modeByCategory: Record<string, GestureMode> = {
  Open_Palm: 'galaxy',
  Closed_Fist: 'pig',
  Thumb_Up: 'closing',
}

const distance = (a: Landmark, b: Landmark) => Math.hypot(a.x - b.x, a.y - b.y)
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

function isFingerExtended(landmarks: readonly Landmark[], mcpIndex: number, pipIndex: number, tipIndex: number) {
  const wrist = landmarks[0]
  const mcp = landmarks[mcpIndex]
  const pip = landmarks[pipIndex]
  const tip = landmarks[tipIndex]
  if (!wrist || !mcp || !pip || !tip) return false

  return distance(wrist, tip) > distance(wrist, pip) * 1.12
    && distance(mcp, tip) > distance(mcp, pip) * 1.35
}

function classifyPinch(landmarks: readonly Landmark[]): DetectedGesture | null {
  const wrist = landmarks[0]
  const thumbTip = landmarks[4]
  const indexTip = landmarks[8]
  const middleBase = landmarks[9]
  if (!wrist || !thumbTip || !indexTip || !middleBase) return null

  const otherFingersExtended = [
    isFingerExtended(landmarks, 9, 10, 12),
    isFingerExtended(landmarks, 13, 14, 16),
    isFingerExtended(landmarks, 17, 18, 20),
  ].every(Boolean)
  if (!otherFingersExtended) return null

  const palmScale = Math.max(distance(wrist, middleBase), 0.001)
  const pinchRatio = distance(thumbTip, indexTip) / palmScale
  const confidence = clamp(1 - pinchRatio, 0, 1)
  if (pinchRatio > 0.36 || confidence < CONFIDENCE_THRESHOLD) return null

  return { mode: 'birthday', confidence }
}

export function classifyGesture(result: GestureRecognitionInput): DetectedGesture | null {
  const category = result.gestures?.[0]?.[0]
  const modelMode = category ? modeByCategory[category.categoryName] : undefined

  // Reliable built-in categories take precedence so their landmarks cannot be
  // reinterpreted as the custom pinch gesture.
  if (category && modelMode) {
    if (category.score < CONFIDENCE_THRESHOLD) return null
    return { mode: modelMode, confidence: category.score }
  }

  const landmarks = result.landmarks?.[0]
  return landmarks ? classifyPinch(landmarks) : null
}

export type GestureTrackerResult = {
  status: Extract<GestureStatus, 'ready' | 'holding' | 'recognized' | 'unrecognized'>
  trigger: GestureMode | null
}

type GestureTrackerOptions = {
  holdMs: number
  cooldownMs: number
  releaseMs: number
  recognizedMs: number
}

const defaultTrackerOptions: GestureTrackerOptions = {
  holdMs: HOLD_MS,
  cooldownMs: COOLDOWN_MS,
  releaseMs: RELEASE_MS,
  recognizedMs: 850,
}

export class GestureStabilityTracker {
  private readonly options: GestureTrackerOptions
  private candidateMode: GestureMode | null = null
  private candidateSince = 0
  private lockedMode: GestureMode | null = null
  private absentSince: number | null = null
  private lastTriggeredAt = Number.NEGATIVE_INFINITY

  constructor(options: Partial<GestureTrackerOptions> = {}) {
    this.options = { ...defaultTrackerOptions, ...options }
  }

  reset() {
    this.candidateMode = null
    this.candidateSince = 0
    this.lockedMode = null
    this.absentSince = null
    this.lastTriggeredAt = Number.NEGATIVE_INFINITY
  }

  update(detected: DetectedGesture | null, now: number): GestureTrackerResult {
    if (!detected || detected.confidence < CONFIDENCE_THRESHOLD) {
      this.candidateMode = null
      this.candidateSince = 0
      if (this.absentSince === null) this.absentSince = now
      if (this.lockedMode && now - this.absentSince >= this.options.releaseMs) {
        this.lockedMode = null
      }
      return { status: 'unrecognized', trigger: null }
    }

    this.absentSince = null
    if (detected.mode === this.lockedMode) {
      this.candidateMode = null
      this.candidateSince = 0
      const status = now - this.lastTriggeredAt < this.options.recognizedMs ? 'recognized' : 'ready'
      return { status, trigger: null }
    }

    if (detected.mode !== this.candidateMode) {
      this.candidateMode = detected.mode
      this.candidateSince = now
      return { status: 'holding', trigger: null }
    }

    const heldLongEnough = now - this.candidateSince >= this.options.holdMs
    const cooldownComplete = now - this.lastTriggeredAt >= this.options.cooldownMs
    if (!heldLongEnough || !cooldownComplete) return { status: 'holding', trigger: null }

    this.lockedMode = detected.mode
    this.candidateMode = null
    this.candidateSince = 0
    this.lastTriggeredAt = now
    return { status: 'recognized', trigger: detected.mode }
  }
}
