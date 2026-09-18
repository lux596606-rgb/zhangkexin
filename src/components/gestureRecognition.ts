export type GestureMode = 'galaxy' | 'birthday' | 'pig' | 'closing'

export type GestureStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'holding'
  | 'recognized'
  | 'unrecognized'
  | 'unavailable'

/**
 * MediaPipe 的手部关键点。除了归一化图像坐标 x/y，识别器还会给出相对手腕的
 * 深度 z —— 捏合判定必须用得上它，否则手掌转向侧面（透视缩短）时所有平面距离
 * 都会被压缩，捏合比值随之失真。
 */
export type Landmark = {
  x: number
  y: number
  z?: number
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

/**
 * 保持窗口中途「识别不到」的容忍时长：真人实测发现，真实手势识别是抖动的 —— 总有若干帧
 * 一个手势都认不出来。旧实现一遇到这种帧就把候选姿势与已累计的保持时间全部清零，于是
 * HOLD_MS 的进度永远攒不满，四个手势都表现为「有时没反应」（实测：连续做同一个手势、
 * 每 4 帧掉 1 帧，6 秒内 progress 一直停在 0.00，一次都没触发）。这个窗口就是给那几帧兜底的。
 *
 * 取 150ms 的理由：
 * - 摄像头 30fps 时一帧 ≈ 33ms，150ms ≈ 连续丢掉 4~5 帧；MediaPipe 单帧推理在普通笔记本上
 *   偶尔会占满 30~50ms，因此「连丢 3~4 帧」正是最常见的抖动形态，100ms 会漏掉一部分。
 * - 不取更大（200ms+）：容忍窗口越长，越可能把「人已经松手/换姿势」误当成同一次保持，
 *   而且下面的「丢失不计入保持时间」意味着窗口越长、总时长上限越高。
 * - 必须小于 RELEASE_MS(250)：这样「跟踪器愿意替候选兜底的丢失」总比「解锁已锁定手势的窗口」
 *   更短，两种「短暂丢失」的语义保持在同一个量级上，不会互相串味。
 * - 150 < HOLD_MS/4：单次抖动最多给保持窗口加约 1/5 的墙钟时间（700 → 850ms），
 *   仍在需求 3.2「稳定约 0.6-1 秒后切换」区间内。
 *
 * 关键约束：容忍窗口内**只保留进度，不把丢失的时间算成保持时间**。判定用的
 * `now - candidateSince - candidateLostMs` 扣掉了全部丢失时长，所以「保持 HOLD_MS」
 * 始终等于「真正被识别到 HOLD_MS」——总时长只会变长，不会变短。
 */
export const LOSS_TOLERANCE_MS = 150

/**
 * 抖动抑制参数：连续多次「还没站稳就换姿势」的识别会让保持窗口略微变长，避免
 * 手在摄像头前晃动时画面反复切换。
 * - UNSTABLE_STREAK：短时间内连续这么多次候选姿势更替，才视为「手势不稳定」。
 *   取 3 是因为一次真实的手势过渡最多只会产生 1 次更替（A 直接换成 B），连换 3 次
 *   必然夹杂了识别不到的噪声帧。
 * - UNSTABLE_HOLD_PENALTY_MS：不稳定时额外要求的保持时间。700 + 200 = 900ms，
 *   仍在需求 3.2「稳定约 0.6-1 秒后切换」区间内，正常做出手势不会被明显推迟。
 * - UNSTABLE_WINDOW_MS：连续更替的计数窗口。1500ms 约等于两个保持窗口，足够判断
 *   「这段时间一直在抖」。
 */
export const UNSTABLE_STREAK = 3
export const UNSTABLE_HOLD_PENALTY_MS = 200
export const UNSTABLE_WINDOW_MS = 1500

/**
 * 自定义捏合判定的阈值。全部是「相对量」，与手离摄像头的远近无关。
 * - PINCH_ENTER_RATIO：拇指尖-食指尖距离 / 掌尺度 ≤ 0.42 才算捏合。真实捏合时两指
 *   几乎贴合，实测比值落在 0.05~0.25；取 0.42 而不是更小，是因为 MediaPipe 的
 *   21 点在这两根手指末端本身就有一点抖动，阈值太紧会漏判「捏得不够用力」的人。
 * - PINCH_EXIT_RATIO：略宽于进入阈值（0.52），构成迟滞，避免在临界点反复开合。
 * - INDEX_EXTENSION_MIN_RATIO：食指必须基本伸直（与 FINGER_EXTENSION_WRIST_RATIO 同值）。
 *   这条是**捏合与握拳之间唯一的几何分界线**：握拳时食指尖蜷回掌心，食指尖到手腕的距离
 *   会被压缩到与中节长度相当（比值 0.864 < 1.02，FK 夹具实测），于是捏合直接不成立 ——
 *   攥拳（哪怕拇指食指贴在一起，此时捏合比值 ≈ 0）仍然归 Closed_Fist 猪头。
 *
 * 这里曾经还有一条 `MIN_OTHER_FINGERS_EXTENDED = 2`（其余三指至少两指伸直），**已删除**：
 * 它在真人手上恒不成立 —— 真人捏合时中指/无名指/小指是自然弯曲的（像捏起一个小东西），
 * 伸直数实测是 0~1，于是这条门槛把捏合**恒定判负**（FK 实测：食指 165° 伸直 + 两指尖精确
 * 贴合 + 其余三指自然弯曲 → 旧判据 null、新判据 birthday）。它本想提供的「这是捏合不是握拳」
 * 的证据，由上面的食指伸直判据独立且更可靠地提供（见 FINGER_EXTENSION_MIN_ANGLE_DEG 的扫描）。
 * 其余三指的伸直数现在**只是一项诊断量**（`HandDiagnostics.otherExtended`），不参与任何判定。
 */
export const PINCH_ENTER_RATIO = 0.42
export const PINCH_EXIT_RATIO = 0.52
export const INDEX_EXTENSION_MIN_RATIO = 1.02

/**
 * 单根手指「伸直」的判据，两条同时满足才算伸直，两者都是相对量：
 * 1. 指尖离手腕的距离，比中节离手腕的距离大 FINGER_EXTENSION_WRIST_RATIO 倍 ——
 *    手指蜷起来时指尖会缩回掌心，这个比值直接掉到 1 以下。
 * 2. 食指/中指/无名指/小指的 PIP 关节夹角不小于 FINGER_EXTENSION_MIN_ANGLE_DEG ——
 *    蜷指时该关节必然折弯，这是最直接的几何证据。
 * 用三维距离（含 MediaPipe 的 z）而不是平面距离：手掌转向侧面时平面投影会整体缩短，
 * 用三维量可以抵消这种透视变形。
 */
export const FINGER_EXTENSION_WRIST_RATIO = 1.02

/**
 * PIP 伸直阈值：130°（原为 145°，按前向运动学夹具的实测扫描下调）。
 *
 * 夹具与扫描见 `gestureRecognition.robustness.test.ts`（FK 生成关键点，写进用例的角度就是
 * 关键点真实夹角；掌尺度 = |腕 0 → 中指根 9| ≈ 0.300）。「两指尖恰好贴合」那一列是把拇指
 * 尖精确放在食指尖上时，拇指必须有多长（单位 = 掌尺度；真人拇指 0.66~0.71，夹具里张开的
 * 手实测 0.72）：
 *
 * | 食指 PIP | 腕-指尖/腕-PIP（需 >1.02） | 两指尖贴合所需拇指长度 | 旧 145° | 新 130° |
 * | --- | --- | --- | --- | --- |
 * | 178° | 1.364 | 1.16 掌尺度 | PINCH | PINCH |
 * | 165° | 1.365 | 1.15 掌尺度 | PINCH | PINCH |
 * | 150° | 1.349 | 1.12 掌尺度 | PINCH | PINCH |
 * | 145° | 1.340 | 1.10 掌尺度 | PINCH（贴线） | PINCH |
 * | 140° | 1.329 | 1.08 掌尺度 | **null（漏判）** | PINCH |
 * | 130° | 1.301 | 1.04 掌尺度 | null（漏判） | PINCH（贴线） |
 * | 120° | 1.266 | 1.00 掌尺度 | null | null |
 * | 90° | 1.121 | 0.82 掌尺度 | null | null |
 * | 70° | 1.002 | 0.68 掌尺度 | null（腕比值也跌破） | null |
 * | 40°（握拳夹具实测） | 0.864 | 0.44 掌尺度 | null | null |
 *
 * 漏判 vs 误判的取舍（都按上表实测，不凭感觉）：
 * - **这个数字在 75°~180° 区间里是唯一约束**：腕-指尖/腕-PIP 要到 70° 才跌破 1.02，
 *   所以「算不算伸直」几乎完全由角度阈值决定。
 * - 真人拇指 0.66~0.71 掌尺度，而 145° 那一行需要 1.10 掌尺度 —— 也就是说食指完全伸直时
 *   真人根本捏不上（差着一大截）。换成「拇指全力伸展后两指尖的最小可达比值」：拇指 0.66 掌
 *   尺度时只有食指 PIP ≤ 135° 才可能进入 0.42 的进入阈值，0.71 掌尺度时是 ≤ 155°。
 *   真实捏合因此落在 90°~135°，而这恰好被 145° 全部判负 —— 这就是「真人捏合漏判」的量化来源
 *   （夹具上一版那个 139° 的临界样本是同一个原因）。
 * - 取 130°：比「真实拇指可达」的 135° 再留 5° 余量，收下 130°~145° 的轻微弯曲捏合；
 *   离握拳实测的 40° 还有 90° 余量（用例显式断言这个余量 ≥ 60°）。
 * - **不继续下调**（例如 110°/90°）：删掉「其余三指伸直数」那道门槛后，食指伸直判据成了
 *   捏合与握拳之间**唯一**的几何分界线，再降就是用误判换漏判。握拳夹具实测食指 PIP 40°，
 *   130° 与它隔着 90° 余量（用例显式断言这个余量 ≥ 60°）；一路降到 90° 就等于把「攥着拳头、
 *   拇指尖恰好碰到蜷起的食指尖」也认成捏合。剩余 90°~130° 的漏判区间不是阈值能解决的，需要
 *   改判据本体（例如「食指尖必须是离拇指尖最近的指尖」），已作为遗留风险上报，不在本次改动范围内。
 * - 误判侧不靠这一条兜底：握拳夹具的食指同时踩掉两条判据（PIP 40° < 130°、
 *   腕-指尖/腕-PIP 0.864 < 1.02），捏合比值即使为 0 也不成立。
 */
export const FINGER_EXTENSION_MIN_ANGLE_DEG = 130

/**
 * 捏合平滑参数。
 * - PINCH_WINDOW_FRAMES = 6：约 200ms（摄像头 30fps）。比这更长的窗口会让「捏合保持
 *   0.7 秒」的判定明显滞后；更短则挡不住单帧噪声。
 * - PINCH_MIN_SAMPLES = 3：窗口内至少 3 帧判定为捏合（即过半）才认。单帧的误判
 *   （手指快速划过、关键点跳点）因此被直接吞掉，而真实捏合会连续命中。
 * - 取中位数而不是平均值：偶尔一帧把拇指甩到远处（关键点跳点）时，均值会被拉大
 *   导致漏判，中位数不受极值影响。
 */
export const PINCH_WINDOW_FRAMES = 6
export const PINCH_MIN_SAMPLES = 3

const modeByCategory: Record<string, GestureMode> = {
  Open_Palm: 'galaxy',
  Closed_Fist: 'pig',
  Thumb_Up: 'closing',
}

const RAD_TO_DEG = 180 / Math.PI

const distance = (a: Landmark, b: Landmark) => Math.hypot(a.x - b.x, a.y - b.y)
const distance3d = (a: Landmark, b: Landmark) =>
  Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0))
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** 三点夹角（度）：伸直的手指接近 180°，蜷起的手指明显更小。 */
function jointAngleDeg(a: Landmark, b: Landmark, c: Landmark) {
  const v1x = a.x - b.x
  const v1y = a.y - b.y
  const v1z = (a.z ?? 0) - (b.z ?? 0)
  const v2x = c.x - b.x
  const v2y = c.y - b.y
  const v2z = (c.z ?? 0) - (b.z ?? 0)
  const length1 = Math.hypot(v1x, v1y, v1z)
  const length2 = Math.hypot(v2x, v2y, v2z)
  if (length1 < 1e-6 || length2 < 1e-6) return 0
  const cosine = clamp((v1x * v2x + v1y * v2y + v1z * v2z) / (length1 * length2), -1, 1)
  return Math.acos(cosine) * RAD_TO_DEG
}

