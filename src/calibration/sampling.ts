/**
 * 校准页的采样汇总（纯计算，不碰 DOM / 摄像头 / MediaPipe）。
 *
 * 为什么要单独成文件并配单测：校准页给出的「捏合成立时 PIP 角度中位数」「差点成立了几次」
 * 是 PM 决定要不要调阈值的唯一依据，如果统计口径本身写错了，人会照着错数据改阈值。
 * 因此把口径固化成类型 + 可测试的纯函数，页面只负责往里塞样本、把结果画出来。
 *
 * 隐私：这里的样本只在内存里活一次会话，不落盘、不上传。
 */

/** 一帧的采样点。数值为 null 表示这一帧没有可用的几何量（没检测到手、或关键点不全）。 */
export type CalibrationSample = {
  /** 这一帧 MediaPipe 给的类别名（Open_Palm / Closed_Fist / Thumb_Up / None / …）。 */
  category: string
  /** 这一帧 classifyGesture 的输出（galaxy / birthday / pig / closing / null）。 */
  mode: string | null
  /** 拇指尖-食指尖距离 / 掌尺度。 */
  pinchRatio: number | null
  /** 食指 PIP 夹角（度）。 */
  indexPipDeg: number | null
  /** 食指是否被判为伸直。 */
  indexExtended: boolean
  /** 其余三指里伸直的数量。 */
  otherExtended: number
  /** 这一帧的单帧捏合观测是否成立（进入阈值，未平滑）。 */
  pinchObserved: boolean
  /** 平滑后认可的捏合是否成立（页面显示的那个「捏合成立」）。 */
  pinchConfirmed: boolean
}

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export type CalibrationSummary = {
  /** 总帧数。 */
  frames: number
  /** 有可用几何量的帧数（能算捏合比值的帧）。 */
  framesWithGeometry: number
  /** 各 MediaPipe 类别出现次数，按次数降序。 */
  categoryCounts: { name: string; count: number }[]
  /** 各 classifyGesture 结果出现次数（null 记为 'null'），按次数降序。 */
  modeCounts: { name: string; count: number }[]
  /** 平滑后认可的捏合帧数。 */
  confirmedFrames: number
  /** 单帧观测成立的捏合帧数（比确认更多，说明平滑器在削单帧噪声）。 */
  observedFrames: number
  /** 捏合确认时的 PIP 角度统计（这是回答「真人捏合时 PIP 典型多少」的关键三元组）。 */
  confirmedPip: { min: number; max: number; median: number; samples: number } | null
  /** 捏合确认时的捏合比值统计。 */
  confirmedRatio: { min: number; max: number; median: number; samples: number } | null
  /**
   * 捏合确认时「其余三指伸直数」的统计。**仅诊断参考**：捏合不要求其余三指伸直，
   * 真人捏合时它们自然弯曲，所以这一项的中位数落在 0~1 属于正常，不是缺陷。
   */
  confirmedOtherExtended: { min: number; max: number; median: number; samples: number } | null
  /**
   * 「差一点就成立」的帧数：两指已经贴近进入阈值，但食指伸直判据没通过。
   * 这一项为正说明当前瓶颈不是距离，而是食指的伸直判据；为零说明距离本身没达标。
   */
  nearMissFrames: number
  /** 差一点成立时食指 PIP 角度的中位数与最小/最大值（越接近阈值说明只差一点）。 */
  nearMissPip: { min: number; max: number; median: number; samples: number } | null
  /** 差一点成立时，卡在哪一条判据上的次数统计。 */
  nearMissReasons: { reason: string; count: number }[]
}

/**
 * 判定「差一点成立」：两指距离已经进入 PINCH_ENTER_RATIO，但完整捏合判据没通过。
 * enableRatio 由调用方从 PINCH_ENTER_RATIO 传进来，避免这里再硬编码一个阈值副本。
 *
 * 删除「其余三指至少两指伸直」门槛后，捏合 = 食指伸直 + 两指贴合，所以
 * 「距离已达标却不成立」只可能是食指没伸直 —— 归因口径因此只剩这一条。
 */
