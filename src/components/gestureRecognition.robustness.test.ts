import { describe, expect, it } from 'vitest'
import {
  CONFIDENCE_THRESHOLD,
  FINGER_EXTENSION_MIN_ANGLE_DEG,
  FINGER_EXTENSION_WRIST_RATIO,
  GestureStabilityTracker,
  HOLD_MS,
  LOSS_TOLERANCE_MS,
  PINCH_ENTER_RATIO,
  PINCH_EXIT_RATIO,
  PINCH_MIN_SAMPLES,
  PINCH_WINDOW_FRAMES,
  PinchSmoother,
  UNSTABLE_HOLD_PENALTY_MS,
  UNSTABLE_STREAK,
  UNSTABLE_WINDOW_MS,
  classifyGesture,
  classifyPinch,
  describeHand,
  type DetectedGesture,
  type GestureMode,
  type GestureRecognitionInput,
} from './gestureRecognition'
import { MODE_SWITCH_COOLDOWN_MS, createModeSwitchGuard } from './modeSelection'

type Point = { x: number; y: number; z?: number }
type Hand = Point[]

/**
 * 合成手：用前向运动学（FK）从「关节角度」生成 21 个关键点（MediaPipe 索引），
 * 而不是手写坐标。
 *
 * 为什么必须 FK：手写坐标时「我以为摆的是握拳」和「关键点真实夹角」很容易对不上。
 * 上一版夹具就是这么坏的 —— 所谓握拳的食指实测 PIP 夹角 167°（比伸直判据还直，
 * 于是握拳被判成了捏合），而捏合夹具的食指实测只有 139°（过不了 145° 的伸直判据）。
 * FK 让用例里写的角度就是关键点真实夹角（本例精确到 0.1°），并且 MCP/PIP/指尖
 * 永不共线（不会退化成 NaN），也不需要手工去「避开连线」。
 *
 * 骨架按真人比例摆（单位与 MediaPipe 归一化坐标一致）：
 * - 掌尺度 |腕 0 → 中指根 9| ≈ 0.300（夹具里所有比值都按这个尺度归一化）；
 * - 四指 MCP→指尖 0.169~0.230 = 0.56~0.77 掌尺度；
 * - 张开手的拇指 ≈ 0.72 掌尺度（真人 0.66~0.71）。
 * 屏幕坐标 y 向下：伸直的手指朝上（方向角 -90°），蜷起时朝掌心（-x / +y）折叠。
 */
const WRIST: Point = { x: 0.5, y: 0.92 }
const THUMB_CMC: Point = { x: 0.42, y: 0.79 }

type FingerName = 'index' | 'middle' | 'ring' | 'pinky'

/** 四指骨架：MCP 位置、近节方向角、近节长度、中节+末节长度（后两项单位 = 归一化坐标）。 */
const FINGER_SKELETON: Record<FingerName, { mcp: Point; dirDeg: number; proximal: number; distal: number }> = {
  index: { mcp: { x: 0.44, y: 0.65 }, dirDeg: -90, proximal: 0.08, distal: 0.13 },
  middle: { mcp: { x: 0.52, y: 0.62 }, dirDeg: -90, proximal: 0.088, distal: 0.142 },
  ring: { mcp: { x: 0.6, y: 0.645 }, dirDeg: -88, proximal: 0.082, distal: 0.132 },
  pinky: { mcp: { x: 0.665, y: 0.7 }, dirDeg: -84, proximal: 0.065, distal: 0.104 },
}

/** 四指的 (MCP, PIP, 指尖) 索引，顺序与 FINGER_SKELETON 一致。 */
const FINGER_JOINTS: ReadonlyArray<readonly [FingerName, number, number, number]> = [
  ['index', 5, 6, 8],
  ['middle', 9, 10, 12],
  ['ring', 13, 14, 16],
  ['pinky', 17, 18, 20],
]

const RAD = Math.PI / 180

const rotate = (vector: Point, deg: number): Point => {
  const cos = Math.cos(deg * RAD)
  const sin = Math.sin(deg * RAD)
  return { x: vector.x * cos - vector.y * sin, y: vector.x * sin + vector.y * cos }
}

type FingerPose = {
  /** PIP 夹角（度）：180° = 完全伸直，越小越蜷。生成后可用 pipAngleOf 复算验证。 */
  angle: number
  /**
   * 整条手指链在 2D 投影下的缩短系数。真人蜷指是朝镜头方向（z）折叠的，投到画面里
   * 近节与末节都会明显变短 —— 握拳夹具取 0.62 就是模拟这个投影缩短。
   */
  shrink?: number
}

/** 完全伸直：取 178° 而不是 180°，天然避开三点共线退化。 */
const STRAIGHT: FingerPose = { angle: 178 }
/** 蜷回掌心：PIP 40°、指尖缩到掌心，实测腕-指尖/腕-PIP ≈ 0.86 < 1.02。 */
const CURLED: FingerPose = { angle: 40, shrink: 0.62 }
/** 捏合时的食指：165°，比 130° 阈值高 35°（刻意留余量，不贴阈值）。 */
const PINCH_INDEX: FingerPose = { angle: 165 }

type FingerChain = { pip: Point; dip: Point; tip: Point }

/**
 * 单根手指的前向运动学：从 MCP 出发，第一段沿 dirDeg 走 proximal，第二段由第一段旋转
 * (180° - angle) 得到、走 distal。于是 jointAngleDeg(MCP, PIP, 指尖) 恒等于 angle（本例精确到 0.1°）。
 */
const fkFinger = (name: FingerName, pose: FingerPose): FingerChain => {
  const skeleton = FINGER_SKELETON[name]
  const shrink = pose.shrink ?? 1
  const first = { x: Math.cos(skeleton.dirDeg * RAD), y: Math.sin(skeleton.dirDeg * RAD) }
  const second = rotate(first, -(180 - pose.angle))
  const proximal = skeleton.proximal * shrink
  const distal = skeleton.distal * shrink
  const pip = { x: skeleton.mcp.x + first.x * proximal, y: skeleton.mcp.y + first.y * proximal }
  return {
    pip,
    dip: { x: pip.x + second.x * distal * 0.55, y: pip.y + second.y * distal * 0.55 },
    tip: { x: pip.x + second.x * distal, y: pip.y + second.y * distal },
  }
}