function isFingerExtended(landmarks: readonly Landmark[], mcpIndex: number, pipIndex: number, tipIndex: number) {
  const wrist = landmarks[0]
  const mcp = landmarks[mcpIndex]
  const pip = landmarks[pipIndex]
  const tip = landmarks[tipIndex]
  if (!wrist || !mcp || !pip || !tip) return false

  return distance3d(wrist, tip) > distance3d(wrist, pip) * FINGER_EXTENSION_WRIST_RATIO
    && jointAngleDeg(mcp, pip, tip) >= FINGER_EXTENSION_MIN_ANGLE_DEG
}

/**
 * 掌尺度：优先用带 z 的三维距离，这样手掌朝侧面（透视缩短）时尺度不会被一起压小，
 * 捏合比值就不会因为手的朝向而漂移；没有 z 的实现（测试用的二维关键点）退化为二维。
 */
function palmScaleOf(landmarks: readonly Landmark[]): number {
  const wrist = landmarks[0]
  const middleBase = landmarks[9]
  if (!wrist || !middleBase) return 0.001
  return Math.max(distance3d(wrist, middleBase), 0.001)
}

type PinchObservation = {
  /** 拇指尖-食指尖距离 / 掌尺度；越小越像捏合。 */
  ratio: number
  /** 食指是否伸直（防握拳的**唯一**几何判据）。 */
  indexExtended: boolean
  /** 其余三指中伸直的数量。**仅诊断用**：捏合不要求它们伸直（真人捏合时自然弯曲）。 */
  otherExtended: number
  /** 是否为「食指伸直 + 两指贴合」的单帧捏合。 */
  pinch: boolean
}

