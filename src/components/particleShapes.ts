import { clamp, type RGB } from './particleMath'
import { hashUnit } from './particleTransition'

export type ParticleMode = 'galaxy' | 'birthday' | 'pig' | 'closing'

/** 猪头分区：呼吸与耳朵弹动只作用于对应分区，避免整体形变破坏参考图构图。 */
export type PigRegion = 'face' | 'ear-left' | 'ear-right' | 'eye' | 'nose' | 'blush'

/** 收束样式的文字与光环分区。 */
export type ShapeBand = 'text' | 'ring'

export type ShapePoint = {
  x: number
  y: number
  color: RGB
  /** 眼睛白色高光等结构点：低粒子预算下也必须保留。 */
  priority?: boolean
  pigRegion?: PigRegion
  shapeBand?: ShapeBand
  /** 光环粒子的慢速公转系数，保证形态不是死的。 */
  bandFactor?: number
}

/** shapePoints、每颗粒子的目标缓冲与寻址顺序封装在一起，避免各处各自维护索引。 */
export type ShapeTargets = {
  points: ShapePoint[]
  buffer: ShapePoint[]
  order: number[]
  centerX: number
  centerY: number
  /** 文字包围盒半高，用于把烟花发射点放在文字上方而不是压在字上。 */
  halfHeight: number
}

const galaxyPalette: RGB[] = [
  [255, 226, 213],
  [255, 179, 157],
  [202, 195, 255],
  [255, 245, 228],
]
export const birthdayPalette: RGB = [255, 218, 207]
export const pigPalette: RGB = [247, 174, 179]
export const closingPalette: RGB = [255, 205, 156]
const goldHighlight: RGB = [255, 239, 197]

export const BIRTHDAY_LINES = ['生日', '快乐']
export const CLOSING_LINES = ['生日快乐，', '张珂欣']

/** 采样离屏画布上的文字像素。 */
export function sampleText(lines: string[], width: number, height: number, color: RGB): ShapePoint[] {
  const surface = document.createElement('canvas')
  surface.width = Math.max(1, Math.floor(width))
  surface.height = Math.max(1, Math.floor(height))
  const context = surface.getContext('2d')
  if (!context) return []

  const fontSize = clamp(Math.min(width * 0.17, height * 0.235), 44, 118)
  const lineHeight = fontSize * 1.08
  context.clearRect(0, 0, surface.width, surface.height)
  context.fillStyle = '#ffffff'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.font = `600 ${fontSize}px "Noto Sans SC", "Microsoft YaHei", sans-serif`
  const start = height / 2 - ((lines.length - 1) * lineHeight) / 2
  lines.forEach((line, index) => context.fillText(line, width / 2, start + index * lineHeight))

  const pixels = context.getImageData(0, 0, surface.width, surface.height).data
  const stride = Math.max(2, Math.round(Math.min(width, height) / 190))
  const points: ShapePoint[] = []
  for (let y = 0; y < surface.height; y += stride) {
    for (let x = 0; x < surface.width; x += stride) {
      if (pixels[(y * surface.width + x) * 4 + 3] > 90) {
        points.push({ x, y, color, shapeBand: 'text' })
      }
    }
  }
  return points
}

/**
 * 按归一化坐标给猪头采样点打分区标签。
 * 边界按参考图实测校准：眼半径只包住眼睛本身（不吞掉腮红），耳朵只取两侧外扩的头顶部分。
 */
export function pigRegionAt(nx: number, ny: number): PigRegion {
  const inEye = (cx: number, cy: number) => Math.hypot(nx - cx, ny - cy) < 0.052
  if (inEye(0.365, 0.535) || inEye(0.638, 0.542)) return 'eye'
  if (((nx - 0.512) / 0.065) ** 2 + ((ny - 0.604) / 0.06) ** 2 < 1) return 'nose'
  if (nx >= 0.285 && nx <= 0.45 && ny >= 0.505 && ny <= 0.625) return 'blush'
  if (nx >= 0.55 && nx <= 0.715 && ny >= 0.535 && ny <= 0.655) return 'blush'
  if (nx <= 0.5 ? nx <= 0.315 && ny <= 0.44 : nx >= 0.685 && ny <= 0.45) return nx <= 0.5 ? 'ear-left' : 'ear-right'
  return 'face'
}