type HandPose = {
  fingers?: Partial<Record<FingerName, FingerPose>>
  /** 拇指尖位置；与 thumbGap 都缺省时 = 精确贴住食指尖（捏合）。 */
  thumbTip?: Point
  /** 拇指尖沿「食指尖 → 拇指根」方向回缩的距离（松开拇指、食指仍伸直）。 */
  thumbGap?: number
}

/**
 * 生成一只手：四指默认全部伸直，拇指默认精确贴在食指尖上。
 * FK 的几何依据：PIP 处夹角 = |第一段方向 - 第二段方向|，第二段方向由第一段旋转
 * (180° - angle) 得到，因此 jointAngleDeg(MCP, PIP, 指尖) 恒等于传入的 angle。
 */
const buildHand = (pose: HandPose = {}): Hand => {
  const fingers: Record<FingerName, FingerPose> = {
    index: STRAIGHT,
    middle: STRAIGHT,
    ring: STRAIGHT,
    pinky: STRAIGHT,
    ...pose.fingers,
  }

  const chains: Record<FingerName, FingerChain> = {
    index: fkFinger('index', fingers.index),
    middle: fkFinger('middle', fingers.middle),
    ring: fkFinger('ring', fingers.ring),
    pinky: fkFinger('pinky', fingers.pinky),
  }

  const indexTip = chains.index.tip
  let thumbTip = pose.thumbTip ?? indexTip
  if (pose.thumbTip === undefined) {
    const gap = pose.thumbGap ?? 0
    const span = Math.hypot(THUMB_CMC.x - indexTip.x, THUMB_CMC.y - indexTip.y)
    thumbTip = {
      x: indexTip.x + ((THUMB_CMC.x - indexTip.x) / span) * gap,
      y: indexTip.y + ((THUMB_CMC.y - indexTip.y) / span) * gap,
    }
  }

  // 拇指链：根 1 → 尖 4 之间用二次贝塞尔摆出 2、3，向体侧微弓（判据只用到拇指尖 4）。
  const control = { x: (THUMB_CMC.x + thumbTip.x) / 2 - 0.05, y: (THUMB_CMC.y + thumbTip.y) / 2 + 0.015 }
  const thumbAt = (t: number): Point => ({
    x: (1 - t) * (1 - t) * THUMB_CMC.x + 2 * (1 - t) * t * control.x + t * t * thumbTip.x,
    y: (1 - t) * (1 - t) * THUMB_CMC.y + 2 * (1 - t) * t * control.y + t * t * thumbTip.y,
  })

  const points: Point[] = new Array<Point>(21)
  points[0] = WRIST
  points[1] = THUMB_CMC
  points[2] = thumbAt(0.34)
  points[3] = thumbAt(0.68)
  points[4] = thumbTip
  for (const [name, mcpIndex, pipIndex, tipIndex] of FINGER_JOINTS) {
    const chain = chains[name]
    points[mcpIndex] = { ...FINGER_SKELETON[name].mcp }
    points[pipIndex] = chain.pip
    points[tipIndex] = chain.tip
    points[tipIndex - 1] = chain.dip
  }
  return points
}

/**
 * 捏合：食指尖与拇指尖精确贴合，中指 / 无名指 / 小指伸直。食指 PIP = 165°（用例里的
 * 伸直余量刻意留到 35°，不贴 130° 阈值）。
 *
 * 注意这里的拇指被「拉长」了：|拇指根 1 → 拇指尖 4| ≈ 1.15 掌尺度，而真人拇指只有
 * 0.66~0.71 掌尺度。这不是笔误，而是「食指基本伸直 + 两指尖真正贴合」这个组合在真实
 * 手上做不到的量化证据（见 gestureRecognition.ts 里 FINGER_EXTENSION_MIN_ANGLE_DEG 的
 * 扫描：拇指 0.66 掌尺度时，食指 PIP 得弯到 135° 以下才可能把指尖送到拇指尖）。
 * 本夹具的职责是钉住判据的输入（食指伸直 + 两指贴合），真实捏合的可行性取舍记在实现注释里，
 * 并由下面「轻微弯曲 140° / 深弯 120°」两条用例把下界钉住。
 *
 * 其余三指在这里默认伸直只是为了沿用「四指伸直」这个基准手型；它们**已经不再参与判定**，
 * 真实捏合的形状（其余三指自然弯曲）见 `naturalPinchHand`。
 */
const pinchHand = (pose: HandPose = {}): Hand => buildHand({
  ...pose,
  fingers: { index: PINCH_INDEX, ...pose.fingers },
})

/**
 * 真人捏合：食指伸直 + 拇指尖精确贴合 + **其余三指全部自然弯曲**。
 * 这是本次修复的核心用例 —— 旧判据要求「其余三指至少两指伸直」（otherExtended >= 2），
 * 而真人捏合时中指/无名指/小指像捏起一个小东西那样自然蜷着，实测伸直数 0~1，
 * 于是捏合被判成恒定不成立。
 */
const naturalPinchHand = (indexAngle = PINCH_INDEX.angle): Hand => pinchHand({
  fingers: {
    index: { angle: indexAngle },
    middle: CURLED,
    ring: CURLED,
    pinky: CURLED,
  },
})

/** 半握拳捏合：小指蜷起，中指 + 无名指仍伸直（其余三指里正好两指伸直）。 */
const halfFistPinchHand = (): Hand => pinchHand({ fingers: { pinky: CURLED } })

/** 其余三指里只有一指伸直（无名指 + 小指蜷起）：旧判据下正好差一指，现在同样成立。 */
const singleOtherFingerPinchHand = (): Hand => pinchHand({ fingers: { ring: CURLED, pinky: CURLED } })

/** 完全张开的手掌：四指伸直，拇指在体侧，离食指尖 ≈ 0.78 掌尺度（远大于 0.42 进入阈值）。 */
const openHand = (): Hand => buildHand({ thumbTip: { x: 0.285, y: 0.62, z: 0 } })

/** 握拳：四指全部蜷回掌心（PIP 40°、指尖缩到掌心），且拇指尖精确贴住蜷起的食指尖。 */
const fistHand = (): Hand => pinchHand({
  fingers: { index: CURLED, middle: CURLED, ring: CURLED, pinky: CURLED },
})

