import { describe, expect, it } from 'vitest'
import { MAX_PARTICLE_COUNT, SHAPE_PARTICLE_SCALE, particleCountForTier } from './particleQuality'
import { PRIORITY_CLUSTER_LIMIT, pigPointWeight, pigStructureEmphasis, resample, type ShapePoint } from './particleShapes'

/** 实测参考图的平均色：深色轮廓/五官 luma≈95，浅粉面填充 luma≈225。 */
const DARK: [number, number, number] = [125, 83, 77]
const LIGHT: [number, number, number] = [253, 213, 214]
const WHITE: [number, number, number] = [255, 255, 255]

function at(x: number, y: number, color: [number, number, number], priority = false): ShapePoint {
  return { x, y, color, priority, pigRegion: priority ? 'eye' : 'face' }
}

/** 合成猪头：6 个分散的深色小块（轮廓/五官）+ 一大片浅粉面填充，深色占比与实测一致（18%）。 */
const PIG_BLOCKS: [number, number][] = [
  [20, 20],
  [200, 20],
  [20, 200],
  [200, 200],
  [110, 110],
  [200, 300],
]

function syntheticPig(): ShapePoint[] {
  const points: ShapePoint[] = []
  for (const [blockX, blockY] of PIG_BLOCKS) {
    for (let index = 0; index < 150; index += 1) {
      points.push(at(blockX + (index % 15) * 2, blockY + Math.floor(index / 15) * 2, DARK))
    }
  }
  for (let index = 0; index < 4100; index += 1) {
    points.push(at((index % 60) * 4, Math.floor(index / 60) * 4, LIGHT))
  }
  return points
}

/** 紧凑的高光簇：20 个点挤在半径 2px 的圆里，模拟参考图眼睛白点。 */
function glintCluster(centerX: number, centerY: number): ShapePoint[] {
  return Array.from({ length: 20 }, (_, index) => {
    const angle = (Math.PI * 2 * index) / 20
    return at(centerX + Math.cos(angle) * 2, centerY + Math.sin(angle) * 2, WHITE, true)
  })
}

const shareOfDark = (points: ShapePoint[]) =>
  points.filter((point) => point.color === DARK).length / Math.max(1, points.length)