/** 内容包围盒：参考图四周留白不进采样，绘制时也只按这个框去 fit。 */
export type ContentBounds = { x: number; y: number; width: number; height: number }

/** 判定"空白"的阈值：接近纯白且不透明才视为背景，猪头最浅的粉色远低于该值。 */
const BLANK_CHANNEL = 244
/** 扫描步长：参考图 1254×1254，隔行隔列采样足够定位包围盒，且省下 3/4 的读取时间。 */
const BOUNDS_SCAN_STRIDE = 2

const contentBoundsCache = new WeakMap<HTMLImageElement, ContentBounds>()

/**
 * 求参考图的内容包围盒。
 * 参考图自带大片白底留白（实测内容仅占宽 67%、高 53%），
 * 直接按整图 fit 会让猪头只占画布中间一小块，所以先量出内容框再居中绘制。
 * 优先按 alpha 通道判定；参考图为不带 alpha 的白底图时回退到"非白像素"判定。
 */
export function measureContentBounds(image: HTMLImageElement): ContentBounds {
  const cached = contentBoundsCache.get(image)
  if (cached) return cached
  const imageWidth = image.naturalWidth || image.width
  const imageHeight = image.naturalHeight || image.height
  const whole: ContentBounds = { x: 0, y: 0, width: Math.max(1, imageWidth), height: Math.max(1, imageHeight) }
  if (imageWidth < 2 || imageHeight < 2) return whole

  const surface = document.createElement('canvas')
  surface.width = imageWidth
  surface.height = imageHeight
  const context = surface.getContext('2d', { willReadFrequently: true })
  if (!context) return whole
  context.drawImage(image, 0, 0)

  let pixels: Uint8ClampedArray
  try {
    pixels = context.getImageData(0, 0, imageWidth, imageHeight).data
  } catch {
    // 跨域画布会污染像素读取：退回整图，行为与修复前的降级一致。
    contentBoundsCache.set(image, whole)
    return whole
  }

  let minX = imageWidth
  let minY = imageHeight
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < imageHeight; y += BOUNDS_SCAN_STRIDE) {
    for (let x = 0; x < imageWidth; x += BOUNDS_SCAN_STRIDE) {
      const index = (y * imageWidth + x) * 4
      const alpha = pixels[index + 3]
      const blank =
        alpha <= 24 ||
        (pixels[index] >= BLANK_CHANNEL && pixels[index + 1] >= BLANK_CHANNEL && pixels[index + 2] >= BLANK_CHANNEL)
      if (blank) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  const bounds =
    maxX < minX || maxY < minY
      ? whole
      : {
          // 步长采样会向内缩 1~2 像素，向外补回后再作为内容框。
          x: Math.max(0, minX - BOUNDS_SCAN_STRIDE),
          y: Math.max(0, minY - BOUNDS_SCAN_STRIDE),
          width: Math.min(imageWidth, maxX + 1 + BOUNDS_SCAN_STRIDE) - Math.max(0, minX - BOUNDS_SCAN_STRIDE),
          height: Math.min(imageHeight, maxY + 1 + BOUNDS_SCAN_STRIDE) - Math.max(0, minY - BOUNDS_SCAN_STRIDE),
        }
  contentBoundsCache.set(image, bounds)
  return bounds
}

/**
 * 按内容框（而不是整张图）计算绘制矩形：内容框缩放后居中，
 * 目标尺寸取 min(宽度占比, 高度占比)，让猪头明确占据画面主体。
 */
export function pigDrawRect(
  image: HTMLImageElement,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } {
  const bounds = measureContentBounds(image)
  const box = Math.max(1, Math.min(width * 0.8, height * 0.86))
  const scale = Math.min(box / bounds.width, box / bounds.height)
  const drawWidth = bounds.width * scale
  const drawHeight = bounds.height * scale
  // 内容框 left/top 在画布上的落点：drawImage 的偏移减去内容框缩放后的起点。
  return {
    x: (width - drawWidth) / 2 - bounds.x * scale,
    y: (height - drawHeight) / 2 - bounds.y * scale,
    width: image.naturalWidth * scale,
    height: image.naturalHeight * scale,
  }
}

/**
 * 内容框内的背景掩码。
 * 参考图的白底并不会被内容框切干净：头顶、双耳之间、轮廓外缘仍是纯白，
 * 它们要么被当成"高光"、要么被当成浅色面填充，最终在轮廓外侧排出一圈白色亮带。
 * 这里从采样网格的边界出发做 4 邻接洪泛，凡"与边界连通的近白像素"一律判为背景。
 * 眼睛白点是封闭在深色眼球里的近白像素，连不到边界，因此会被保留下来。
 */
function backgroundMask(
  isBlank: (x: number, y: number) => boolean,
  minX: number,
  minY: number,
  stride: number,
  columns: number,
  rows: number,
): Uint8Array {
  const mask = new Uint8Array(columns * rows)
  const stack: number[] = []
  const visit = (column: number, row: number) => {
    if (column < 0 || row < 0 || column >= columns || row >= rows) return
    const cell = row * columns + column
    if (mask[cell] === 1) return
    if (!isBlank(minX + column * stride, minY + row * stride)) return
    mask[cell] = 1
    stack.push(cell)
  }
  for (let column = 0; column < columns; column += 1) {
    visit(column, 0)
    visit(column, rows - 1)
  }
  for (let row = 0; row < rows; row += 1) {
    visit(0, row)
    visit(columns - 1, row)
  }
  while (stack.length > 0) {
    const cell = stack.pop()
    if (cell === undefined) break
    const column = cell % columns
    const row = (cell - column) / columns
    visit(column - 1, row)
    visit(column + 1, row)
    visit(column, row - 1)
    visit(column, row + 1)
  }
  return mask
}

/** 从参考图采样轮廓与色块：只取猪头本身的像素，保留眼睛白点高光为 priority 点。 */
export function samplePig(image: HTMLImageElement, width: number, height: number): ShapePoint[] {
  const surface = document.createElement('canvas')
  surface.width = Math.max(1, Math.floor(width))
  surface.height = Math.max(1, Math.floor(height))
  const context = surface.getContext('2d', { willReadFrequently: true })
  if (!context) return []

  // 只画内容框：整图留白被裁掉，猪头因此占满目标尺寸。
  const bounds = measureContentBounds(image)
  const rect = pigDrawRect(image, width, height)
  const scaleX = rect.width / Math.max(1, image.naturalWidth || image.width)
  const scaleY = rect.height / Math.max(1, image.naturalHeight || image.height)
  const cropLeft = rect.x + bounds.x * scaleX
  const cropTop = rect.y + bounds.y * scaleY
  const cropWidth = bounds.width * scaleX
  const cropHeight = bounds.height * scaleY

  context.clearRect(0, 0, width, height)
  context.drawImage(
    image,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
    cropLeft,
    cropTop,
    cropWidth,
    cropHeight,
  )

  const pixels = context.getImageData(0, 0, surface.width, surface.height).data
  const stride = Math.max(2, Math.round(Math.min(cropWidth, cropHeight) / 220))
  const points: ShapePoint[] = []
  const isDark = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= surface.width || y >= surface.height) return false
    const index = (y * surface.width + x) * 4
    return pixels[index] < 180 && pixels[index + 1] < 180 && pixels[index + 2] < 180
  }

  const minX = Math.max(0, Math.floor(cropLeft))
  const maxX = Math.min(surface.width, Math.ceil(cropLeft + cropWidth))
  const minY = Math.max(0, Math.floor(cropTop))
  const maxY = Math.min(surface.height, Math.ceil(cropTop + cropHeight))
  const columns = Math.max(1, Math.ceil((maxX - minX) / stride))
  const rows = Math.max(1, Math.ceil((maxY - minY) / stride))
  const isBlank = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= surface.width || y >= surface.height) return true
    const index = (y * surface.width + x) * 4
    if (pixels[index + 3] < 100) return true
    return (
      pixels[index] >= BLANK_CHANNEL && pixels[index + 1] >= BLANK_CHANNEL && pixels[index + 2] >= BLANK_CHANNEL
    )
  }
  const background = backgroundMask(isBlank, minX, minY, stride, columns, rows)

  for (let row = 0; row < rows; row += 1) {
    const y = minY + row * stride
    if (y >= maxY) break
    for (let column = 0; column < columns; column += 1) {
      const x = minX + column * stride
      if (x >= maxX) break
      // 白底像素不是猪头的一部分：采样它们只会在轮廓外侧画出一圈白色亮带。
      if (background[row * columns + column] === 1) continue
      const index = (y * surface.width + x) * 4
      const red = pixels[index]
      const green = pixels[index + 1]
      const blue = pixels[index + 2]
      const nearWhite = red > 249 && green > 249 && blue > 249
      let highlight = false
      if (nearWhite) {
        for (let ny = -4; ny <= 4 && !highlight; ny += 2) {
          for (let nx = -4; nx <= 4; nx += 2) {
            if (isDark(x + nx, y + ny)) {
              highlight = true
              break
            }
          }
        }
      }
      if (!nearWhite || highlight) {
        // 分区坐标按"内容框"归一化：参考图的构图比例不因裁剪而改变。
        const pigRegion = pigRegionAt((x - cropLeft) / cropWidth, (y - cropTop) / cropHeight)
        points.push({ x, y, color: [red, green, blue], priority: highlight, pigRegion })
      }
    }
  }
  return points
}