const distance2d = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const distance3d = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0))

/** 三点夹角（度）。与实现同一套几何，用来复算夹具自称的角度是否成立。 */
const jointAngleDeg = (a: Point, b: Point, c: Point) => {
  const v1 = { x: a.x - b.x, y: a.y - b.y }
  const v2 = { x: c.x - b.x, y: c.y - b.y }
  const length1 = Math.hypot(v1.x, v1.y)
  const length2 = Math.hypot(v2.x, v2.y)
  const cosine = Math.min(1, Math.max(-1, (v1.x * v2.x + v1.y * v2.y) / (length1 * length2)))
  return (Math.acos(cosine) * 180) / Math.PI
}

const pipAngleOf = (hand: Hand, mcp: number, pip: number, tip: number) =>
  jointAngleDeg(hand[mcp], hand[pip], hand[tip])
/** 掌尺度（含 z），与实现一致。 */
const palmScaleOf = (hand: Hand) => distance3d(hand[0], hand[9])
/** 捏合比值：两指尖距离 / 掌尺度。 */
const pinchRatioOf = (hand: Hand) => distance2d(hand[4], hand[8]) / palmScaleOf(hand)
/** 伸直判据之一的比值：腕-指尖 / 腕-PIP（需 > FINGER_EXTENSION_WRIST_RATIO）。 */
const wristRatioOf = (hand: Hand, pip: number, tip: number) =>
  distance3d(hand[0], hand[tip]) / distance3d(hand[0], hand[pip])
/** 按实现的两条判据判断单指是否伸直。 */
const isExtended = (hand: Hand, mcp: number, pip: number, tip: number) =>
  wristRatioOf(hand, pip, tip) > FINGER_EXTENSION_WRIST_RATIO
  && pipAngleOf(hand, mcp, pip, tip) >= FINGER_EXTENSION_MIN_ANGLE_DEG
/** 伸直的手指名。 */
const extendedFingers = (hand: Hand) =>
  FINGER_JOINTS.filter(([, mcp, pip, tip]) => isExtended(hand, mcp, pip, tip)).map(([name]) => name)
/** 其余三指（中指/无名指/小指）里伸直的数量。**只作诊断参考**：捏合已不要求它们伸直。 */
const otherExtendedCount = (hand: Hand) =>
  extendedFingers(hand).filter((name) => name !== 'index').length

const landmarksOnly = (hand: Hand): GestureRecognitionInput => ({ landmarks: [hand] })
const noneCategory = (hand: Hand): GestureRecognitionInput => ({ gestures: [[{ categoryName: 'None', score: 0.9 }]], landmarks: [hand] })

const detected = (mode: GestureMode, confidence = 0.9): DetectedGesture => ({ mode, confidence })

describe('夹具几何自洽性（FK 生成，角度与比值都可复算）', () => {
  it('捏合夹具：食指真的伸直（165°，比阈值高 35°），拇指尖精确贴合食指尖', () => {
    const hand = pinchHand()
    expect(pipAngleOf(hand, 5, 6, 8)).toBeCloseTo(165, 0)
    expect(pipAngleOf(hand, 5, 6, 8)).toBeGreaterThan(FINGER_EXTENSION_MIN_ANGLE_DEG + 30)
    expect(wristRatioOf(hand, 6, 8)).toBeGreaterThan(FINGER_EXTENSION_WRIST_RATIO * 1.2)
    expect(pinchRatioOf(hand)).toBeLessThan(0.01)
    expect(otherExtendedCount(hand)).toBe(3)
  })

  it('握拳夹具：四指真的蜷回掌心，每条手指链同时踩掉两条伸直判据', () => {
    const hand = fistHand()
    for (const [, mcp, pip, tip] of FINGER_JOINTS) {
      expect(pipAngleOf(hand, mcp, pip, tip)).toBeLessThan(80)
      expect(pipAngleOf(hand, mcp, pip, tip)).toBeLessThan(FINGER_EXTENSION_MIN_ANGLE_DEG - 60)
      expect(wristRatioOf(hand, pip, tip)).toBeLessThan(FINGER_EXTENSION_WRIST_RATIO)
    }
    expect(extendedFingers(hand)).toHaveLength(0)
    // 拇指尖压在蜷起的食指尖上：挡住它的只有伸直判据本身，不是「两指离得远」。
    expect(pinchRatioOf(hand)).toBeLessThan(0.01)
  })

  it('张开手掌：四指伸直，但拇指离食指尖约 0.78 掌尺度，且拇指长度符合真人比例', () => {
    const hand = openHand()
    expect(extendedFingers(hand)).toHaveLength(4)
    expect(otherExtendedCount(hand)).toBe(3)
    expect(pinchRatioOf(hand)).toBeGreaterThan(PINCH_ENTER_RATIO)
    expect(distance2d(hand[1], hand[4]) / palmScaleOf(hand)).toBeLessThan(0.75)
  })

  it('半握拳捏合夹具：其余三指里正好两指伸直（中指/无名指 178°，小指 40° 蜷起）', () => {
    const hand = halfFistPinchHand()
    // 2 是旧 MIN_OTHER_FINGERS_EXTENDED 的边界值；该门槛已删除，这个数现在只是诊断量。
    expect(otherExtendedCount(hand)).toBe(2)
    expect(pipAngleOf(hand, 17, 18, 20)).toBeLessThan(FINGER_EXTENSION_MIN_ANGLE_DEG - 60)
  })

  it('真人捏合夹具：食指 165° 伸直 + 两指尖精确贴合 + 其余三指全部自然弯曲（伸直数 0）', () => {
    const hand = naturalPinchHand()
    expect(pipAngleOf(hand, 5, 6, 8)).toBeCloseTo(165, 0)
    expect(isExtended(hand, 5, 6, 8)).toBe(true)
    expect(pinchRatioOf(hand)).toBeLessThan(0.01)
    expect(otherExtendedCount(hand)).toBe(0)
  })
})