describe('猪头加权抽稀', () => {
  it('权重只由亮度决定：越暗越重要', () => {
    expect(pigPointWeight(at(0, 0, DARK))).toBeGreaterThan(pigPointWeight(at(0, 0, LIGHT)) * 5)
    // 亮端被权重下限压平：浅粉面填充不再比纯白更"重要"，二者都只保留最低概率。
    expect(pigPointWeight(at(0, 0, LIGHT))).toBeGreaterThanOrEqual(pigPointWeight(at(0, 0, WHITE)))
  })

  it('点径用的结构重要度与加权同源：轮廓记 1、面填充记 0', () => {
    expect(pigStructureEmphasis(DARK)).toBeGreaterThan(0.85)
    expect(pigStructureEmphasis(DARK)).toBeLessThanOrEqual(1)
    expect(pigStructureEmphasis(LIGHT)).toBe(0)
    expect(pigStructureEmphasis(WHITE)).toBe(0)
    // 单调：越亮越小，中间调落在 0~1 之间。
    const mid = pigStructureEmphasis([190, 150, 148])
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
    expect(pigStructureEmphasis(DARK)).toBeGreaterThan(mid)
  })

  it('加权把预算压到深色轮廓上：深色占比远高于其采样占比', () => {
    const points = syntheticPig()
    expect(shareOfDark(points)).toBeLessThan(0.2)

    const weighted = resample(points, 800, pigPointWeight)
    const uniform = resample(points, 800)
    expect(weighted).toHaveLength(800)
    // 加权后深色点拿到七成以上，面填充仍有稀疏保留（而不是全给最暗的少数像素）。
    expect(shareOfDark(weighted)).toBeGreaterThan(0.6)
    expect(shareOfDark(weighted)).toBeLessThan(0.95)
    // 旧的均匀抽取只按面积摊平，深色占比与采样占比一样低——这就是"噪点团"的来源。
    expect(shareOfDark(uniform)).toBeLessThan(0.3)
  })

  it('深色区域整体被覆盖：每个深色小块都有粒子，不是一个区块吃掉全部', () => {
    const picked = resample(syntheticPig(), 800, pigPointWeight).filter((point) => point.color === DARK)
    for (const [blockX, blockY] of PIG_BLOCKS) {
      const inBlock = picked.some(
        (point) => Math.abs(point.x - blockX - 14) <= 16 && Math.abs(point.y - blockY - 9) <= 12,
      )
      expect({ blockX, blockY, inBlock }).toEqual({ blockX, blockY, inBlock: true })
    }
  })

  it('面填充保持稀疏但仍有空间覆盖，不会只剩下一小片', () => {
    const points = syntheticPig()
    const light = resample(points, 800, pigPointWeight).filter((point) => point.color === LIGHT)
    expect(light.length).toBeGreaterThan(20)
    const bands = new Set(light.map((point) => Math.floor(point.x / 48)))
    expect(bands.size).toBeGreaterThanOrEqual(4)
  })

  it('输出长度与预算一致，且引用的是原始采样点（pigRegion 等标记不丢）', () => {
    const points = syntheticPig()
    const picked = resample(points, 1379, pigPointWeight)
    expect(picked).toHaveLength(1379)
    const source = new Set(points)
    expect(picked.every((point) => source.has(point))).toBe(true)
    expect(picked.every((point) => point.pigRegion !== undefined)).toBe(true)
  })

  it('眼睛高光按簇限额保留：每簇都有，且不会在同一个高光簇里堆一大片白色', () => {
    const points = [...syntheticPig(), ...glintCluster(100, 400), ...glintCluster(500, 400)]
    const picked = resample(points, 800, pigPointWeight)
    const glints = picked.filter((point) => point.priority)
    expect(glints.length).toBeGreaterThanOrEqual(2)
    expect(glints.length).toBeLessThanOrEqual(PRIORITY_CLUSTER_LIMIT * 2)
    expect(glints.some((point) => point.x < 300)).toBe(true)
    expect(glints.some((point) => point.x > 300)).toBe(true)
    // 同样的输入走旧分支时，14% 的预算都会被这两个小簇吃掉。
    expect(resample(points, 800).filter((point) => point.priority).length).toBeGreaterThan(glints.length * 4)
  })

  it('同一输入两次调用结果完全一致（确定性，无隐藏随机）', () => {
    const points = syntheticPig()
    const first = resample(points, 500, pigPointWeight)
    const second = resample(points, 500, pigPointWeight)
    expect(first).toEqual(second)
    expect(first.every((point, index) => point === second[index])).toBe(true)
  })

  it('空形状与 0 预算不抛错', () => {
    expect(resample([], 100, pigPointWeight)).toEqual([])
    expect(resample(syntheticPig(), 0, pigPointWeight)).toEqual([])
  })

  it('不传 weightOf 时仍是旧的均匀抽取（文字样式不受影响）', () => {
    const points = Array.from({ length: 10 }, (_, index) => at(index, 0, LIGHT))
    // 旧实现：regular[floor((index / count) * length)] —— 索引序列必须逐位相同。
    expect(resample(points, 4).map((point) => point.x)).toEqual([0, 2, 5, 7])
    expect(resample(points, 3).map((point) => point.x)).toEqual([0, 3, 6])
  })
})

describe('非银河样式的密度加成', () => {
  it('猪头/文字在 high 档落在 2000~2400，银河沿用原基准预算', () => {
    expect(particleCountForTier(1500, 'high', false)).toBe(1500)
    const shaped = particleCountForTier(1500, 'high', false, SHAPE_PARTICLE_SCALE)
    expect(shaped).toBeGreaterThanOrEqual(2000)
    expect(shaped).toBeLessThanOrEqual(2400)
  })

  it('档位缩放、硬上限与减少动态效果的收紧都还在', () => {
    const high = particleCountForTier(1500, 'high', false, SHAPE_PARTICLE_SCALE)
    const medium = particleCountForTier(1500, 'medium', false, SHAPE_PARTICLE_SCALE)
    const low = particleCountForTier(1500, 'low', false, SHAPE_PARTICLE_SCALE)
    expect(medium).toBeLessThan(high)
    expect(low).toBeLessThan(medium)
    expect(particleCountForTier(99999, 'high', false, SHAPE_PARTICLE_SCALE)).toBe(MAX_PARTICLE_COUNT)
    expect(particleCountForTier(1500, 'high', true, SHAPE_PARTICLE_SCALE)).toBeLessThanOrEqual(340)
  })
})