function observePinch(landmarks: readonly Landmark[]): PinchObservation | null {
  const wrist = landmarks[0]
  const thumbTip = landmarks[4]
  const indexTip = landmarks[8]
  const middleBase = landmarks[9]
  if (!wrist || !thumbTip || !indexTip || !middleBase) return null

  const indexExtended = isFingerExtended(landmarks, 5, 6, 8)
  const otherExtended = [
    isFingerExtended(landmarks, 9, 10, 12),
    isFingerExtended(landmarks, 13, 14, 16),
    isFingerExtended(landmarks, 17, 18, 20),
  ].filter(Boolean).length

  const pinchRatio = distance(thumbTip, indexTip) / palmScaleOf(landmarks)
  // 只有两条判据：食指基本伸直（这是捏合与握拳的分界线）+ 两指尖真的贴上。
  // 其余三指是否伸直**不参与**判定 —— 真人捏合时它们自然弯曲（见 PINCH_ENTER_RATIO 上方注释）。
  const pinch = indexExtended && pinchRatio <= PINCH_ENTER_RATIO

  return { ratio: pinchRatio, indexExtended, otherExtended, pinch }
}

/** 把捏合比值映射成 0-1 置信度：进入阈值→0，完全贴合→1。 */
const pinchConfidence = (ratio: number) =>
  clamp((PINCH_ENTER_RATIO - ratio) / PINCH_ENTER_RATIO, 0, 1)

