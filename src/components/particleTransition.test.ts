import { describe, expect, it } from 'vitest'
import {
  TRANSITION_DISPERSION,
  TRANSITION_GATHER,
  TRANSITION_MAX_DELAY,
  ParticleTransition,
  delayDuration,
  dispersionOffset,
  easeInOutCubic,
  hashUnit,
  scrambleTargetOrder,
} from './particleTransition'
import { pigRegionAt, resample, type ShapePoint } from './particleShapes'
import { createFireworkField, spawnFireworkWave, updateFireworks } from './particleFireworks'

const SEEDS = [1, 2, 3, 7, 11, 29, 97, 512, 1024, 2048]

function step(transition: ParticleTransition, milliseconds: number, stepMs = 16) {
  const frames = Math.round(milliseconds / stepMs)
  for (let frame = 0; frame < frames; frame += 1) transition.advance(stepMs / 1000)
}

describe('easeInOutCubic', () => {
  it('两端固定、中点对称', () => {
    expect(easeInOutCubic(0)).toBe(0)
    expect(easeInOutCubic(1)).toBe(1)
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 6)
    expect(easeInOutCubic(0.25) + easeInOutCubic(0.75)).toBeCloseTo(1, 6)
  })

  it('越界输入被钳制，缓动不会外插', () => {
    expect(easeInOutCubic(-3)).toBe(0)
    expect(easeInOutCubic(9)).toBe(1)
  })

  it('中段速度快于首尾（有加速与减速，而不是线性）', () => {
    const start = easeInOutCubic(0.1)
    const middle = easeInOutCubic(0.5) - easeInOutCubic(0.4)
    const end = easeInOutCubic(1) - easeInOutCubic(0.9)
    expect(start).toBeLessThan(middle)
    expect(end).toBeLessThan(middle)
  })
})

describe('ParticleTransition', () => {
  it('先扩散再收拢：扩散阶段不聚形，收拢阶段才向目标推进', () => {
    const transition = new ParticleTransition()
    expect(transition.gatherWeight(1)).toBe(0)
    expect(transition.dispersionBlend).toBe(0)

    step(transition, TRANSITION_DISPERSION * 500)
    expect(transition.dispersionBlend).toBeGreaterThan(0.9)
    expect(transition.gatherWeight(1)).toBe(0)

    step(transition, TRANSITION_DISPERSION * 600)
    // 收拢的启动时间被逐粒子推迟，所以这里必须等到超过最大延迟才会看到进度。
    expect(transition.dispersionBlend).toBe(0)
    step(transition, TRANSITION_MAX_DELAY * 1000 + 40)
    expect(transition.gatherWeight(1)).toBeGreaterThan(0)
  })

  it('扩散强度是 0→1→0 的脉冲，不是一直往外推', () => {
    const transition = new ParticleTransition()
    const samples: number[] = []
    for (let frame = 0; frame < 30; frame += 1) {
      transition.advance(0.016)
      samples.push(transition.dispersionBlend)
    }
    expect(samples[0]).toBeLessThan(samples[Math.floor(samples.length / 2)])
    expect(samples[samples.length - 1]).toBeLessThan(samples[Math.floor(samples.length / 2)])
    expect(Math.max(...samples)).toBeLessThanOrEqual(1)
  })

  it('收拢权重逐帧单调不减，且最终归位', () => {
    const transition = new ParticleTransition()
    let previous = 0
    for (let frame = 0; frame < 120; frame += 1) {
      transition.advance(0.016)
      const weight = transition.gatherWeight(3)
      expect(weight).toBeGreaterThanOrEqual(previous)
      previous = weight
    }
    expect(transition.isRunning).toBe(false)
    expect(previous).toBeCloseTo(1, 6)
  })

  it('每颗粒子的启动时间被打散，不会同时到位', () => {
    const transition = new ParticleTransition()
    step(transition, TRANSITION_DISPERSION * 1000 + 120)
    const weights = SEEDS.map((seed) => transition.gatherWeight(seed))
    expect(new Set(weights.map((weight) => weight.toFixed(3))).size).toBeGreaterThan(1)
    expect(Math.max(...weights)).toBeGreaterThan(Math.min(...weights))
  })

  it('重复触发会重新播放完整编排（可重复进入同一目标）', () => {
    const transition = new ParticleTransition()
    step(transition, 4000)
    expect(transition.isRunning).toBe(false)
    expect(transition.gatherWeight(1)).toBe(1)
    transition.restart()
    expect(transition.isRunning).toBe(true)
    expect(transition.gatherWeight(1)).toBe(0)
    expect(transition.dispersionBlend).toBe(0)
  })

  it('finish 直接落到终态，用于重置时不空转', () => {
    const transition = new ParticleTransition()
    transition.finish()
    expect(transition.isRunning).toBe(false)
    expect(transition.gatherWeight(5)).toBe(1)
    expect(transition.progress).toBe(1)
  })

  it('位置不跳变：收拢权重上任一帧都不会突然跳到高位', () => {
    const transition = new ParticleTransition()
    // 扩散刚结束的那一帧是最容易"瞬移"的位置，单独检查。
    step(transition, TRANSITION_DISPERSION * 1000 + 16)
    expect(transition.gatherWeight(9)).toBeLessThan(0.05)
    let previous = 0
    let maxStep = 0
    for (let frame = 0; frame < 150; frame += 1) {
      transition.advance(1 / 60)
      const weight = transition.gatherWeight(9)
      maxStep = Math.max(maxStep, weight - previous)
      previous = weight
    }
    expect(maxStep).toBeLessThan(0.35)
    expect(previous).toBeCloseTo(1, 6)
  })

  it('总时长与常量一致（一次切换在一秒半内完成）', () => {
    const transition = new ParticleTransition()
    expect(transition.total).toBeCloseTo(TRANSITION_DISPERSION + TRANSITION_GATHER + TRANSITION_MAX_DELAY, 6)
    expect(transition.total).toBeLessThan(1.6)
    step(transition, transition.total * 1000 + 40)
    expect(transition.isRunning).toBe(false)
    for (const seed of SEEDS) expect(transition.gatherWeight(seed)).toBe(1)
  })
})