/** 参考图加载失败时的降级轮廓，仍保持正面构图与主要分区。 */
export function fallbackPig(width: number, height: number): ShapePoint[] {
  const points: ShapePoint[] = []
  const cx = width / 2
  const cy = height / 2
  const rx = width * 0.3
  const ry = height * 0.29
  for (let index = 0; index < 1100; index += 1) {
    const angle = Math.random() * Math.PI * 2
    const radius = Math.sqrt(Math.random())
    const nx = Math.cos(angle) * radius
    const ny = Math.sin(angle) * radius
    points.push({
      x: cx + nx * rx,
      y: cy + ny * ry,
      color: pigPalette,
      pigRegion: pigRegionAt(0.5 + nx * 0.42, 0.5 + ny * 0.42),
    })
  }
  return points
}

/** 权重下限：最亮的点也保留一点被抽中的机会，面填充不会整体消失。 */
const MIN_POINT_WEIGHT = 0.02
/** 高光簇的连通距离下限与实际使用的相对尺度（按形状包围盒短边取比例）。 */
const PRIORITY_CLUSTER_MIN_LINK = 3
const PRIORITY_CLUSTER_LINK_RATIO = 0.03
/** 单个高光簇最多分到的粒子数：眼睛高光只要几个点，堆多了就成了白色亮块。 */
export const PRIORITY_CLUSTER_LIMIT = 4