/**
 * 单帧捏合判定（无平滑）。保留纯函数形态，既是平滑器的基础，也便于直接单测。
 */
export function classifyPinch(landmarks: readonly Landmark[]): DetectedGesture | null {
  const observation = observePinch(landmarks)
  if (!observation?.pinch) return null
  return { mode: 'birthday', confidence: pinchConfidence(observation.ratio) }
}

/**
 * 多帧捏合平滑器：把最近 PINCH_WINDOW_FRAMES 帧的观测做中位数投票，只有过半帧都
 * 判定为捏合时才认。它是每帧一次推理的消费者 —— 只读已经算好的关键点，不会额外
 * 调用 recognizeForVideo。
 */
export class PinchSmoother {
  private readonly windowFrames: number
  private readonly minSamples: number
  private readonly history: PinchObservation[] = []

  constructor(windowFrames = PINCH_WINDOW_FRAMES, minSamples = PINCH_MIN_SAMPLES) {
    this.windowFrames = Math.max(1, windowFrames)
    this.minSamples = Math.max(1, Math.min(minSamples, this.windowFrames))
  }

  reset() {
    this.history.length = 0
  }

  /** 送入一帧关键点，返回平滑后的捏合结果（未捏合返回 null）。 */
  push(landmarks: readonly Landmark[]): DetectedGesture | null {
    const observation = observePinch(landmarks)
    if (!observation) return null

    this.history.push(observation)
    if (this.history.length > this.windowFrames) this.history.shift()

    const hits = this.history.filter((entry) => entry.pinch)
    if (hits.length < this.minSamples) return null

    const ratio = median(hits.map((entry) => entry.ratio))
    if (ratio > PINCH_EXIT_RATIO) return null
    return { mode: 'birthday', confidence: pinchConfidence(ratio) }
  }
}

/**
 * 把一帧识别结果映射成手势。内置类别优先（模型只有在很确定时才会给出类别，因此它的
 * 判断可以压过自定义几何判定）；类别为 None/未知时，才用关键点算捏合。
 */
export function classifyGesture(
  result: GestureRecognitionInput,
  smoother?: PinchSmoother,
): DetectedGesture | null {
  const category = result.gestures?.[0]?.[0]
  const modelMode = category ? modeByCategory[category.categoryName] : undefined

  // Reliable built-in categories take precedence so their landmarks cannot be
  // reinterpreted as the custom pinch gesture.
  if (category && modelMode) {
    if (category.score < CONFIDENCE_THRESHOLD) return null
    return { mode: modelMode, confidence: category.score }
  }

  const landmarks = result.landmarks?.[0]
  if (!landmarks) return null
  return smoother ? smoother.push(landmarks) : classifyPinch(landmarks)
}