describe('dispersionOffset', () => {
  it('无扩散时不给位移', () => {
    expect(dispersionOffset(4, 0, 0.016)).toEqual({ x: 0, y: 0 })
  })

  it('方向由粒子种子决定，同一粒子方向稳定', () => {
    const first = dispersionOffset(6, 0.8, 0.016)
    const second = dispersionOffset(6, 0.8, 0.016)
    expect(first).toEqual(second)
    expect(Math.hypot(first.x, first.y)).toBeGreaterThan(0)
  })

  it('不同粒子的扩散方向不同（形成湍流而不是整体平移）', () => {
    const angles = SEEDS.map((seed) => {
      const offset = dispersionOffset(seed, 1, 0.016)
      return Math.atan2(offset.y, offset.x).toFixed(3)
    })
    expect(new Set(angles).size).toBeGreaterThan(SEEDS.length / 2)
  })
})

describe('目标打散分配', () => {
  it('返回完整置换：每个目标索引恰好用一次', () => {
    const order = scrambleTargetOrder(600, 42)
    expect(order).toHaveLength(600)
    expect(new Set(order).size).toBe(600)
    expect([...order].sort((a, b) => a - b)[0]).toBe(0)
    expect([...order].sort((a, b) => a - b)[599]).toBe(599)
  })

  it('打散后与索引刚性对应明显不同（避免"面条"式聚拢）', () => {
    const order = scrambleTargetOrder(500, 7)
    const identical = order.filter((value, index) => value === index).length
    expect(identical).toBeLessThan(500 * 0.05)
  })

  it('同一种子结果稳定，不同种子结果不同', () => {
    expect(scrambleTargetOrder(200, 3)).toEqual(scrambleTargetOrder(200, 3))
    expect(scrambleTargetOrder(200, 3)).not.toEqual(scrambleTargetOrder(200, 4))
  })

  it('数量为 0 或 1 时不报错', () => {
    expect(scrambleTargetOrder(0)).toEqual([])
    expect(scrambleTargetOrder(1)).toEqual([0])
  })

  it('hashUnit 与 delayDuration 落在预期范围内', () => {
    for (const seed of SEEDS) {
      const hash = hashUnit(seed)
      expect(hash).toBeGreaterThanOrEqual(0)
      expect(hash).toBeLessThan(1)
      const delay = delayDuration(seed)
      expect(delay).toBeGreaterThanOrEqual(0)
      expect(delay).toBeLessThanOrEqual(TRANSITION_MAX_DELAY)
    }
  })

  it('启动延迟确实被用上：不同粒子的收拢进度在同一时刻不同', () => {
    const delays = SEEDS.map((seed) => delayDuration(seed))
    expect(Math.max(...delays) - Math.min(...delays)).toBeGreaterThan(TRANSITION_MAX_DELAY * 0.5)
  })
})

describe('resample', () => {
  const shape: ShapePoint[] = [
    ...Array.from({ length: 60 }, (_, index) => ({ x: index, y: index, color: [255, 255, 255] as [number, number, number] })),
    { x: 1, y: 1, color: [255, 255, 255] as [number, number, number], priority: true },
    { x: 2, y: 2, color: [255, 255, 255] as [number, number, number], priority: true },
  ]

  it('低预算下仍然保留眼睛高光这类 priority 点', () => {
    const small = resample(shape, 20)
    expect(small).toHaveLength(20)
    expect(small.filter((point) => point.priority).length).toBe(2)
  })

  it('高预算下也保留 priority 点，且输出长度与预算一致', () => {
    const large = resample(shape, 400)
    expect(large).toHaveLength(400)
    expect(large.filter((point) => point.priority).length).toBeGreaterThanOrEqual(2)
  })

  it('空形状返回空数组而不是抛错', () => {
    expect(resample([], 100)).toEqual([])
  })
})

