import { describe, expect, it } from 'vitest'
import {
  DEGRADE_FPS,
  FrameStats,
  MAX_FRAME_DELTA,
  MIN_DWELL_MS,
  QualityController,
  QUALITY_TIER_SCALE,
  UPGRADE_FPS,
  baseParticleBudget,
  devicePixelRatioForTier,
  fireworkParticleCount,
  fireworkWaveCount,
  particleCountForTier,
  type QualityTier,
} from './particleQuality'

const FPS_LOW = 30
const FPS_HIGH = 60
const FPS_JITTER = [40, 60, 38, 62, 41, 59, 39, 61]

/** 固定帧率模拟：帧间隔按目标帧率推进，档位决策同时读真实窗口均值。 */
function simulate(options: {
  fpsSeries: number[]
  seconds: number
  controller?: QualityController
  initialTier?: QualityTier
  windowSize?: number
}) {
  const stats = new FrameStats(options.windowSize)
  const controller = options.controller ?? new QualityController({ tier: options.initialTier ?? 'high' })
  const tiers: QualityTier[] = []
  // 用真实帧节奏推进：窗口填满需要时间，稳态均值才是决策依据。
  let now = 0
  const stepMs = 1000 / options.fpsSeries[0]
  const frames = Math.round((options.seconds * 1000) / stepMs)
  for (let frame = 0; frame <= frames; frame += 1) {
    const fps = options.fpsSeries[frame % options.fpsSeries.length]
    stats.update(now)
    const tier = controller.update(stats.averageFps() ?? fps, now)
    if (tiers[tiers.length - 1] !== tier) tiers.push(tier)
    now += 1000 / fps
  }
  return { tiers, controller, stats }
}

describe('FrameStats', () => {
  it('样本不足时不给平均值，避免刚启动就拿一两帧做决策', () => {
    const stats = new FrameStats()
    stats.update(0)
    stats.update(16)
    expect(stats.sampleCount).toBe(1)
    expect(stats.averageFps()).toBeNull()
  })

  it('按滑动窗口给出平均帧率', () => {
    const stats = new FrameStats()
    for (let frame = 0; frame < 40; frame += 1) stats.update(frame * (1000 / 50))
    expect(stats.averageFps()).toBeCloseTo(50, 1)
  })

  it('单帧巨大间隔被钳制，不会把均值算成 0', () => {
    const stats = new FrameStats()
    for (let frame = 0; frame < 6; frame += 1) stats.update(frame * 16)
    stats.update(80 + 5000)
    expect(MAX_FRAME_DELTA).toBe(250)
    expect(stats.averageFps()).toBeGreaterThan(4)
  })

  it('负时间戳表示重置窗口（暂停恢复后不拿旧数据决策）', () => {
    const stats = new FrameStats()
    for (let frame = 0; frame < 10; frame += 1) stats.update(frame * 33)
    expect(stats.sampleCount).toBe(9)
    stats.update(-1)
    expect(stats.sampleCount).toBe(0)
    expect(stats.averageFps()).toBeNull()
  })
})

