import { useSyncExternalStore } from 'react'
import type { QualityTier } from './particleQuality'

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

type MatchMediaScope = {
  matchMedia?: (query: string) => { matches: boolean }
}

function currentScope(): MatchMediaScope | undefined {
  return typeof window === 'undefined' ? undefined : window
}

/**
 * 读取系统的「减少动态效果」偏好。粒子画布内部也用同一个媒体查询决定档位与动画幅度，
 * 这里再读一次是为了**在界面上把这条路径讲出来**（需求 8），两边判断口径完全一致。
 */
export function readReducedMotion(
  scope: MatchMediaScope | undefined = currentScope(),
): boolean {
  if (!scope || typeof scope.matchMedia !== 'function') return false
  return scope.matchMedia(REDUCED_MOTION_QUERY).matches
}

/** 订阅媒体查询变化；无 matchMedia 的环境返回空订阅。 */
export function subscribeReducedMotion(onStoreChange: () => void): () => void {
  const scope = currentScope()
  if (!scope || typeof scope.matchMedia !== 'function') return () => {}
  const query = window.matchMedia(REDUCED_MOTION_QUERY)
  query.addEventListener('change', onStoreChange)
  return () => query.removeEventListener('change', onStoreChange)
}

/**
 * 跟随系统偏好变化。用 useSyncExternalStore 而不是「state + effect 里 setState」：
 * 媒体查询本来就是 React 之外的数据源，这样不会在挂载时多触发一次渲染。
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, readReducedMotion, () => false)
}

/** 减少动态效果时追加在画质标记后的短标记，让「少动」和「性能降档」在界面上可区分。 */
export const REDUCED_MOTION_BADGE = '减少动效'

/**
 * 画质标记：档位 + 实时帧率，减少动态效果时再补一个短标记。
 * 低档与「减少动效」可能同时出现，两者含义不同：前者是设备性能，后者是使用者的偏好。
 */
export function formatQualityLabel(tier: QualityTier, fps: number, reducedMotion: boolean): string {
  const base = `${tier.toUpperCase()} · ${Math.round(fps)} FPS`
  return reducedMotion ? `${base} · ${REDUCED_MOTION_BADGE}` : base
}

/** 一行极轻的说明：让使用者知道画面会自己适配，也知道「想更安静」该去哪里开。 */
export const MOTION_NOTE = '画面会按设备性能自动调整；在系统里开启「减少动态效果」，星尘会更安静。'
