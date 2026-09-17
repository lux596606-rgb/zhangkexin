export type RGB = [number, number, number]

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount
}

export function colorString(color: RGB, alpha: number): string {
  return `rgba(${Math.round(color[0])},${Math.round(color[1])},${Math.round(color[2])},${alpha})`
}

/** 支持 `#rgb` / `#rrggbb`，返回的通道值可能带小数，绘制时再取整。 */
export function hexToRgb(hex: string): RGB {
  const value = hex.replace('#', '')
  const normalized = value.length === 3
    ? value.split('').map((char) => char + char).join('')
    : value.padEnd(6, '0').slice(0, 6)
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ]
}