describe('捏合判定（自定义几何 + 多帧平滑）', () => {
  it('三指伸直的捏合被判为 birthday', () => {
    expect(classifyGesture(landmarksOnly(pinchHand()))?.mode).toBe('birthday')
  })

  it('模型给出 None 时也认捏合（这是自定义判定的主要路径）', () => {
    expect(classifyGesture(noneCategory(pinchHand()))?.mode).toBe('birthday')
  })

  it('其余三指只伸直两指（攥半拳捏合）仍判为 birthday', () => {
    expect(classifyGesture(landmarksOnly(halfFistPinchHand()))?.mode).toBe('birthday')
  })

  it('【核心修复】其余手指自然弯曲（伸直数 0）的捏合仍然成立', () => {
    const hand = naturalPinchHand()
    // 先钉住夹具：食指确实是伸直的、两指确实贴合、其余三指确实一指都没伸直。
    expect(isExtended(hand, 5, 6, 8)).toBe(true)
    expect(pinchRatioOf(hand)).toBeLessThan(PINCH_ENTER_RATIO)
    expect(otherExtendedCount(hand)).toBe(0)
    // 单帧判定成立（这是旧判据下恒为 null 的那一帧）。
    expect(classifyPinch(hand)?.mode).toBe('birthday')
    expect(classifyGesture(landmarksOnly(hand))?.mode).toBe('birthday')
    expect(classifyGesture(noneCategory(hand))?.mode).toBe('birthday')
    // 产品路径是「每帧一次推理 + PinchSmoother 投票」，平滑后同样成立。
    const smoother = new PinchSmoother()
    const results = Array.from({ length: PINCH_WINDOW_FRAMES }, () => smoother.push(hand))
    expect(results[results.length - 1]?.mode).toBe('birthday')
  })

  it('【核心修复】其余三指只有一指伸直也不再是否决理由', () => {
    const hand = singleOtherFingerPinchHand()
    expect(isExtended(hand, 5, 6, 8)).toBe(true)
    expect(otherExtendedCount(hand)).toBe(1)
    expect(classifyPinch(hand)?.mode).toBe('birthday')
    expect(classifyGesture(landmarksOnly(hand))?.mode).toBe('birthday')
  })

  it('食指轻微弯曲（140°）+ 其余三指自然弯曲的捏合也成立', () => {
    const hand = naturalPinchHand(140)
    expect(pipAngleOf(hand, 5, 6, 8)).toBeCloseTo(140, 0)
    expect(otherExtendedCount(hand)).toBe(0)
    expect(classifyPinch(hand)?.mode).toBe('birthday')
  })

  it('握拳（四指蜷回掌心）不会被误判为捏合，即使拇指尖贴着食指尖', () => {
    expect(classifyGesture(landmarksOnly(fistHand()))).toBeNull()
    expect(classifyGesture(noneCategory(fistHand()))).toBeNull()
  })

  it('【防误判】真握拳的三条实测证据：食指 PIP 40°、腕比值 0.864、捏合比值 0 —— classifyPinch 仍为 null', () => {
    const hand = fistHand()
    const indexPip = pipAngleOf(hand, 5, 6, 8)
    const indexWristRatio = wristRatioOf(hand, 6, 8)
    const ratio = pinchRatioOf(hand)
    // 夹具证据（写在用例里，随实现漂移会立刻失败）：
    expect(indexPip).toBeCloseTo(40, 0)
    expect(indexPip).toBeLessThan(FINGER_EXTENSION_MIN_ANGLE_DEG - 60)
    expect(indexWristRatio).toBeCloseTo(0.864, 3)
    expect(indexWristRatio).toBeLessThanOrEqual(FINGER_EXTENSION_WRIST_RATIO)
    // 拇指尖被刻意放在蜷起的食指尖上：捏合比值 ≈ 0，纵深防线只剩下食指伸直判据。
    expect(ratio).toBeLessThan(0.01)
    expect(otherExtendedCount(hand)).toBe(0)
    // 因此：单帧判定、无平滑判定、多帧平滑、以及「模型不给类别」这条主路径，全部不成立。
    expect(classifyPinch(hand)).toBeNull()
    expect(classifyGesture(landmarksOnly(hand))).toBeNull()
    expect(classifyGesture(noneCategory(hand))).toBeNull()
    const smoother = new PinchSmoother()
    const results = Array.from({ length: PINCH_WINDOW_FRAMES }, () => smoother.push(hand))
    expect(results.every((result) => result === null)).toBe(true)
  })

  it('握拳与捏合的几何分界：只差食指伸直这一条，其它量完全相同', () => {
    const fist = fistHand()
    const natural = naturalPinchHand()
    // 两者的「其余三指伸直数」都是 0 —— 所以它不可能充当分界线（旧判据正是错在这里）。
    expect(otherExtendedCount(fist)).toBe(otherExtendedCount(natural))
    // 真正的分界线：食指伸直（PIP 40° vs 165°、腕比值 0.864 vs 1.365）。
    expect(isExtended(fist, 5, 6, 8)).toBe(false)
    expect(isExtended(natural, 5, 6, 8)).toBe(true)
    expect(classifyPinch(fist)).toBeNull()
    expect(classifyPinch(natural)?.mode).toBe('birthday')
  })

  it('展开手掌不会被误判为捏合', () => {
    expect(classifyGesture(landmarksOnly(openHand()))).toBeNull()
  })

  it('半握的手（食指半蜷 125°）+ 拇指尖贴上：仍不判捏合', () => {
    const hand = naturalPinchHand(125)
    expect(pipAngleOf(hand, 5, 6, 8)).toBeCloseTo(125, 0)
    expect(isExtended(hand, 5, 6, 8)).toBe(false)
    expect(pinchRatioOf(hand)).toBeLessThan(PINCH_ENTER_RATIO)
    expect(classifyPinch(hand)).toBeNull()
  })

  it('握拳仍由模型类别判为猪头，捏合几何不会把它改成生日', () => {
    expect(classifyGesture({ gestures: [[{ categoryName: 'Closed_Fist', score: 0.9 }]], landmarks: [fistHand()] })?.mode).toBe('pig')
    expect(classifyGesture({ gestures: [[{ categoryName: 'Closed_Fist', score: 0.9 }]], landmarks: [pinchHand()] })?.mode).toBe('pig')
  })

  it('手拉远拉近（整体坐标缩放）不影响捏合判定', () => {
    const shrink = (hand: Hand, factor: number): Hand =>
      hand.map((point) => ({ x: 0.5 + (point.x - 0.5) * factor, y: 0.5 + (point.y - 0.5) * factor, z: (point.z ?? 0) * factor }))
    expect(classifyGesture(landmarksOnly(shrink(pinchHand(), 0.55)))?.mode).toBe('birthday')
    expect(classifyGesture(landmarksOnly(shrink(pinchHand(), 1.7)))?.mode).toBe('birthday')
    // 握拳同样不能因为拉近放大而变成捏合。
    expect(classifyGesture(landmarksOnly(shrink(fistHand(), 1.7)))).toBeNull()
  })

  it('食指轻微弯曲（PIP 140°）的捏合仍然成立 —— 旧的 145° 阈值会在这里漏判', () => {
    const hand = pinchHand({ fingers: { index: { angle: 140 } } })
    expect(pipAngleOf(hand, 5, 6, 8)).toBeCloseTo(140, 0)
    // 腕-指尖/腕-PIP 仍有 1.33，说明漏判完全来自角度阈值，不是腕比值。
    expect(wristRatioOf(hand, 6, 8)).toBeGreaterThan(1.3)
    expect(classifyGesture(landmarksOnly(hand))?.mode).toBe('birthday')
  })

  it('阈值下界仍在：食指深弯到 120° 不判捏合，且与握拳的 40° 隔着 60° 以上', () => {
    expect(classifyGesture(landmarksOnly(pinchHand({ fingers: { index: { angle: 120 } } })))).toBeNull()
    const fistAngle = pipAngleOf(fistHand(), 5, 6, 8)
    expect(fistAngle).toBeLessThan(80)
    expect(FINGER_EXTENSION_MIN_ANGLE_DEG - fistAngle).toBeGreaterThan(60)
  })

  it('捏得紧的置信度高于刚好达标的捏合', () => {
    const tight = classifyGesture(landmarksOnly(pinchHand()))
    // 松开 0.10（≈0.33 掌尺度）：仍在 0.42 进入阈值内，但置信度明显更低。
    const relaxed = classifyGesture(landmarksOnly(pinchHand({ thumbGap: 0.1 })))
    expect(tight?.confidence).toBeGreaterThan(0)
    expect(relaxed?.mode).toBe('birthday')
    if (relaxed) expect(tight?.confidence).toBeGreaterThan(relaxed.confidence)
  })
})