/**
 * 猪头权重：越暗越重要。
 * 实测参考图采样点里深色轮廓/五官（平均 luma≈95）只占 18%，浅粉面填充（平均 luma≈225）占 82%，
 * 均匀抽取等于把粒子按面积摊平，轮廓被稀释成噪点团；按亮度加权后深色点能拿到约 78% 的粒子。
 */
export const PIG_WEIGHT_EXPONENT = 2.2
export function pigPointWeight(point: ShapePoint): number {
  const luma = 0.299 * point.color[0] + 0.587 * point.color[1] + 0.114 * point.color[2]
  return Math.max(MIN_POINT_WEIGHT, Math.pow(1 - luma / 255, PIG_WEIGHT_EXPONENT))
}

/** 结构重要度的亮度区间：luma≈95 的轮廓/五官记 1，luma≥165 的浅粉面填充记 0。 */
const STRUCTURE_EMPHASIS_LOW = 0.35
const STRUCTURE_EMPHASIS_SPAN = 0.3

/**
 * 结构重要度（0~1）：与加权同源，同样只看亮度，供渲染时区分点径——
 * 轮廓/五官画大一点、面填充画小一点，"轮廓密、面填充疏"的对比才不会碎成虚线。
 */
export function pigStructureEmphasis(color: RGB): number {
  const luma = 0.299 * color[0] + 0.587 * color[1] + 0.114 * color[2]
  return clamp((1 - luma / 255 - STRUCTURE_EMPHASIS_LOW) / STRUCTURE_EMPHASIS_SPAN, 0, 1)
}

