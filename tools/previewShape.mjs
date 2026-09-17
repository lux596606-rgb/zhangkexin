/**
 * 采样结果预览：离线跑 samplePig / sampleText 的等价算法并输出 SVG，
 * 用来分辨"采样点本身不对"还是"粒子太少、太散导致看不出来"。
 * 运行：node tools/previewShape.mjs
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const WIDTH = 648
const HEIGHT = 532
const OUT_DIR = `${process.cwd()}\\tmp-artifacts`

function decodePng(buffer) {
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 6
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      colorType = data[9]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  const channels = colorType === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(width * height * 4)
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride))
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0
      const b = previous[x]
      const c = x >= channels ? previous[x - channels] : 0
      let value = line[x]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      line[x] = value & 0xff
    }
    for (let x = 0; x < width; x += 1) {
      out[(y * width + x) * 4] = line[x * channels]
      out[(y * width + x) * 4 + 1] = line[x * channels + 1]
      out[(y * width + x) * 4 + 2] = line[x * channels + 2]
      out[(y * width + x) * 4 + 3] = channels === 4 ? line[x * channels + 3] : 255
    }
    previous = line
  }
  return { width, height, data: out }
}

const image = decodePng(readFileSync(`${process.cwd()}\\src\\assets\\pink-pig-reference.png`))

function contentBoundingBox(img, blank = 244) {
  let minX = img.width, minY = img.height, maxX = -1, maxY = -1
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      const i = (y * img.width + x) * 4
      const isBlank = img.data[i + 3] <= 24 || (img.data[i] >= blank && img.data[i + 1] >= blank && img.data[i + 2] >= blank)
      if (isBlank) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

const bounds = contentBoundingBox(image)
const box = Math.min(WIDTH * 0.8, HEIGHT * 0.86)
const scale = Math.min(box / bounds.w, box / bounds.h)
const drawWidth = bounds.w * scale
const drawHeight = bounds.h * scale
const offsetX = (WIDTH - drawWidth) / 2
const offsetY = (HEIGHT - drawHeight) / 2

/** 与 samplePig 等价：非纯白即采样，记录源色。 */
function samplePig(img) {
  const stride = Math.max(2, Math.round(Math.max(drawWidth, drawHeight) / 220))
  const points = []
  for (let y = Math.max(0, Math.floor(offsetY)); y < Math.min(HEIGHT, Math.ceil(offsetY + drawHeight)); y += stride) {
    for (let x = Math.max(0, Math.floor(offsetX)); x < Math.min(WIDTH, Math.ceil(offsetX + drawWidth)); x += stride) {
      const sx = Math.min(img.width - 1, Math.max(0, Math.round(bounds.x + (x - offsetX) / scale)))
      const sy = Math.min(img.height - 1, Math.max(0, Math.round(bounds.y + (y - offsetY) / scale)))
      const i = (sy * img.width + sx) * 4
      const r = img.data[i]
      const g = img.data[i + 1]
      const b = img.data[i + 2]
      if (r > 249 && g > 249 && b > 249) continue
      points.push({ x, y, r, g, b })
    }
  }
  return { points, stride }
}

const pig = samplePig(image)

/** 与 resample 的"priority 优先"等价的加权抽稀：深色轮廓/五官优先，浅色面填充让位。 */
function weightedResample(points, count) {
  const withWeight = points.map((p) => {
    const luma = 0.299 * p.r + 0.587 * p.g + 0.114 * p.b
    // 越暗越重要：轮廓(≈110)权重高，粉色面填充(≈205)权重低
    return { ...p, weight: Math.max(0.02, Math.pow(1 - luma / 255, 2.2)) }
  })
  const total = withWeight.reduce((sum, p) => sum + p.weight, 0)
  const out = []
  const sorted = [...withWeight].sort((a, b) => b.weight - a.weight)
  let cumulative = 0
  let cursor = 0
  for (let index = 0; index < count; index += 1) {
    const target = ((index + 0.5) / count) * total
    while (cumulative < target && cursor < sorted.length - 1) {
      cumulative += sorted[cursor].weight
      cursor += 1
    }
    out.push(sorted[cursor])
  }
  return out
}

/** 均匀抽稀到 count 个点（等价 resample 的均匀抽取）。 */
function resample(points, count) {
  if (points.length === 0) return []
  const out = []
  for (let index = 0; index < count; index += 1) {
    out.push(points[Math.floor((index / count) * points.length)])
  }
  return out
}

function svgOf(points, radius, background = '#090b16', opacity = 0.95) {
  const circles = points
    .map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${radius}" fill="rgb(${p.r},${p.g},${p.b})"/>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
<rect width="${WIDTH}" height="${HEIGHT}" fill="${background}"/>
<g opacity="${opacity}">${circles}</g>
</svg>`
}

mkdirSync(OUT_DIR, { recursive: true })
const count = 1379
const sampled = resample(pig.points, count)

writeFileSync(`${OUT_DIR}\\pig-2-resampled-1379.svg`, svgOf(sampled, 1.5))
writeFileSync(`${OUT_DIR}\\pig-3-dense-3500.svg`, svgOf(resample(pig.points, 3500), 1.8))
// 真实预算（baseParticleBudget 在 648×532 上约 1379，high 档 ×1 → 1379）下，换用加权抽稀
writeFileSync(`${OUT_DIR}\\pig-4-weighted-1379.svg`, svgOf(weightedResample(pig.points, 1379), 2.0))
writeFileSync(`${OUT_DIR}\\pig-5-weighted-4200.svg`, svgOf(weightedResample(pig.points, 4200), 2.0))
writeFileSync(`${OUT_DIR}\\pig-6-weighted-3200.svg`, svgOf(weightedResample(pig.points, 3200), 2.1))
writeFileSync(`${OUT_DIR}\\pig-7-weighted-2400.svg`, svgOf(weightedResample(pig.points, 2400), 2.2))

// 分级统计：轮廓（深色）与面填充（粉色）各占多少采样点
let dark = 0
let mid = 0
let light = 0
for (const p of pig.points) {
  const luma = 0.299 * p.r + 0.587 * p.g + 0.114 * p.b
  if (luma < 150) dark += 1
  else if (luma < 235) mid += 1
  else light += 1
}
console.log(`采样点 ${pig.points.length}（步长 ${pig.stride}）`)
console.log(`  深色(轮廓) ${dark}  ${Math.round((dark / pig.points.length) * 100)}%`)
console.log(`  中间调 ${mid}  ${Math.round((mid / pig.points.length) * 100)}%`)
console.log(`  浅色(接近白) ${light}  ${Math.round((light / pig.points.length) * 100)}%`)
console.log(`\n输出：`)
for (const name of ['pig-1-allpoints.svg', 'pig-2-resampled-1379.svg', 'pig-3-dense-3500.svg']) console.log(`  ${OUT_DIR}\\${name}`)