/**
 * ======================= 只读诊断导出（校准页专用） =======================
 *
 * 下面这段是给 `calibration.html`（开发者/验收者用的手势自测校准页）准备的：它把上面
 * 那几条私有判据（同一个 `isFingerExtended` / `jointAngleDeg` / `palmScaleOf`）的**中间量**
 * 原样摊开，好让人对着真实摄像头看「到底是哪一条没通过」。
 *
 * 纪律：这里**只读**。它不缓存、不修改任何状态，也不参与 `classifyGesture` /
 * `PinchSmoother` / `GestureStabilityTracker` 的判定路径，因此对产品行为零影响。
 * 校准页必须复用这些量而不是自己抄一份实现 —— 否则校准的就是另一套假阈值了。
 */
export type FingerDiagnostics = {
  /** 'thumb' | 'index' | 'middle' | 'ring' | 'pinky' —— 拇指的关键点与其他四指不同。 */
  key: 'thumb' | 'index' | 'middle' | 'ring' | 'pinky'
  label: string
  /** 指根、中节、指尖的关键点下标（拇指为 CMC/MCP/IP/TIP）。 */
  indices: readonly number[]
  /** 腕-指尖 与 腕-中节(拇指为 MCP) 的三维距离之比；伸直要 > FINGER_EXTENSION_WRIST_RATIO。 */
  wristTipRatio: number
  /** 腕-指尖 与 腕-PIP 两个三维距离的原始值（便于判断抖动来自哪一端）。 */
  wristTipDistance: number
  wristPipDistance: number
  /** MCP-PIP-TIP（拇指为 MCP-IP-TIP）的三点夹角，单位度。 */
  pipAngleDeg: number
  /** 与 `isFingerExtended()` 完全同一套判据给出的结果。 */
  extended: boolean
  /**
   * 这一指的伸直情况是否**真的参与**捏合判定。现在只有食指为 true：
   * 拇指没有 PIP（本来就不参与），而中指/无名指/小指在「其余三指至少两指伸直」门槛删除后
   * 已彻底退出判定，只作诊断展示。
   */
  countsTowardPinch: boolean
}

export type HandDiagnostics = {
  /** 掌尺度 = |腕 0 → 中指根 9| 的三维距离，捏合比值与所有相对量的分母。 */
  palmScale: number
  /** 拇指尖-食指尖的平面距离（`observePinch` 用的就是这个量）。 */
  pinchDistance: number
  /** 捏合比值 = 拇指尖-食指尖距离 / 掌尺度。 */
  pinchRatio: number
  /** 进入阈值（迟滞的高门槛）与退出阈值。 */
  pinchEnterRatio: number
  pinchExitRatio: number
  /** pinchRatio 与两个阈值的关系：进入/迟滞区/退出。 */
  pinchZone: 'below-enter' | 'hysteresis' | 'above-exit'
  /** 食指是否伸直（捏合与握拳之间**唯一**的几何分界线，也是唯一的伸直类阻塞项）。 */
  indexExtended: boolean
  /**
   * 其余三指（中指/无名指/小指）里伸直的数量。**仅诊断参考**：捏合不要求它们伸直，
   * 真人捏合时它们通常自然弯曲（伸直数 0~1 是正常的），这里只用来排查「手是不是摆歪了」。
   */
  otherExtended: number
  /** 单帧捏合观测是否成立（食指伸直 + 两指贴合，未做多帧平滑）。 */
  pinchObserved: boolean
  /** 未通过的原因，按判据逐条给出，页面直接展示。 */
  blockers: string[]
  /** 五根手指的逐指明细（含拇指，仅作参考）。 */
  fingers: FingerDiagnostics[]
  /** 当前生效的阈值快照，来自本文件导出的常量，页面不再自己写一遍。 */
  thresholds: {
    wristRatio: number
    minAngleDeg: number
    indexMinRatio: number
  }
}

/** 五指的 (MCP, PIP, TIP) 下标；拇指用 (CMC, MCP, IP, TIP) 各自的含义单独处理。 */
const fingerLayout = [
  { key: 'thumb', label: '拇指', indices: [1, 2, 3, 4] },
  { key: 'index', label: '食指', indices: [5, 6, 7, 8] },
  { key: 'middle', label: '中指', indices: [9, 10, 11, 12] },
  { key: 'ring', label: '无名指', indices: [13, 14, 15, 16] },
  { key: 'pinky', label: '小指', indices: [17, 18, 19, 20] },
] as const

/**
 * 诊断层的「伸直」：与私有 `isFingerExtended()` 共用同两个条件，但把中间量一并带出来。
 * 拇指在真实判定里从不参与（它没有 PIP），这里用同一套条件算一遍仅供对照参考。
 */
