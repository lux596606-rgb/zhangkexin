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

/** 通道量化步长与透明度档数：把颜色字符串的取值空间压到有限、可缓存的规模。 */
const COLOR_CHANNEL_STEP = 4
const COLOR_ALPHA_LEVELS = 64

const colorStringCache = new Map<number, string>()

/**
 * 热循环专用的颜色字符串。
 *
 * 颜色通道按 4 递增、透明度按 1/64 分档（肉眼分辨不出），于是取值空间有限，可以整串缓存复用。
 * 逐粒子逐帧新建模板串在本项目里是可测量的开销：收束样式每帧 2600 多颗粒子，
 * 等于每秒十几万次字符串分配，是实测掉帧的次要来源。
 */
export function colorStringFast(color: RGB, alpha: number): string {
  const red = Math.round(color[0] / COLOR_CHANNEL_STEP)
  const green = Math.round(color[1] / COLOR_CHANNEL_STEP)
  const blue = Math.round(color[2] / COLOR_CHANNEL_STEP)
  const level = Math.round(clamp(alpha, 0, 1) * COLOR_ALPHA_LEVELS)
  const key = ((red * 64 + green) * 64 + blue) * (COLOR_ALPHA_LEVELS + 1) + level
  const cached = colorStringCache.get(key)
  if (cached !== undefined) return cached
  const built = `rgba(${red * COLOR_CHANNEL_STEP},${green * COLOR_CHANNEL_STEP},${blue * COLOR_CHANNEL_STEP},${level / COLOR_ALPHA_LEVELS})`
  colorStringCache.set(key, built)
  return built
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