type PointCluster = { sumX: number; sumY: number; points: ShapePoint[] }

/** 按空间近邻聚簇：每簇用质心做增量比较，顺序遍历保证同一输入得到同一结果。 */
function clusterByProximity(points: ShapePoint[], linkDistance: number): ShapePoint[][] {
  const clusters: PointCluster[] = []
  for (const point of points) {
    let hit: PointCluster | null = null
    for (const cluster of clusters) {
      const centerX = cluster.sumX / cluster.points.length
      const centerY = cluster.sumY / cluster.points.length
      if (Math.hypot(point.x - centerX, point.y - centerY) <= linkDistance) {
        hit = cluster
        break
      }
    }
    if (hit) {
      hit.points.push(point)
      hit.sumX += point.x
      hit.sumY += point.y
    } else {
      clusters.push({ sumX: point.x, sumY: point.y, points: [point] })
    }
  }
  return clusters.map((cluster) => cluster.points)
}

/** 形状包围盒短边的 3%：眼睛白点在参考图里就是十来像素的一小团，簇不能划得比它大。 */
function priorityLinkDistance(points: ShapePoint[]): number {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of points) {
    if (point.x < minX) minX = point.x
    if (point.x > maxX) maxX = point.x
    if (point.y < minY) minY = point.y
    if (point.y > maxY) maxY = point.y
  }
  const span = Math.max(0, Math.min(maxX - minX, maxY - minY))
  return Math.max(PRIORITY_CLUSTER_MIN_LINK, span * PRIORITY_CLUSTER_LINK_RATIO)
}

/**
 * priority 点（眼睛白点高光）的挑选：先聚簇，再按簇设上限并在簇内等间距取样。
 * 逐点限额既保住"低预算下眼睛依然有神"，又不会把所有高光点一起塞进同一只眼睛。
 */
function selectPriorityPoints(points: ShapePoint[], count: number): ShapePoint[] {
  const priorities = points.filter((point) => point.priority)
  if (priorities.length === 0) return []
  const quota = clamp(Math.round(count * 0.002), 1, PRIORITY_CLUSTER_LIMIT)
  const picked: ShapePoint[] = []
  for (const cluster of clusterByProximity(priorities, priorityLinkDistance(points))) {
    const take = Math.min(quota, cluster.length)
    for (let index = 0; index < take; index += 1) {
      picked.push(cluster[Math.floor((index / take) * cluster.length)])
    }
  }
  return picked
}

/**
 * 加权抽稀：按权重降序累积后，在"累积权重轴"上等间距取样。
 * 于是深色区域被整体覆盖（而不是只堆到最暗的少数像素上），浅色面填充按权重占比稀疏保留，
 * 采样位置带确定性抖动，避免等权重区域被抽成规整点阵（摩尔纹）。
 */