function fingerDiagnostics(landmarks: readonly Landmark[], finger: (typeof fingerLayout)[number]): FingerDiagnostics {
  const [mcpIndex, pipIndex, , tipIndex] = finger.indices
  const wrist = landmarks[0]
  const mcp = landmarks[mcpIndex]
  const pip = landmarks[pipIndex]
  const tip = landmarks[tipIndex]

  const wristTipDistance = distance3d(wrist, tip)
  const wristPipDistance = distance3d(wrist, pip)
  const wristTipRatio = wristPipDistance > 1e-6 ? wristTipDistance / wristPipDistance : 0
  const pipAngleDeg = jointAngleDeg(mcp, pip, tip)

  return {
    key: finger.key,
    label: finger.label,
    indices: finger.indices,
    wristTipRatio,
    wristTipDistance,
    wristPipDistance,
    pipAngleDeg,
    extended: wristTipRatio > FINGER_EXTENSION_WRIST_RATIO && pipAngleDeg >= FINGER_EXTENSION_MIN_ANGLE_DEG,
    countsTowardPinch: finger.key === 'index',
  }
}

/**
 * 把一帧关键点翻译成「人话诊断」：每个用来判定的量都带出来，外加结论与阻塞原因。
 * 关键点不足 21 个（或没检测到手）时返回 null —— 此时产品侧本来也识别不到手势。
 */
export function describeHand(landmarks: readonly Landmark[]): HandDiagnostics | null {
  if (landmarks.length < 21) return null
  const wrist = landmarks[0]
  const thumbTip = landmarks[4]
  const indexTip = landmarks[8]
  const middleBase = landmarks[9]
  if (!wrist || !thumbTip || !indexTip || !middleBase) return null

  const fingers = fingerLayout.map((finger) => fingerDiagnostics(landmarks, finger))
  const byKey = (key: FingerDiagnostics['key']) => fingers.find((finger) => finger.key === key) as FingerDiagnostics
  const indexFinger = byKey('index')

  const palmScale = palmScaleOf(landmarks)
  const pinchDistance = distance(thumbTip, indexTip)
  const pinchRatio = pinchDistance / palmScale
  // 结论必须来自真实的判定路径：observePinch 与产品每帧用的是同一个函数。
  const observation = observePinch(landmarks)
  const indexExtended = observation?.indexExtended ?? false
  const otherExtended = observation?.otherExtended ?? 0

  /**
   * 逐条列出「差一点才成立」的原因：只有在两指距离已经进入阈值、而完整判据没通过时才有意义
   * —— 距离不达标时就谈不上是哪条伸直判据挡住的（那是「手还没捏上」，不是阈值问题）。
   *
   * 删除「其余三指伸直数」门槛后，这里的阻塞项只剩食指一条：捏合 = 食指伸直 + 两指贴合，
   * 所以「距离已达标但不成立」必然等价于「食指没伸直」。其余三指的伸直数只作诊断展示
   * （`otherExtended`），不会出现在 blockers 里 —— 否则页面会显示一个已经不存在的门槛。
   */
  const blockers: string[] = []
  if (pinchRatio <= PINCH_ENTER_RATIO && !(observation?.pinch ?? false) && !indexExtended) {
    blockers.push(
      `食指不伸直：腕-指尖/腕-PIP ${indexFinger.wristTipRatio.toFixed(3)}（需 > ${FINGER_EXTENSION_WRIST_RATIO}）、PIP ${indexFinger.pipAngleDeg.toFixed(1)}°（需 ≥ ${FINGER_EXTENSION_MIN_ANGLE_DEG}°）`,
    )
  }

  const pinchZone: HandDiagnostics['pinchZone'] =
    pinchRatio <= PINCH_ENTER_RATIO ? 'below-enter' : pinchRatio <= PINCH_EXIT_RATIO ? 'hysteresis' : 'above-exit'

  return {
    palmScale,
    pinchDistance,
    pinchRatio,
    pinchEnterRatio: PINCH_ENTER_RATIO,
    pinchExitRatio: PINCH_EXIT_RATIO,
    pinchZone,
    indexExtended,
    otherExtended,
    pinchObserved: observation?.pinch ?? false,
    blockers,
    fingers,
    thresholds: {
      wristRatio: FINGER_EXTENSION_WRIST_RATIO,
      minAngleDeg: FINGER_EXTENSION_MIN_ANGLE_DEG,
      indexMinRatio: INDEX_EXTENSION_MIN_RATIO,
    },
  }
}