describe('PinchSmoother 多帧平滑', () => {
  it('单帧噪声捏合不会立刻成立，需要连续命中', () => {
    const smoother = new PinchSmoother()
    expect(smoother.push(pinchHand())).toBeNull()
  })

  it('连续稳定的捏合会被确认', () => {
    const smoother = new PinchSmoother()
    const results = Array.from({ length: PINCH_WINDOW_FRAMES }, () => smoother.push(pinchHand()))
    expect(results[results.length - 1]?.mode).toBe('birthday')
  })

  it('窗口内过半帧命中即视为捏合，无需整窗命中', () => {
    const smoother = new PinchSmoother()
    // 平滑器是「最近 6 帧投票」，空窗口不可能有结果，所以先预热 6 帧把窗口装满。
    for (let index = 0; index < PINCH_WINDOW_FRAMES; index += 1) smoother.push(pinchHand())
    // 再看 6 帧：4 帧捏合 + 2 帧松开（后两帧比值 > 0.42，本帧不算命中）。
    // 推演：第 5 帧窗口 = [5 命中 + 本帧未命中] → 命中 5；第 6 帧窗口 = [4 命中 + 2 未命中]
    // → 命中 4 >= PINCH_MIN_SAMPLES(3)，所以 6 帧全部成立 —— 无需整窗命中。
    const sequence = [
      pinchHand(),
      pinchHand(),
      pinchHand(),
      pinchHand(),
      // 拇指松开 0.16（比值 0.53 > 0.42，本帧不算命中），食指仍伸直。
      pinchHand({ thumbGap: 0.16 }),
      openHand(),
    ]
    expect(sequence.map(pinchRatioOf).slice(4).every((ratio) => ratio > PINCH_ENTER_RATIO)).toBe(true)
    const results = sequence.map((hand) => smoother.push(hand))
    expect(results.filter((result) => result?.mode === 'birthday').length).toBe(PINCH_WINDOW_FRAMES)
  })

  it('中位数抵抗单帧极值：偶发一帧两指远离仍然保持捏合', () => {
    const smoother = new PinchSmoother()
    for (let index = 0; index < 5; index += 1) smoother.push(pinchHand())
    // 关键点跳点：拇指尖甩到画面左下角，本帧捏合比值 ≈2.1（不命中），但中位数不受影响。
    const outlier = pinchHand({ thumbTip: { x: 0.02, y: 0.9, z: 0 } })
    expect(pinchRatioOf(outlier)).toBeGreaterThan(PINCH_ENTER_RATIO)
    const withOutlier = smoother.push(outlier)
    expect(withOutlier?.mode).toBe('birthday')
  })

  it('松手后命中数跌破过半才停止判定：窗口 6 帧 / 最少 3 帧，第 4 帧转 null', () => {
    const smoother = new PinchSmoother()
    for (let index = 0; index < PINCH_WINDOW_FRAMES; index += 1) smoother.push(pinchHand())
    // 推演：窗口 = 最近 6 帧，命中数 = 其中判为捏合的帧数，需 >= PINCH_MIN_SAMPLES(3)。
    // 松手后第 1/2/3 帧窗口里还留着 5/4/3 帧旧命中 → 仍判捏合；第 4 帧只剩 2 帧 → 转 null。
    // 即停止延迟 = PINCH_WINDOW_FRAMES - PINCH_MIN_SAMPLES + 1 = 4 帧 ≈ 130ms@30fps，
    // 与实现「整窗投票」的定义一致（不是 2 帧）。
    const releaseFrames = PINCH_WINDOW_FRAMES - PINCH_MIN_SAMPLES + 1
    const released = Array.from({ length: releaseFrames }, () => smoother.push(openHand()))
    expect(released.slice(0, releaseFrames - 1).map((result) => result?.mode)).toEqual(
      Array.from({ length: releaseFrames - 1 }, () => 'birthday'),
    )
    expect(released[releaseFrames - 1]).toBeNull()
  })

  it('清晰分开的两指会让中位数翻过退出阈值，捏合结束', () => {
    const smoother = new PinchSmoother()
    for (let index = 0; index < PINCH_WINDOW_FRAMES; index += 1) smoother.push(pinchHand())
    // 拇指松开 0.20（比值 0.67 > 0.52 退出阈值）。
    const wide = pinchHand({ thumbGap: 0.2 })
    expect(pinchRatioOf(wide)).toBeGreaterThan(PINCH_EXIT_RATIO)
    smoother.push(wide)
    smoother.push(wide)
    smoother.push(wide)
    expect(smoother.push(wide)).toBeNull()
  })

  it('reset 之后需要重新累积帧数', () => {
    const smoother = new PinchSmoother()
    for (let index = 0; index < PINCH_WINDOW_FRAMES; index += 1) smoother.push(pinchHand())
    smoother.reset()
    expect(smoother.push(pinchHand())).toBeNull()
  })

  it('进入阈值本身是相对量：掌尺度变化时阈值语义不变', () => {
    expect(PINCH_ENTER_RATIO).toBeGreaterThan(0)
    expect(PINCH_ENTER_RATIO).toBeLessThan(1)
  })
})

