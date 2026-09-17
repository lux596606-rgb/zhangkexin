export type QualityTier = 'high' | 'medium' | 'low'

export const QUALITY_TIERS: QualityTier[] = ['low', 'medium', 'high']

/** 滑动窗口长度：约 1.5 秒（60fps 下约 90 帧），既能反映真实负载又不会被单帧卡顿带偏。 */
export const FRAME_WINDOW_SIZE = 90
/** 平均帧间隔上限：标签页切回后首帧间隔可能极大，钳制后只按最差约 4fps 计入，避免污染均值。 */
export const MAX_FRAME_DELTA = 250
/** 降档阈值：平均 FPS 连续低于该值即认为当前档位太重。 */
export const DEGRADE_FPS = 45
/** 升档阈值：平均 FPS 高于该值且有裕量时才考虑升档。 */
export const UPGRADE_FPS = 55
/** 最短驻留时间：档位变化后 3 秒内不再变化，避免在阈值附近来回抖动。 */
export const MIN_DWELL_MS = 3000
/** 低于阈值需要持续的时长（迟滞的确认窗口）。 */
export const SUSTAIN_DEGRADE_MS = 900
/** 高于阈值需要持续的时长，比降档更长，形成不对称迟滞。 */
export const SUSTAIN_UPGRADE_MS = 2400

export const QUALITY_TIER_SCALE: Record<QualityTier, { particles: number; resolution: number; fireworkWaves: number }> = {
  high: { particles: 1, resolution: 1, fireworkWaves: 2 },
  medium: { particles: 0.78, resolution: 0.82, fireworkWaves: 1 },
  low: { particles: 0.55, resolution: 0.6, fireworkWaves: 1 },
}

/**
 * 非银河样式（文字、猪头）的密度加成：这两种样式靠点阵本身认形状，
 * 基准预算按面积算出来的量级偏疏，加成后 high 档落在 2000~2400 之间。
 */
export const SHAPE_PARTICLE_SCALE = 1.5
/** 粒子数量硬上限：加成之后仍然是硬约束，低档与自适应降档才有意义。 */
export const MAX_PARTICLE_COUNT = 2400

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

/**
 * 渲染帧率滑动窗口。只依赖外部注入的时间戳，便于单测在不碰 requestAnimationFrame 的情况下复现负载。
 */
export class FrameStats {
  private readonly deltas: number[] = []
  private readonly capacity: number
  private cursor = 0
  private filled = 0
  private total = 0
  private previous: number | null = null

  constructor(capacity: number = FRAME_WINDOW_SIZE) {
    this.capacity = capacity
  }

  /** 记录一帧；传入负数表示窗口被重置，用于暂停恢复等不该计入均值的时刻。 */
  update(now: number): void {
    if (now < 0) {
      this.reset()
      return
    }
    if (this.previous === null) {
      this.previous = now
      return
    }
    const delta = clamp(now - this.previous, 0, MAX_FRAME_DELTA)
    this.previous = now
    if (this.filled === this.capacity) this.total -= this.deltas[this.cursor]
    else this.filled += 1
    this.deltas[this.cursor] = delta
    this.total += delta
    this.cursor = (this.cursor + 1) % this.capacity
  }

  get sampleCount(): number {
    return this.filled
  }

  /** 窗口样本不足时返回 null，避免刚启动就用一两帧数据做档位决策。 */
  averageFps(): number | null {
    if (this.filled < 4 || this.total <= 0) return null
    return 1000 / (this.total / this.filled)
  }

  reset(): void {
    this.deltas.length = 0
    this.cursor = 0
    this.filled = 0
    this.total = 0
    this.previous = null
  }
}

type ControllerOptions = {
  tier?: QualityTier
  reducedMotion?: boolean
  minDwellMs?: number
  upgradeFps?: number
  degradeFps?: number
}

/**
 * 档位决策：只有"持续"偏离阈值才动档，且两次变更之间必须超过最短驻留时间。
 * 单帧抖动（例如一次 GC 卡顿）不会触发降档，档位也就不会反复横跳。
 */
export class QualityController {
  private current: QualityTier
  private lastChangeAt = 0
  private started = false
  private upgradeSince: number | null = null
  private degradeSince: number | null = null
  private reducedMotion: boolean
  private readonly minDwellMs: number
  private readonly upgradeFps: number
  private readonly degradeFps: number