export type GestureTrackerResult = {
  status: Extract<GestureStatus, 'ready' | 'holding' | 'recognized' | 'unrecognized'>
  trigger: GestureMode | null
  /** 当前候选姿势保持进度 0-1（仅 holding 有意义），用于反馈进度条。 */
  progress: number
  /** 当前正在保持的候选姿势；已锁定或未识别时为 null。 */
  candidate: GestureMode | null
  /** 当前识别到的姿势；用于反馈 UI 显示。 */
  mode: GestureMode | null
  confidence: number
  /** 最近识别是否在反复抖动（用于提示「再保持一下」）。 */
  unstable: boolean
}

export type GestureTrackerOptions = {
  holdMs: number
  cooldownMs: number
  releaseMs: number
  recognizedMs: number
  /** 候选姿势中途识别不到时，保留候选与已累计保持时间的容忍时长。 */
  lossToleranceMs: number
  /** 候选姿势更替的计数窗口，超出窗口的更替不再计入抖动。 */
  unstableWindowMs: number
  /** 窗口内连续更替多少次才判定为抖动。 */
  unstableStreak: number
  /** 判定为抖动后额外增加的保持时间。 */
  unstableHoldPenaltyMs: number
}

const defaultTrackerOptions: GestureTrackerOptions = {
  holdMs: HOLD_MS,
  cooldownMs: COOLDOWN_MS,
  releaseMs: RELEASE_MS,
  recognizedMs: 850,
  lossToleranceMs: LOSS_TOLERANCE_MS,
  unstableWindowMs: UNSTABLE_WINDOW_MS,
  unstableStreak: UNSTABLE_STREAK,
  unstableHoldPenaltyMs: UNSTABLE_HOLD_PENALTY_MS,
}

/**
 * 姿势稳定状态机：
 * - 保持 holdMs 才触发（防止手一划过就切换）；
 * - 保持过程中短暂识别不到（≤ lossToleranceMs）不清零，候选与已累计时间都保留，
 *   但丢失的时间不计入保持时间（真人实测：识别抖动是常态，清零会让手势「有时没反应」）；
 * - 触发后 cooldownMs 内不再触发同一姿势（需求 3.2）；
 * - 姿势消失超过 releaseMs 才解除锁定，于是同一个手势可以重复触发（需求 3.4.3）；
 * - 识别不到手势时什么都不做，画面保持当前样式（需求 8「误识别不触发不可逆操作」）；
 * - 短时间内在多个姿势之间反复更替时，保持窗口略作延长（抖动抑制）。
 */
export class GestureStabilityTracker {
  private readonly options: GestureTrackerOptions
  private candidateMode: GestureMode | null = null
  private candidateSince = 0
  /**
   * 本次候选姿势里「已经被容忍的丢失」累计时长。它是从 `now - candidateSince` 里扣掉的量，
   * 保证 held 只统计真正识别到手势的时间（HOLD_MS 不会被掉帧白送）。
   */
  private candidateLostMs = 0
  /** 当前这一轮「识别不到」的起点；没有正在进行的丢失时为 null。 */
  private lostSince: number | null = null
  private lockedMode: GestureMode | null = null
  private absentSince: number | null = null
  private lastTriggeredAt = Number.NEGATIVE_INFINITY
  private lastSwitchAt = Number.NEGATIVE_INFINITY
  /** 最近的候选姿势更替（模式 + 时间），用于抖动检测。 */
  private readonly events: { mode: GestureMode; at: number }[] = []

  constructor(options: Partial<GestureTrackerOptions> = {}) {
    this.options = { ...defaultTrackerOptions, ...options }
  }

  reset() {
    this.candidateMode = null
    this.candidateSince = 0
    this.candidateLostMs = 0
    this.lostSince = null
    this.lockedMode = null
    this.absentSince = null
    this.lastTriggeredAt = Number.NEGATIVE_INFINITY
    this.lastSwitchAt = Number.NEGATIVE_INFINITY
    this.events.length = 0
  }

  /** 候选姿势清零：丢失超过容忍窗口、候选被更替、以及候选已经触发时都走这里。 */
  private clearCandidate() {
    this.candidateMode = null
    this.candidateSince = 0
    this.candidateLostMs = 0
    this.lostSince = null
  }

  private pruneEvents(now: number) {
    const cutoff = now - this.options.unstableWindowMs
    while (this.events.length > 0 && this.events[0].at < cutoff) this.events.shift()
  }

  private churnStreak(now: number) {
    this.pruneEvents(now)
    return this.events.length
  }