function resampleWeighted(points: ShapePoint[], count: number, weightOf: (point: ShapePoint) => number): ShapePoint[] {
  if (count <= 0) return []
  const priorities = selectPriorityPoints(points, count)
  if (priorities.length >= count) return priorities.slice(0, count)
  const regular = points.filter((point) => !point.priority)
  const output = [...priorities]
  const remaining = count - output.length
  if (regular.length > 0) {
    const entries = regular.map((point) => ({ point, weight: Math.max(MIN_POINT_WEIGHT, weightOf(point)) }))
    // 权重降序；等权重时保持原有扫描顺序，因此输出对同一输入完全确定。
    entries.sort((a, b) => b.weight - a.weight)
    const total = entries.reduce((sum, entry) => sum + entry.weight, 0)
    let cumulative = 0
    let cursor = 0
    for (let index = 0; index < remaining; index += 1) {
      const target = ((index + hashUnit(index * 1.37 + 0.11)) / remaining) * total
      while (cursor < entries.length - 1 && cumulative + entries[cursor].weight < target) {
        cumulative += entries[cursor].weight
        cursor += 1
      }
      output.push(entries[cursor].point)
    }
  }
  while (output.length < count) output.push(points[output.length % points.length])
  return output
}

/**
 * 保留 priority 点并按比例抽取：不传 weightOf 时是"均匀抽取"——
 * 预算缩水时轮廓点均匀变稀，但眼睛高光、鼻子这些结构点仍在，字形/图案不会塌掉。
 * 传入 weightOf 后改为按权重抽取（猪头用它把预算压到深色轮廓与五官上）。
 */
export function resample(
  points: ShapePoint[],
  count: number,
  weightOf?: (point: ShapePoint) => number,
): ShapePoint[] {
  if (points.length === 0) return []
  if (weightOf) return resampleWeighted(points, count, weightOf)
  const priorities = points.filter((point) => point.priority)
  const regular = points.filter((point) => !point.priority)
  const reserved = Math.min(priorities.length, Math.max(0, Math.floor(count * 0.14)))
  const output = priorities.slice(0, reserved)
  const remaining = Math.max(0, count - output.length)
  for (let index = 0; index < remaining; index += 1) {
    if (regular.length > 0) {
      const sourceIndex = Math.floor((index / Math.max(1, remaining)) * regular.length)
      output.push(regular[sourceIndex % regular.length])
    } else {
      output.push(points[index % points.length])
    }
  }
  while (output.length < count) output.push(points[output.length % points.length])
  return output
}

export function makeGalaxyTarget(width: number, height: number): ShapePoint {
  const centerX = width / 2
  const centerY = height / 2
  const radius = Math.pow(Math.random(), 0.62) * Math.min(width, height) * 0.66
  const angle = Math.random() * Math.PI * 2 + radius * 0.012
  return {
    x: centerX + Math.cos(angle) * radius * 1.12,
    y: centerY + Math.sin(angle) * radius * 0.58,
    color: galaxyPalette[Math.floor(Math.random() * galaxyPalette.length)],
  }
}

/** 收束样式：文字 + 一圈带快慢差异的光环，光环缓慢公转避免画面静止。 */
export function makeClosingPoints(width: number, height: number): ShapePoint[] {
  const points = sampleText(CLOSING_LINES, width, height, closingPalette)
  const centerX = width / 2
  const centerY = height / 2
  const radius = Math.min(width, height) * 0.36
  for (let index = 0; index < 180; index += 1) {
    const angle = (Math.PI * 2 * index) / 180
    const spread = radius * (0.78 + (index % 9) / 28)
    points.push({
      x: centerX + Math.cos(angle) * spread,
      y: centerY + Math.sin(angle) * spread * 0.62,
      color: index % 4 === 0 ? goldHighlight : closingPalette,
      shapeBand: 'ring',
      bandFactor: 0.5 + ((index % 7) / 7) * 0.9,
    })
  }
  return points
}

export function buildShapePoints(
  mode: Exclude<ParticleMode, 'galaxy'>,
  width: number,
  height: number,
  pigImage: HTMLImageElement | null,
): ShapePoint[] {
  if (mode === 'birthday') return sampleText(BIRTHDAY_LINES, width, height, birthdayPalette)
  if (mode === 'closing') return makeClosingPoints(width, height)
  return pigImage ? samplePig(pigImage, width, height) : fallbackPig(width, height)
}