describe('猪头分区', () => {
  it('眼睛、鼻子、腮红、耳朵各归其位', () => {
    expect(pigRegionAt(0.365, 0.535)).toBe('eye')
    expect(pigRegionAt(0.638, 0.542)).toBe('eye')
    expect(pigRegionAt(0.512, 0.604)).toBe('nose')
    expect(pigRegionAt(0.31, 0.59)).toBe('blush')
    expect(pigRegionAt(0.66, 0.62)).toBe('blush')
    expect(pigRegionAt(0.24, 0.3)).toBe('ear-left')
    expect(pigRegionAt(0.78, 0.32)).toBe('ear-right')
  })

  it('眼白高光的采样点会落在 eye 分区（低预算也要保住）', () => {
    for (const eyeX of [0.365, 0.638]) {
      expect(pigRegionAt(eyeX, 0.529)).toBe('eye')
    }
  })

  it('腮红不会被眼睛分区吞掉', () => {
    expect(pigRegionAt(0.30, 0.56)).toBe('blush')
    expect(pigRegionAt(0.69, 0.60)).toBe('blush')
  })

  it('脸颊与下巴落在 face 分区，耳朵弹动不会带走脸', () => {
    expect(pigRegionAt(0.5, 0.8)).toBe('face')
    expect(pigRegionAt(0.47, 0.45)).toBe('face')
  })

  it('耳朵只占两侧外扩区域，头部中央不会被误判为耳朵', () => {
    expect(pigRegionAt(0.5, 0.25)).toBe('face')
    expect(pigRegionAt(0.4, 0.3)).toBe('face')
  })
})

describe('轻量烟花', () => {
  it('净空后没有残留粒子或闪光', () => {
    const field = createFireworkField()
    expect(field.particles).toHaveLength(0)
    expect(field.flashes).toHaveLength(0)
    updateFireworks(field, 0.016)
    expect(field.particles).toHaveLength(0)
  })

  it('发射点在文字下方、爆发点在文字上方，不会长时间遮挡文字', () => {
    const width = 749
    const height = 613
    const halfHeight = height * 0.235 * 1.08
    for (let round = 0; round < 12; round += 1) {
      const field = createFireworkField()
      spawnFireworkWave(field, width, height, halfHeight, 'high', 1200)
      const textTop = height / 2 - halfHeight
      const textBottom = height / 2 + halfHeight
      expect(field.flashes[0].y).toBeLessThan(textTop)
      for (const particle of field.particles) {
        expect(particle.y).toBeGreaterThan(textBottom)
        // 发射方向朝上：拖尾阶段一定是向爆发点接近的。
        expect(particle.vy).toBeLessThan(0)
      }
    }
  })

  it('爆发后总时长控制在 2.5 秒内淡出（轻量硬要求）', () => {
    const field = createFireworkField()
    spawnFireworkWave(field, 749, 613, 150, 'high', 1200)
    const longestLife = Math.max(...field.particles.map((particle) => particle.life))
    expect(longestLife).toBeLessThan(2.5)
    expect(field.particles.length).toBeLessThanOrEqual(1200 * 0.2)
  })

  it('粒子寿命到期后被回收，不会无限增长', () => {
    const field = createFireworkField()
    field.particles.push(
      { x: 0, y: 0, vx: 10, vy: -10, age: 0, fuse: 0.1, life: 0.5, size: 1, color: [255, 255, 255] },
      { x: 0, y: 0, vx: 10, vy: -10, age: 0.45, fuse: 0.1, life: 0.5, size: 1, color: [255, 255, 255] },
    )
    updateFireworks(field, 0.1)
    expect(field.particles).toHaveLength(1)
    updateFireworks(field, 0.5)
    expect(field.particles).toHaveLength(0)
  })

  it('拖尾阶段向上飞、爆发后受重力下落并阻尼衰减', () => {
    const field = createFireworkField()
    field.particles.push({ x: 0, y: 100, vx: 0, vy: -120, age: 0, fuse: 0.4, life: 2, size: 1, color: [255, 255, 255] })
    updateFireworks(field, 0.2)
    const trail = field.particles[0]
    expect(trail.vy).toBeLessThan(0)
    expect(trail.y).toBeLessThan(100)

    field.particles[0].age = 0.4
    field.particles[0].vx = 150
    field.particles[0].vy = 0
    updateFireworks(field, 0.2)
    const burst = field.particles[0]
    expect(burst.vy).toBeGreaterThan(0)
    expect(burst.vx).toBeLessThan(150)
    expect(Math.abs(burst.vx)).toBeGreaterThan(0)
  })
})
