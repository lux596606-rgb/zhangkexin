import { describe, expect, it } from 'vitest'
import { formatSummaryReport, summarizeSamples, type CalibrationSample } from './sampling'

const sample = (overrides: Partial<CalibrationSample> = {}): CalibrationSample => ({
  category: 'None',
  mode: null,
  pinchRatio: 0.8,
  indexPipDeg: 170,
  indexExtended: true,
  otherExtended: 3,
  pinchObserved: false,
  pinchConfirmed: false,
  ...overrides,
})

describe('summarizeSamples', () => {
  it('counts category and mode occurrences in descending order', () => {
    const summary = summarizeSamples([
      sample({ category: 'None' }),
      sample({ category: 'None' }),
      sample({ category: 'Open_Palm', mode: 'galaxy', indexPipDeg: 150 }),
    ], 0.42)

    expect(summary.frames).toBe(3)
    expect(summary.categoryCounts[0]).toEqual({ name: 'None', count: 2 })
    expect(summary.modeCounts[0]).toEqual({ name: 'null', count: 2 })
    expect(summary.modeCounts[1]).toEqual({ name: 'galaxy', count: 1 })
  })

  it('reports the median/min/max of the PIP angle only for confirmed pinches', () => {
    const summary = summarizeSamples([
      sample({ pinchRatio: 0.2, indexPipDeg: 120, pinchObserved: true, pinchConfirmed: true }),
      sample({ pinchRatio: 0.3, indexPipDeg: 130, pinchObserved: true, pinchConfirmed: true }),
      sample({ pinchRatio: 0.1, indexPipDeg: 110, pinchObserved: true, pinchConfirmed: true }),
      // 未成立的帧不得进入「捏合成立时」的统计。
      sample({ pinchRatio: 0.05, indexPipDeg: 90, pinchConfirmed: false }),
    ], 0.42)

    expect(summary.confirmedFrames).toBe(3)
    expect(summary.confirmedPip).toEqual({ min: 110, max: 130, median: 120, samples: 3 })
    expect(summary.confirmedRatio).toEqual({ min: 0.1, max: 0.3, median: 0.2, samples: 3 })
  })

  it('counts near misses only when the ratio already reached the enter threshold', () => {
    const summary = summarizeSamples([
      // 距离达标但食指不伸直 → 差一点成立，归因到食指。
      sample({ pinchRatio: 0.3, indexPipDeg: 128, indexExtended: false }),
      // 距离达标但其余指不够 → 差一点成立，归因到其余指。
      sample({ pinchRatio: 0.35, indexPipDeg: 150, otherExtended: 1 }),
      // 距离没达标 → 不算差一点（这是手还没捏上）。
      sample({ pinchRatio: 0.9, indexPipDeg: 170, indexExtended: true }),
    ], 0.42)

    expect(summary.nearMissFrames).toBe(2)
    expect(summary.nearMissPip).toEqual({ min: 128, max: 150, median: 139, samples: 2 })
    expect(summary.nearMissReasons).toEqual([
      { reason: '食指判为不伸直', count: 1 },
      { reason: '其余三指伸直数不足', count: 1 },
    ])
  })

  it('ignores frames without geometry so a missing hand cannot pollute the medians', () => {
    const summary = summarizeSamples([
      sample({ pinchRatio: null, indexPipDeg: null, indexExtended: false, otherExtended: 0 }),
      sample({ category: 'Open_Palm', mode: 'galaxy', pinchRatio: null, indexPipDeg: null }),
    ], 0.42)

    expect(summary.framesWithGeometry).toBe(0)
    expect(summary.confirmedPip).toBeNull()
    expect(summary.nearMissFrames).toBe(0)
    expect(summary.nearMissPip).toBeNull()
  })

  it('returns empty statistics for an empty window instead of NaN', () => {
    const summary = summarizeSamples([], 0.42)
    expect(summary.frames).toBe(0)
    expect(summary.categoryCounts).toEqual([])
    expect(summary.confirmedPip).toBeNull()
    expect(summary.nearMissReasons).toEqual([])
  })
})

describe('formatSummaryReport', () => {
  it('embeds the live thresholds and the key medians in the copied text', () => {
    const summary = summarizeSamples([
      sample({ pinchRatio: 0.2, indexPipDeg: 120, pinchObserved: true, pinchConfirmed: true }),
      sample({ pinchRatio: 0.3, indexPipDeg: 128, indexExtended: false }),
    ], 0.42)
    const report = formatSummaryReport(summary, {
      thresholds: { pinchEnter: 0.42, pinchExit: 0.52, wristRatio: 1.02, minAngleDeg: 130 },
      seconds: 12.34,
    })

    expect(report).toContain('PIP ≥ 130°')
    expect(report).toContain('捏合成立时食指 PIP 角 min/中位/max：120.0° / 120.0° / 120.0°（n=1）')
    expect(report).toContain('差一点成立时食指 PIP 角 min/中位/max：128.0° / 128.0° / 128.0°（n=1）')
    expect(report).toContain('食指判为不伸直×1')
    expect(report).toContain('不录制、不上传、不保存')
  })
})