describe('校准页诊断（describeHand 只读导出）', () => {
  it('真人捏合姿势：pinchObserved 成立、blockers 为空，其余三指伸直数如实显示为 0', () => {
    const hand = describeHand(naturalPinchHand())
    expect(hand).not.toBeNull()
    if (!hand) return
    expect(hand.pinchRatio).toBeLessThan(PINCH_ENTER_RATIO)
    expect(hand.pinchZone).toBe('below-enter')
    expect(hand.indexExtended).toBe(true)
    expect(hand.otherExtended).toBe(0)
    expect(hand.pinchObserved).toBe(true)
    expect(hand.blockers).toEqual([])
    // 「计入捏合判定」这一列现在只有食指是 true —— 页面不再显示一个已经不存在的门槛。
    expect(hand.fingers.filter((finger) => finger.countsTowardPinch).map((finger) => finger.key)).toEqual(['index'])
    expect(hand.thresholds.indexMinRatio).toBe(FINGER_EXTENSION_WRIST_RATIO)
  })

  it('握拳姿势：blockers 只指出食指这一条，不再出现「其余三指伸直数」这种已删除的门槛', () => {
    const hand = describeHand(fistHand())
    expect(hand).not.toBeNull()
    if (!hand) return
    expect(hand.pinchObserved).toBe(false)
    expect(hand.blockers).toHaveLength(1)
    expect(hand.blockers[0]).toContain('食指不伸直')
    expect(hand.blockers[0]).toContain(`${FINGER_EXTENSION_MIN_ANGLE_DEG}°`)
    expect(hand.blockers.join('；')).not.toContain('其余三指')
    expect(hand.indexExtended).toBe(false)
    expect(hand.otherExtended).toBe(0)
  })

  it('差一点成立时可以精确定位到食指 PIP 角这一条', () => {
    const hand = describeHand(naturalPinchHand(125))
    expect(hand).not.toBeNull()
    if (!hand) return
    const indexFinger = hand.fingers.find((finger) => finger.key === 'index')
    expect(indexFinger?.pipAngleDeg).toBeCloseTo(125, 0)
    // 腕比值仍然达标，所以瓶颈就在角度上（页面据此给出「放宽到多少度就能过」的建议）。
    expect(indexFinger?.wristTipRatio).toBeGreaterThan(FINGER_EXTENSION_WRIST_RATIO)
    expect(hand.blockers).toHaveLength(1)
    expect(hand.blockers[0]).toContain('125.0°')
  })

  it('关键点不足 21 个时返回 null（此时产品侧本来也识别不到手势）', () => {
    expect(describeHand(fistHand().slice(0, 12))).toBeNull()
  })
})