export function summarizeSamples(samples: readonly CalibrationSample[], enableRatio: number): CalibrationSummary {
  const categoryTally = new Map<string, number>()
  const modeTally = new Map<string, number>()
  let framesWithGeometry = 0
  let confirmedFrames = 0
  let observedFrames = 0
  let nearMissFrames = 0
  const confirmedPips: number[] = []
  const confirmedRatios: number[] = []
  const confirmedOtherExtended: number[] = []
  const nearMissPips: number[] = []
  const reasonTally = new Map<string, number>()

  for (const sample of samples) {
    categoryTally.set(sample.category, (categoryTally.get(sample.category) ?? 0) + 1)
    const modeName = sample.mode ?? 'null'
    modeTally.set(modeName, (modeTally.get(modeName) ?? 0) + 1)

    if (sample.pinchRatio !== null && sample.indexPipDeg !== null) framesWithGeometry += 1
    if (sample.pinchObserved) observedFrames += 1
    if (sample.pinchConfirmed) {
      confirmedFrames += 1
      if (sample.indexPipDeg !== null) confirmedPips.push(sample.indexPipDeg)
      if (sample.pinchRatio !== null) confirmedRatios.push(sample.pinchRatio)
      confirmedOtherExtended.push(sample.otherExtended)
      continue
    }

    const closeEnough = sample.pinchRatio !== null && sample.pinchRatio <= enableRatio
    if (!closeEnough) continue
    // 距离已经够近，却仍没成立 —— 那必然是食指伸直判据挡住的，这才叫「差一点」。
    if (sample.indexExtended) continue
    nearMissFrames += 1
    if (sample.indexPipDeg !== null) nearMissPips.push(sample.indexPipDeg)
    reasonTally.set('食指判为不伸直', (reasonTally.get('食指判为不伸直') ?? 0) + 1)
  }

  const stats = (values: readonly number[]) => {
    if (values.length === 0) return null
    const sorted = [...values].sort((a, b) => a - b)
    return {
      min: sorted[0],
      max: sorted[sorted.length - 1],
      median: median(sorted) as number,
      samples: sorted.length,
    }
  }

  const descending = (tally: Map<string, number>) =>
    [...tally.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
  const descendingReasons = (tally: Map<string, number>) =>
    [...tally.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count)

  return {
    frames: samples.length,
    framesWithGeometry,
    categoryCounts: descending(categoryTally),
    modeCounts: descending(modeTally),
    confirmedFrames,
    observedFrames,
    confirmedPip: stats(confirmedPips),
    confirmedRatio: stats(confirmedRatios),
    confirmedOtherExtended: stats(confirmedOtherExtended),
    nearMissFrames,
    nearMissPip: stats(nearMissPips),
    nearMissReasons: descendingReasons(reasonTally),
  }
}

/** 把汇总渲染成可以一键复制、直接贴回给 PM 的纯文本。 */
export function formatSummaryReport(
  summary: CalibrationSummary,
  context: {
    thresholds: { pinchEnter: number; pinchExit: number; wristRatio: number; minAngleDeg: number }
    seconds: number
  },
): string {
  const { thresholds } = context
  const line = (label: string, value: string) => `${label}：${value}`
  const statLine = (stat: { min: number; max: number; median: number; samples: number } | null, unit = '') =>
    stat ? `${stat.min.toFixed(1)}${unit} / ${stat.median.toFixed(1)}${unit} / ${stat.max.toFixed(1)}${unit}（n=${stat.samples}）` : '无样本'
  /** 计数类统计（伸直「数」是整数，用 1 位小数读起来别扭）。 */
  const countLine = (stat: { min: number; max: number; median: number; samples: number } | null) =>
    stat ? `${Math.round(stat.min)} / ${Math.round(stat.median)} / ${Math.round(stat.max)}（n=${stat.samples}）` : '无样本'

  const reasons = summary.nearMissReasons.length > 0
    ? summary.nearMissReasons.map((entry) => `${entry.reason}×${entry.count}`).join('，')
    : '无'

  return [
    '【手势校准采样报告】',
    line('采样时长', `${context.seconds.toFixed(1)} 秒 / ${summary.frames} 帧`),
    line('可用几何帧', `${summary.framesWithGeometry} 帧`),
    line('当前阈值', `捏合进入 ${thresholds.pinchEnter} / 退出 ${thresholds.pinchExit}；腕-指尖比值 > ${thresholds.wristRatio}；PIP ≥ ${thresholds.minAngleDeg}°`),
    line('MediaPipe 类别分布', summary.categoryCounts.map((entry) => `${entry.name}×${entry.count}`).join('，') || '无'),
    line('classifyGesture 分布', summary.modeCounts.map((entry) => `${entry.name}×${entry.count}`).join('，') || '无'),
    line('捏合成立帧数（单帧观测 / 平滑确认）', `${summary.observedFrames} / ${summary.confirmedFrames}`),
    line('捏合成立时食指 PIP 角 min/中位/max', statLine(summary.confirmedPip, '°')),
    line('捏合成立时捏合比值 min/中位/max', statLine(summary.confirmedRatio)),
    line('捏合成立时其余三指伸直数 min/中位/max（仅诊断，不参与判定）', countLine(summary.confirmedOtherExtended)),
    line('差一点成立（距离达标但食指未伸直）帧数', `${summary.nearMissFrames}`),
    line('差一点成立时食指 PIP 角 min/中位/max', statLine(summary.nearMissPip, '°')),
    line('差一点成立卡在哪一条', reasons),
    line('隐私', '全部计算在本机内存完成，不录制、不上传、不保存'),
  ].join('\n')
}
