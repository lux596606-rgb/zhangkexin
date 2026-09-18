import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MOTION_NOTE,
  REDUCED_MOTION_BADGE,
  REDUCED_MOTION_QUERY,
  formatQualityLabel,
  readReducedMotion,
} from './motionPreference'

describe('减少动态效果偏好（需求 8）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('使用标准媒体特性查询串', () => {
    expect(REDUCED_MOTION_QUERY).toBe('(prefers-reduced-motion: reduce)')
  })

  it('没有 matchMedia 的环境安全返回 false，不抛异常', () => {
    expect(readReducedMotion(undefined)).toBe(false)
    expect(readReducedMotion({})).toBe(false)
  })

  it('跟随 matchMedia 结果，并且只查询这一条媒体特性', () => {
    const queries: string[] = []
    const scope = {
      matchMedia: (query: string) => {
        queries.push(query)
        return { matches: true }
      },
    }
    expect(readReducedMotion(scope)).toBe(true)
    expect(queries).toEqual([REDUCED_MOTION_QUERY])
    expect(readReducedMotion({ matchMedia: () => ({ matches: false }) })).toBe(false)
  })

  it('默认参数直接读浏览器的 matchMedia（与粒子画布同一口径）', () => {
    const matchMedia = vi.fn(() => ({ matches: true }))
    vi.stubGlobal('window', { matchMedia })
    expect(readReducedMotion()).toBe(true)
    expect(matchMedia).toHaveBeenCalledWith(REDUCED_MOTION_QUERY)
  })

  it('画质标记始终含档位与帧率，减少动效时追加短标记', () => {
    expect(formatQualityLabel('high', 60, false)).toBe('HIGH · 60 FPS')
    expect(formatQualityLabel('low', 29.6, false)).toBe('LOW · 30 FPS')
    expect(formatQualityLabel('low', 30, true)).toBe(`LOW · 30 FPS · ${REDUCED_MOTION_BADGE}`)
    // 「减少动效」与「自动降档」在界面上可区分：同样是 low 档，两者的文案不同。
    expect(formatQualityLabel('low', 30, true)).not.toBe(formatQualityLabel('low', 30, false))
  })

  it('说明文案同时讲清「按设备性能自动调整」与「减少动态效果」', () => {
    expect(MOTION_NOTE).toContain('自动调整')
    expect(MOTION_NOTE).toContain('减少动态效果')
  })
})