describe('QualityController', () => {
  it('连续低帧时降档，且越过最短驻留时间才生效', () => {
    const { tiers } = simulate({ fpsSeries: [FPS_LOW], seconds: 6 })
    expect(tiers[0]).toBe('high')
    expect(tiers).toContain('medium')
  })

  it('持续低帧会一路降到低档，但不会降到低档以下', () => {
    const { tiers, controller } = simulate({ fpsSeries: [FPS_LOW], seconds: 25 })
    expect(tiers).toEqual(['high', 'medium', 'low'])
    expect(controller.tier).toBe('low')
    expect(controller.scale).toEqual(QUALITY_TIER_SCALE.low)
  })

  it('连续高帧且有裕量时升档', () => {
    const { tiers, controller } = simulate({ fpsSeries: [FPS_HIGH], seconds: 25, initialTier: 'low' })
    expect(tiers).toEqual(['low', 'medium', 'high'])
    expect(controller.tier).toBe('high')
  })

  it('帧率抖动时不会频繁切换档位', () => {
    const { tiers, controller } = simulate({ fpsSeries: FPS_JITTER, seconds: 25 })
    expect(tiers).toEqual(['high'])
    expect(controller.tier).toBe('high')
  })

  it('帧率在阈值之间来回摆动时保持在同一档位', () => {
    // 46↔54 恰好落在降档线（45）与升档线（55）之间，属于"不变区"，不应该出现任何档位变化。
    const { tiers } = simulate({ fpsSeries: [46, 54], seconds: 30 })
    expect(tiers).toEqual(['high'])
  })

  it('持续低帧仍然照常降档（迟滞不等于不降级）', () => {
    const { tiers } = simulate({ fpsSeries: [30], seconds: 4, windowSize: 8 })
    expect(tiers).toEqual(['high', 'medium'])
  })

  it('两次降档之间必须间隔最短驻留时间', () => {
    const stats = new FrameStats()
    const controller = new QualityController()
    const changes: number[] = []
    let previous = controller.tier
    let now = 0
    for (let frame = 0; frame <= 60 * 25; frame += 1) {
      stats.update(now)
      const tier = controller.update(FPS_LOW, now)
      if (tier !== previous) {
        changes.push(now)
        previous = tier
      }
      now += 1000 / 60
    }
    expect(changes.length).toBe(2)
    expect(changes[1] - changes[0]).toBeGreaterThanOrEqual(MIN_DWELL_MS)
  })

  it('减少动态效果时常驻低档，高帧也不升档', () => {
    const controller = new QualityController({ reducedMotion: true })
    expect(controller.tier).toBe('low')
    const { tiers } = simulate({ fpsSeries: [FPS_HIGH], seconds: 30, controller })
    expect(tiers).toEqual(['low'])
    expect(controller.tier).toBe('low')
  })

  it('运行中打开减少动态效果会立刻回到低档', () => {
    const controller = new QualityController()
    expect(controller.update(20, 0)).toBe('high')
    controller.setReducedMotion(true)
    expect(controller.update(60, 1000)).toBe('low')
  })

  it('阈值方向符合需求：低于 45 降档、高于 55 才升档', () => {
    expect(DEGRADE_FPS).toBeLessThan(UPGRADE_FPS)
    const degrade = new QualityController({ minDwellMs: 0 })
    degrade.update(60, 0)
    expect(degrade.update(44, 100)).toBe('high')
    expect(degrade.update(44, 1200)).toBe('medium')
  })
})

describe('质量档位联动的渲染预算', () => {
  it('低档的粒子预算与分辨率上限都低于高档', () => {
    expect(QUALITY_TIER_SCALE.low.particles).toBeLessThan(QUALITY_TIER_SCALE.high.particles)
    expect(QUALITY_TIER_SCALE.low.resolution).toBeLessThan(QUALITY_TIER_SCALE.high.resolution)
    expect(devicePixelRatioForTier(2, 'low')).toBeLessThan(devicePixelRatioForTier(2, 'high'))
    expect(devicePixelRatioForTier(2, 'high')).toBeLessThanOrEqual(2)
    // 低档把高 dpr 屏幕压到 1 附近，这是降档最直接的画质收益。
    expect(devicePixelRatioForTier(2, 'low')).toBeLessThanOrEqual(1.2)
  })

  it('粒子数量随档位缩放但仍有下限', () => {
    const base = 1200
    expect(particleCountForTier(base, 'high', false)).toBeGreaterThan(particleCountForTier(base, 'medium', false))
    expect(particleCountForTier(base, 'medium', false)).toBeGreaterThan(particleCountForTier(base, 'low', false))
    expect(particleCountForTier(300, 'low', false)).toBeGreaterThanOrEqual(240)
  })

  it('减少动态效果时粒子预算收紧到低档水平', () => {
    const base = baseParticleBudget(1280, 720, false)
    expect(base).toBeGreaterThan(520)
    expect(particleCountForTier(base, 'high', true)).toBeLessThanOrEqual(340)
    expect(baseParticleBudget(1280, 720, true)).toBeLessThan(base)
  })

  it('烟花纳入同一预算：低档波次更少、粒子更少、减少动态效果时不放', () => {
    expect(fireworkWaveCount('high', false)).toBeGreaterThan(fireworkWaveCount('low', false))
    expect(fireworkWaveCount('low', false)).toBeGreaterThan(0)
    expect(fireworkWaveCount('high', true)).toBe(0)
    expect(fireworkParticleCount('low', 1200)).toBeLessThan(fireworkParticleCount('high', 1200))
    // 轻量硬约束：一波烟花不能接近主粒子预算量级。
    expect(fireworkParticleCount('high', 1200)).toBeLessThan(1200 * 0.2)
  })
})