  /** 当前候选姿势真正被识别到的时间：容忍掉的丢失时长全部扣除，绝不白送保持时间。 */
  private heldMs(now: number) {
    if (this.candidateMode === null) return 0
    // 丢失进行中时把时钟冻结在「丢失开始的那一刻」，所以丢失期间进度不会前进。
    const effectiveNow = this.lostSince ?? now
    return Math.max(0, effectiveNow - this.candidateSince - this.candidateLostMs)
  }

  /** 当前所需的保持时长（抖动成立时加罚时）。 */
  private requiredHoldMs(now: number) {
    const penalized = this.churnStreak(now) >= this.options.unstableStreak
    return this.options.holdMs + (penalized ? this.options.unstableHoldPenaltyMs : 0)
  }

  update(detected: DetectedGesture | null, now: number): GestureTrackerResult {
    if (!detected || detected.confidence < CONFIDENCE_THRESHOLD) {
      if (this.lostSince === null) this.lostSince = now
      if (this.absentSince === null) this.absentSince = now
      if (this.lockedMode && now - this.absentSince >= this.options.releaseMs) {
        this.lockedMode = null
      }

      /**
       * 丢失容忍：候选姿势还在计时、且这一轮「识别不到」还没超过 LOSS_TOLERANCE_MS 时，
       * **保留候选与已累计的保持时间**，只把进度冻结在丢失开始那一刻（heldMs 用的是
       * lostSince 而不是 now）。这正是「有时没反应」的解药：旧实现在这里直接清零，
       * 真人抖动几帧就永远攒不满 HOLD_MS。
       *
       * 对外仍然报 'unrecognized'（与改动前的逐帧表现一致，不引入新的 UI 文案闪烁），
       * 但 candidate/progress 如实反映内部保留的状态，方便校准页与用例观察。
       * 超过容忍窗口则落到下面的 clearCandidate()，完全回到旧行为：清零、重新计时。
       */
      if (this.candidateMode !== null && now - this.lostSince <= this.options.lossToleranceMs) {
        return {
          status: 'unrecognized',
          trigger: null,
          progress: clamp(this.heldMs(now) / this.requiredHoldMs(now), 0, 1),
          candidate: this.candidateMode,
          mode: null,
          confidence: 0,
          unstable: false,
        }
      }

      this.clearCandidate()
      return {
        status: 'unrecognized',
        trigger: null,
        progress: 0,
        candidate: null,
        mode: null,
        confidence: 0,
        unstable: false,
      }
    }

    this.absentSince = null
    // 丢失结束。同一个候选姿势才把这段空档记进 candidateLostMs（保持时间必须扣掉它）；
    // 换了姿势就是一次新候选，时间轴在下面整体重置。
    if (this.lostSince !== null) {
      const lostMs = now - this.lostSince
      this.lostSince = null
      if (detected.mode === this.candidateMode) this.candidateLostMs += lostMs
    }

    if (detected.mode === this.lockedMode) {
      this.clearCandidate()
      const status = now - this.lastTriggeredAt < this.options.recognizedMs ? 'recognized' : 'ready'
      return {
        status,
        trigger: null,
        progress: 0,
        candidate: null,
        mode: detected.mode,
        confidence: detected.confidence,
        unstable: false,
      }
    }

    if (detected.mode !== this.candidateMode) {
      this.candidateMode = detected.mode
      this.candidateSince = now
      this.candidateLostMs = 0
      this.lostSince = null
      this.events.push({ mode: detected.mode, at: now })
      this.pruneEvents(now)
    }

    const streak = this.churnStreak(now)
    const unstable = streak >= this.options.unstableStreak
    const requiredHold = this.requiredHoldMs(now)
    // 总保持时间必须由「真正识别到」的时间凑满：墙钟时间 = HOLD_MS + 被容忍的丢失时长。
    const held = this.heldMs(now)
    const progress = clamp(held / requiredHold, 0, 1)

    const heldLongEnough = held >= requiredHold
    const cooldownComplete = now - this.lastSwitchAt >= this.options.cooldownMs
    if (!heldLongEnough || !cooldownComplete) {
      return {
        status: 'holding',
        trigger: null,
        progress,
        candidate: detected.mode,
        mode: detected.mode,
        confidence: detected.confidence,
        unstable,
      }
    }

    const switching = this.lockedMode !== null && this.lockedMode !== detected.mode
    this.lockedMode = detected.mode
    this.clearCandidate()
    this.lastTriggeredAt = now
    if (switching) this.lastSwitchAt = now
    // 触发后清零更替记录：真正的切换本身不算抖动。
    this.events.length = 0

    return {
      status: 'recognized',
      trigger: detected.mode,
      progress: 0,
      candidate: null,
      mode: detected.mode,
      confidence: detected.confidence,
      unstable: false,
    }
  }
}
