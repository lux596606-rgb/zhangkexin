/**
 * 样式切换的全局冷却（需求 8 / 10）：两次**换样式**之间至少间隔这么久。
 *
 * 为什么是 300ms：
 * - 它只挡「连续换样式」。真正的误识别路径是「A ↔ 识别不到 ↔ B」来回跳，噪声帧既
 *   达不到 0.64 置信度也过不了 700ms 保持窗口，本身就不会触发；这里再加一道很短的
 *   闸门，是为了兜住另一种抖动来源 —— 保持窗口刚好卡在边界时，模型逐帧在 A/B 之间
 *   摇摆，导致过渡动画被反复重启。
 * - 300ms 远小于「做一次手势至少要 700ms 保持」的物理下限，所以正常切换（做出新手势、
 *   按 1/2/3/4、点模式入口）永远不会被它挡住，需求 3.2 的自由切换体验不受影响。
 * - 同一个目标样式重复触发（需求 3.4.3）不算「换样式」，直接放行 —— 目标已经一致，
 *   重播过渡没有任何视觉收益，只会制造抖动。
 */
export const MODE_SWITCH_COOLDOWN_MS = 300

export type ModeSwitchGuard = {
  /** 此刻是否允许换样式；`now` 与 performance.now() 同源。 */
  allow: (now: number) => boolean
  reset: () => void
}

/**
 * 创建一个样式切换闸门。识别不到手势时不调用它 —— 调用方保持当前样式即可，
 * 这正是需求 8「识别不到时保持当前样式」的落点。
 */
export function createModeSwitchGuard(cooldownMs = MODE_SWITCH_COOLDOWN_MS): ModeSwitchGuard {
  let lastSwitchAt = Number.NEGATIVE_INFINITY
  return {
    allow(now) {
      if (now - lastSwitchAt < cooldownMs) return false
      lastSwitchAt = now
      return true
    },
    reset() {
      lastSwitchAt = Number.NEGATIVE_INFINITY
    },
  }
}