  constructor(options: ControllerOptions = {}) {
    this.reducedMotion = options.reducedMotion ?? false
    this.current = this.reducedMotion ? 'low' : options.tier ?? 'high'
    this.minDwellMs = options.minDwellMs ?? MIN_DWELL_MS
    this.upgradeFps = options.upgradeFps ?? UPGRADE_FPS
    this.degradeFps = options.degradeFps ?? DEGRADE_FPS
  }

  get tier(): QualityTier {
    return this.current
  }

  get scale() {
    return QUALITY_TIER_SCALE[this.current]
  }

  /**
   * 每帧调用一次，返回本帧生效的档位。
   * 减少动态效果时固定低档：此时追求的是"少动"，不该因为帧率高就升档。
   */
  update(averageFps: number | null, now: number): QualityTier {
    if (!this.started) {
      this.started = true
      this.lastChangeAt = now
      return this.current
    }
    if (this.reducedMotion) {
      this.upgradeSince = null
      this.degradeSince = null
      if (this.current !== 'low') {
        this.current = 'low'
        this.lastChangeAt = now
      }
      return this.current
    }
    if (averageFps === null) return this.current

    // 迟滞：持续低帧才降档；持续高帧且已有足够驻留时间才升档。
    if (averageFps < this.degradeFps) {
      this.degradeSince ??= now
      this.upgradeSince = null
    } else if (averageFps > this.upgradeFps) {
      this.upgradeSince ??= now
      this.degradeSince = null
    } else {
      this.upgradeSince = null
      this.degradeSince = null
    }

    const dwelled = now - this.lastChangeAt >= this.minDwellMs
    if (!dwelled) return this.current

    if (this.degradeSince !== null && now - this.degradeSince >= SUSTAIN_DEGRADE_MS) {
      const next = QUALITY_TIERS[Math.max(0, QUALITY_TIERS.indexOf(this.current) - 1)]
      if (next !== this.current) {
        this.current = next
        this.lastChangeAt = now
        this.degradeSince = null
      }
    } else if (this.upgradeSince !== null && now - this.upgradeSince >= SUSTAIN_UPGRADE_MS) {
      const next = QUALITY_TIERS[Math.min(QUALITY_TIERS.length - 1, QUALITY_TIERS.indexOf(this.current) + 1)]
      if (next !== this.current) {
        this.current = next
        this.lastChangeAt = now
        this.upgradeSince = null
      }
    }
    return this.current
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced
  }
}

/**
 * 静态启发式只给出"基准预算"，真正的数量由档位缩放，再受帧率反馈修正。
 */
export function baseParticleBudget(width: number, height: number, reducedMotion: boolean): number {
  if (reducedMotion) return 300
  const areaCount = Math.round((width * height) / 250)
  const hardware = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4
  const memory = typeof navigator !== 'undefined' && 'deviceMemory' in navigator
    ? Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory) || 8
    : 8
  const capabilityScale = hardware <= 4 || memory <= 4 ? 0.68 : hardware >= 8 && memory >= 8 ? 1.08 : 0.86
  return clamp(Math.round(areaCount * capabilityScale), 520, 1500)
}

export function particleCountForTier(
  baseCount: number,
  tier: QualityTier,
  reducedMotion: boolean,
  densityScale = 1,
): number {
  if (reducedMotion) return Math.min(Math.round(baseCount * densityScale), 340)
  return clamp(Math.round(baseCount * densityScale * QUALITY_TIER_SCALE[tier].particles), 240, MAX_PARTICLE_COUNT)
}

export function devicePixelRatioForTier(baseDpr: number, tier: QualityTier): number {
  return clamp(baseDpr * QUALITY_TIER_SCALE[tier].resolution, 0.6, 2)
}

export function fireworkWaveCount(tier: QualityTier, reducedMotion: boolean): number {
  if (reducedMotion) return 0
  return QUALITY_TIER_SCALE[tier].fireworkWaves
}

/** 低档只放一波且粒子更少，保证"轻量"是硬约束而不是口号。 */
export function fireworkParticleCount(tier: QualityTier, budget: number): number {
  const ratio = tier === 'high' ? 0.13 : tier === 'medium' ? 0.1 : 0.07
  return Math.round(clamp(budget * ratio, 40, 220))
}