describe('抖动抑制与误识别保护', () => {
  it('识别不到手势时不触发任何切换，画面保持当前样式', () => {
    const tracker = new GestureStabilityTracker()
    const first = tracker.update(null, 0)
    const second = tracker.update(null, 5000)
    expect(first.trigger).toBeNull()
    expect(second.trigger).toBeNull()
    expect(first.status).toBe('unrecognized')
    expect(second.status).toBe('unrecognized')
  })

  it('短暂噪声（A → 识别不到 → B）不会误触发，且丢失的时间不计入保持时间', () => {
    const tracker = new GestureStabilityTracker()
    tracker.update(detected('galaxy'), 0)
    expect(tracker.update(detected('galaxy'), 700).trigger).toBe('galaxy')

    tracker.update(detected('pig'), 760)
    /**
     * 这一帧的 60ms 空档落在 LOSS_TOLERANCE_MS(150) 内，因此**不再清零**候选 —— 这正是本次
     * 修复的目标行为（旧实现在这里清零，于是真人抖动几帧就永远攒不满 HOLD_MS）。
     * 时间轴随之变化：候选起点 760、丢失 60ms，所以触发时刻 = 760 + HOLD_MS + 60 = 1520。
     * 断言因此改成钉住「触发必须正好发生在真正识别到 HOLD_MS 的那一刻」，比原来更紧：
     * 早 1ms 也不允许触发（丢失的时间没有被白送成保持时间）。
     */
    tracker.update(null, 900)
    tracker.update(detected('pig'), 960)
    expect(tracker.update(detected('pig'), 1200).trigger).toBeNull()

    const lossMs = 960 - 900
    expect(lossMs).toBeLessThanOrEqual(LOSS_TOLERANCE_MS)
    const triggerAt = 760 + HOLD_MS + lossMs
    expect(triggerAt).toBe(1520)
    expect(tracker.update(detected('pig'), triggerAt - 1).trigger).toBeNull()
    expect(tracker.update(detected('pig'), triggerAt).trigger).toBe('pig')
  })

  it('【核心修复】保持窗口内短暂丢失（1~2 帧 null）后仍能触发，且总时长真的达到 HOLD_MS', () => {
    const tracker = new GestureStabilityTracker()
    const start = tracker.update(detected('birthday'), 0)
    expect(start.candidate).toBe('birthday')

    // 200ms 处丢 2 帧（30fps 下约 66ms），300ms 处恢复。
    const dropped = tracker.update(null, 200)
    expect(dropped.status).toBe('unrecognized')
    // 候选被保留（不再清零），但丢失的时间没有计入保持时间。
    expect(dropped.candidate).toBe('birthday')
    expect(dropped.progress).toBeCloseTo(200 / HOLD_MS, 5)

    tracker.update(detected('birthday'), 300)
    // 300ms 时真正识别到的时间只有 200ms。
    const at300 = tracker.update(detected('birthday'), 300)
    expect(at300.progress).toBeCloseTo(200 / HOLD_MS, 5)

    // 丢失 100ms → 触发时刻 = 0 + HOLD_MS + 100 = 800。
    expect(tracker.update(detected('birthday'), 799).trigger).toBeNull()
    expect(tracker.update(detected('birthday'), 800).trigger).toBe('birthday')
  })

  it('【核心修复】反复抖动（每 4 帧掉 1 帧）不再让保持进度永远停在 0', () => {
    const tracker = new GestureStabilityTracker()
    let triggers = 0
    // 100ms 一帧、每第 4 帧识别不到：改动前 6 秒内 progress 恒为 0.00、一次都不触发。
    for (let frame = 0; frame <= 30; frame += 1) {
      const result = tracker.update(frame % 4 === 3 ? null : detected('birthday'), frame * 100)
      if (result.trigger) triggers += 1
    }
    expect(triggers).toBe(1)
  })

  it('【核心修复】丢失超过容忍窗口后回到旧行为：清零、重新计时', () => {
    const tracker = new GestureStabilityTracker()
    tracker.update(detected('pig'), 0)
    // 第一帧丢失（t=100）：容忍窗口从这里开始算。
    const firstDrop = tracker.update(null, 100)
    expect(firstDrop.candidate).toBe('pig')
    expect(firstDrop.progress).toBeCloseTo(100 / HOLD_MS, 5)

    // 正好用满容忍窗口（丢失 150ms）：仍然保留，进度冻结在丢失开始那一刻。
    const atLimit = tracker.update(null, 100 + LOSS_TOLERANCE_MS)
    expect(atLimit.candidate).toBe('pig')
    expect(atLimit.progress).toBeCloseTo(100 / HOLD_MS, 5)

    // 超过容忍窗口 1ms：候选被清零，进度归零，完全回到改动前的行为。
    const expired = tracker.update(null, 100 + LOSS_TOLERANCE_MS + 1)
    expect(expired.status).toBe('unrecognized')
    expect(expired.candidate).toBeNull()
    expect(expired.progress).toBe(0)

    // 之后重新计时：必须从「再次识别到」那一刻起重新攒满 HOLD_MS。
    const restartAt = 1000
    tracker.update(detected('pig'), restartAt)
    expect(tracker.update(detected('pig'), restartAt + HOLD_MS - 1).trigger).toBeNull()
    expect(tracker.update(detected('pig'), restartAt + HOLD_MS).trigger).toBe('pig')
  })

  it('容忍的丢失不会被算成抖动（不推高 streak / 不触发加罚时）', () => {
    const tracker = new GestureStabilityTracker()
    // 5 个来回的「识别到 100ms → 丢 50ms」，全部落在容忍窗口内：一次也不能记成候选更替。
    let now = 0
    for (let round = 0; round < 5; round += 1) {
      const held = tracker.update(detected('birthday'), now)
      expect(held.unstable).toBe(false)
      now += 100
      const dropped = tracker.update(null, now)
      expect(dropped.candidate).toBe('birthday')
      now += 50
    }
    // 累计识别到的时间 = 5 × 100 = 500ms < 700ms，所以还没触发。
    expect(now).toBe(750)
    expect(tracker.update(detected('birthday'), now).trigger).toBeNull()
    expect(tracker.update(detected('birthday'), now + 200).trigger).toBe('birthday')
  })

  it('丢失期间的 candidate/progress 仍然如实上报（校准页据此观察保留状态）', () => {
    const tracker = new GestureStabilityTracker()
    tracker.update(detected('closing'), 0)
    tracker.update(detected('closing'), 350)
    const dropped = tracker.update(null, 400)
    expect(dropped.status).toBe('unrecognized')
    expect(dropped.candidate).toBe('closing')
    expect(dropped.mode).toBeNull()
    expect(dropped.trigger).toBeNull()
    // 进度冻结在丢失开始那一刻（400 - 0 = 400ms），不会随着丢失继续增长。
    expect(dropped.progress).toBeCloseTo(400 / HOLD_MS, 5)
    const laterDrop = tracker.update(null, 500)
    expect(laterDrop.progress).toBeCloseTo(400 / HOLD_MS, 5)
  })

  it('正常的手势切换在 700ms 保持窗口内立即触发，不被抖动抑制推迟', () => {
    const tracker = new GestureStabilityTracker()
    tracker.update(detected('galaxy'), 0)
    expect(tracker.update(detected('galaxy'), 700).trigger).toBe('galaxy')
    tracker.update(detected('closing'), 800)
    expect(tracker.update(detected('closing'), 1400).trigger).toBeNull()
    expect(tracker.update(detected('closing'), 1500).trigger).toBe('closing')
  })

  it('连续更替 UNSTABLE_STREAK 次后保持窗口才略微延长，且标记 unstable', () => {
    const tracker = new GestureStabilityTracker()
    // 只用前三个姿势来回换，保证随后切到 birthday 一定是一次「更替」（候选起点会重置）。
    const churn = ['galaxy', 'pig', 'closing'] as const

    // 时间轴：每 200ms 换一个姿势（远小于 UNSTABLE_WINDOW_MS，所以这些更替都留在计数窗口里）。
    // 实现只在「候选姿势变化」时重置候选起点，所以第 UNSTABLE_STREAK 次更替那一帧就是候选起点。
    for (let index = 0; index < UNSTABLE_STREAK; index += 1) {
      tracker.update(detected(churn[index % churn.length]), index * 200)
    }
    const candidateSince = UNSTABLE_STREAK * 200
    tracker.update(detected('birthday'), candidateSince)

    // 抖动成立（窗口内更替数 >= UNSTABLE_STREAK）→ 保持窗口变成 HOLD_MS + UNSTABLE_HOLD_PENALTY_MS。
    // candidateSince + HOLD_MS 这一帧按正常窗口本该触发，延长后必须还停在 holding。
    const early = tracker.update(detected('birthday'), candidateSince + HOLD_MS)
    expect(early.trigger).toBeNull()
    expect(early.unstable).toBe(true)

    // 触发时刻 = 候选起点 + 延长后的窗口。原用例写的是 700 + 200 = 900，那是把「窗口长度 900ms」
    // 当成了绝对时间戳；候选起点是 600ms，900 只比它晚 300ms，必然还是 null —— 用例时间轴写错，
    // 不是实现的问题（900 之前本来就不该触发）。
    expect(tracker.update(detected('birthday'), candidateSince + HOLD_MS + UNSTABLE_HOLD_PENALTY_MS).trigger)
      .toBe('birthday')
  })

  it('抖动计数会随窗口滑出而恢复，长时间正常使用不会一直被惩罚', () => {
    const tracker = new GestureStabilityTracker()
    const churn = ['galaxy', 'pig', 'closing'] as const

    // 连换 UNSTABLE_STREAK 次（每次间隔 100ms）→ 抖动成立，最后一次更替落在 lastChurnAt。
    let lastChurnAt = 0
    for (let index = 0; index < UNSTABLE_STREAK; index += 1) {
      lastChurnAt = index * 100
      tracker.update(detected(churn[index % churn.length]), lastChurnAt)
    }
    // 抖动成立时，同一个候选要多等 UNSTABLE_HOLD_PENALTY_MS：只保持 HOLD_MS - 1 还不够。
    const penalized = tracker.update(detected('closing'), lastChurnAt + HOLD_MS - 1)
    expect(penalized.unstable).toBe(true)
    expect(penalized.trigger).toBeNull()

    // 让更替记录滑出计数窗口（最后一次更替在 lastChurnAt，窗口 UNSTABLE_WINDOW_MS），
    // 此时换一个全新候选：只有这一次新更替被计入，streak 回到 1，保持窗口恢复成 HOLD_MS。
    const quietAt = lastChurnAt + UNSTABLE_WINDOW_MS + 1
    const fresh = tracker.update(detected('birthday'), quietAt)
    expect(fresh.unstable).toBe(false)
    expect(fresh.trigger).toBeNull()
    expect(fresh.candidate).toBe('birthday')
    expect(tracker.update(detected('birthday'), quietAt + HOLD_MS - 1).trigger).toBeNull()
    expect(tracker.update(detected('birthday'), quietAt + HOLD_MS).trigger).toBe('birthday')
  })

  it('识别不到时会报告当前保持进度，便于反馈条显示「正在等你保持住」', () => {
    const tracker = new GestureStabilityTracker()
    const start = tracker.update(detected('pig'), 0)
    const half = tracker.update(detected('pig'), 350)
    expect(start.candidate).toBe('pig')
    expect(half.status).toBe('holding')
    expect(half.progress).toBeGreaterThan(0.4)
    expect(half.progress).toBeLessThan(0.6)
  })

  it('锁定中的手势短暂消失（低于 release 窗口）不会被当成新手势重新计时', () => {
    const tracker = new GestureStabilityTracker()
    tracker.update(detected('pig'), 0)
    expect(tracker.update(detected('pig'), 700).trigger).toBe('pig')
    // 100ms 的识别丢失 < RELEASE_MS(250)，随后同一手势恢复，不应该再触发一次。
    tracker.update(null, 800)
    expect(tracker.update(detected('pig'), 900).trigger).toBeNull()
    expect(tracker.update(detected('pig'), 2000).trigger).toBeNull()
  })
})

