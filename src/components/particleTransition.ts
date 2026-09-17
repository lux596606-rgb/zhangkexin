import { clamp } from './particleMath'

/** 先散开再聚拢的总编排时长。 */
export const TRANSITION_DISPERSION = 0.46
export const TRANSITION_GATHER = 0.74
/** 收拢的最大启动延迟：延迟加在扩散结束之后，避免第一帧就跳到 70% 位置（那才是"跳变"）。 */
export const TRANSITION_MAX_DELAY = 0.25

/** 分散阶段的向外推力（像素/秒）、衰减率与整体湍流。 */
const DISPERSION_IMPULSE = 96
const DISPERSION_DECAY = 3.2
const TURBULENCE = 26

export function easeInOutCubic(value: number): number {
  const t = clamp(value, 0, 1)
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

/**
 * 过渡编排：任何样式切换都先经历一段扩散/湍流，再缓动收拢到新目标。
 * 纯时间函数，不持有粒子状态，便于单测直接断言各阶段取值。
 */
export class ParticleTransition {
  private readonly dispersion: number
  private readonly gather: number
  private elapsed = 0
  private running = true

  constructor(dispersion: number = TRANSITION_DISPERSION, gather: number = TRANSITION_GATHER) {
    this.dispersion = dispersion
    this.gather = gather
  }

  /** 编排总时长含最大启动延迟，保证最后一颗粒子也收拢完成才判定结束。 */
  get total(): number {
    return this.dispersion + this.gather + TRANSITION_MAX_DELAY
  }

  /** 重新播放一次完整编排：同一目标重复触发也会重新散开再聚拢，不会突然跳变。 */
  restart(): void {
    this.elapsed = 0
    this.running = true
  }

  /** 立即结束编排（首次挂载、重置时避免无意义的空转）。 */
  finish(): void {
    this.elapsed = this.total
    this.running = false
  }

  advance(deltaSeconds: number): void {
    if (!this.running) return
    this.elapsed += Math.max(0, deltaSeconds)
    if (this.elapsed >= this.total) {
      this.elapsed = this.total
      this.running = false
    }
  }

  get isRunning(): boolean {
    return this.running
  }

  get progress(): number {
    return clamp(this.elapsed / this.total, 0, 1)
  }

  /** 扩散强度：0→1→0，峰值在扩散阶段中点。 */
  get dispersionBlend(): number {
    if (this.elapsed >= this.dispersion) return 0
    return Math.sin((this.elapsed / this.dispersion) * Math.PI)
  }

  /**
   * 收拢权重：每颗粒子错开 0~250ms 的启动时间，避免所有点同时到位、也避免等速前进的"面条"感。
   * 延迟加在扩散结束之后（而不是减在时间轴上），所以权重上任一帧都不会突然从 0 跳到高位。
   */
  gatherWeight(seed: number): number {
    if (this.elapsed <= this.dispersion) return 0
    return easeInOutCubic(clamp((this.elapsed - this.dispersion - delayDuration(seed)) / this.gather, 0, 1))
  }
}

/**
 * 扩散阶段的逐帧位移：方向由粒子种子决定并与收拢方向无关，
 * 于是"先散开再聚拢"是位置累积的结果，不需要额外的速度状态。
 */
export function dispersionOffset(seed: number, blend: number, deltaSeconds: number): { x: number; y: number } {
  if (blend <= 0) return { x: 0, y: 0 }
  const angle = (hashUnit(seed) * 2 - 1) * Math.PI
  const scale = blend * Math.max(0, deltaSeconds) * DISPERSION_DECAY
  return {
    x: Math.cos(angle) * DISPERSION_IMPULSE * scale,
    y: (Math.sin(angle) * DISPERSION_IMPULSE * 0.7 - TURBULENCE) * scale,
  }
}

/** 稳定的伪随机：同一粒子在任何一帧都拿到同一个相位，避免逐帧抖动。 */
export function hashUnit(seed: number): number {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453
  return value - Math.floor(value)
}

/** 每颗粒子错开 0~250ms 的收拢启动时间，破坏整齐划一的"面条"感。 */
export function delayDuration(seed: number): number {
  return hashUnit(seed * 1.7 + 0.31) * TRANSITION_MAX_DELAY
}

/**
 * 目标打散分配：按索引刚性对应会让相邻目标被相邻粒子接管，聚拢时看起来像面条。
 * 这里返回一个与 targetCount 等长的置换表，粒子的寻址顺序被打乱但全部索引只用一次。
 */
export function scrambleTargetOrder(count: number, seed = 1): number[] {
  const order = Array.from({ length: Math.max(0, Math.floor(count)) }, (_, index) => index)
  let state = (Math.floor(seed) || 1) >>> 0
  const nextUnit = () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(nextUnit() * (index + 1))
    const held = order[index]
    order[index] = order[swapWith]
    order[swapWith] = held
  }
  return order
}