describe('同一个手势可重复触发（需求 3.4.3）', () => {
  it('同一个手势离开后再做一次可以再次触发', () => {
    const tracker = new GestureStabilityTracker()
    tracker.update(detected('birthday'), 0)
    expect(tracker.update(detected('birthday'), 700).trigger).toBe('birthday')
    tracker.update(null, 900)
    tracker.update(null, 1200)
    tracker.update(detected('birthday'), 1400)
    expect(tracker.update(detected('birthday'), 2100).trigger).toBe('birthday')
  })

  it('在两个样式之间来回切换可以重复进入', () => {
    const tracker = new GestureStabilityTracker()
    tracker.update(detected('pig'), 0)
    expect(tracker.update(detected('pig'), 700).trigger).toBe('pig')
    tracker.update(detected('birthday'), 900)
    expect(tracker.update(detected('birthday'), 1600).trigger).toBe('birthday')
    tracker.update(detected('pig'), 1800)
    expect(tracker.update(detected('pig'), 2500).trigger).toBe('pig')
    tracker.update(detected('birthday'), 2700)
    expect(tracker.update(detected('birthday'), 3400).trigger).toBe('birthday')
  })
})

describe('样式切换闸门（短冷却，不挡正常切换）', () => {
  it('冷却窗口内的第二次换样式被挡住', () => {
    const guard = createModeSwitchGuard()
    expect(guard.allow(0)).toBe(true)
    expect(guard.allow(MODE_SWITCH_COOLDOWN_MS - 1)).toBe(false)
    expect(guard.allow(MODE_SWITCH_COOLDOWN_MS)).toBe(true)
  })

  it('冷却远小于手势保持窗口，正常切换不会被推迟', () => {
    expect(MODE_SWITCH_COOLDOWN_MS).toBeLessThan(700)
    const guard = createModeSwitchGuard()
    expect(guard.allow(1000)).toBe(true)
    expect(guard.allow(1000 + 700)).toBe(true)
  })

  it('reset 后立即允许切换', () => {
    const guard = createModeSwitchGuard()
    expect(guard.allow(500)).toBe(true)
    expect(guard.allow(600)).toBe(false)
    guard.reset()
    expect(guard.allow(600)).toBe(true)
  })

  it('识别门限未被削弱：置信度低于阈值的手势一律不成立', () => {
    const tracker = new GestureStabilityTracker()
    const weak = detected('closing', CONFIDENCE_THRESHOLD - 0.01)
    tracker.update(weak, 0)
    expect(tracker.update(weak, 2000).trigger).toBeNull()
  })
})
