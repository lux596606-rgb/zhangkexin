/**
 * 密度实测：用与前端同源的算法离线算出形状采样点，输出 SVG 预览 + 覆盖率/密度指标。
 * 目的：判断"形状本身对不对"和"需要多少粒子才读得出来"。
 * 运行：node tools/density.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const WIDTH = 648
const HEIGHT = 532
const OUT_DIR = `${process.cwd()}\\tmp-artifacts`

/** 最小 PNG 解码：只处理本项目用到的 8 位 RGB/RGBA 非隔行 PNG。 */
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
      const bitDepth = data[8]
      colorType = data[9]
      const interlace = data[12]
      if (bitDepth !== 8 || interlace !== 0) throw new Error(`不支持的 PNG: depth=${bitDepth} interlace=${interlace}`)
    } else if (type === 'IDAT') {
      idat.push(data)
      } else if (type === 'IEND') break
    offset += 12 + length
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (channels === 0) throw new Error(`不支持的 PNG colorType=${colorType}`)
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

/** 与 samplePig 一致：按内容框 fit 绘制，再按"非纯白"收集点。 */
function samplePig(image) {
  const bounds = contentBoundingBox(image)
  const box = Math.max(1, Math.min(WIDTH * 0.8, HEIGHT * 0.86))
  const scale = Math.min(box / bounds.w, box / bounds.h)
  const drawWidth = bounds.w * scale
  const drawHeight = bounds.h * scale
  const offsetX = (WIDTH - drawWidth) / 2
  const offsetY = (HEIGHT - drawHeight) / 2
  const stride = Math.max(2, Math.round(Math.max(drawWidth, drawHeight) / 220))
  const points = []
  for (let y = Math.max(0, Math.floor(offsetY)); y < Math.min(HEIGHT, Math.ceil(offsetY + drawHeight)); y += stride) {
    for (let x = Math.max(0, Math.floor(offsetX)); x < Math.min(WIDTH, Math.ceil(offsetX + drawWidth)); x += stride) {
      // 目标点坐标 -> 源图坐标
      const sx = Math.min(image.width - 1, Math.max(0, Math.round(bounds.x + (x - offsetX) / scale)))
      const sy = Math.min(image.height - 1, Math.max(0, Math.round(bounds.y + (y - offsetY) / scale)))
      const index = (sy * image.width + sx) * 4
      const near = (channel) => image.data[index + channel] > 249
      if (near(0) && near(1) && near(2)) continue
      points.push({ x, y })
    }
  }
  return { points, bounds, scale, offsetX, offsetY, drawWidth, drawHeight, stride, alphaBox: alphaBoundingBox(image) }
}

function alphaBoundingBox(image) {
  let minX = image.width, minY = image.height, maxX = -1, maxY = -1
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3] > 32) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY, inImagePx: image.width }
}

/** 与 measureContentBounds 一致：非白像素即内容（参考图无 alpha 通道）。 */
function contentBoundingBox(image, blankChannel = 244) {
  let minX = image.width, minY = image.height, maxX = -1, maxY = -1
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const index = (y * image.width + x) * 4
      const blank =
        image.data[index + 3] <= 24 ||
        (image.data[index] >= blankChannel && image.data[index + 1] >= blankChannel && image.data[index + 2] >= blankChannel)
      if (blank) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/**
 * 用同样的字体度量逻辑估算文字像素面积（Node 无 canvas，用字形墨水率上界估算）。
 * 汉字墨水率约 0.30~0.36，这里取 0.33 作为中值参考。
 */
function textMetrics() {
  const fontSize = Math.min(WIDTH * 0.17, HEIGHT * 0.235)
  const inkRatio = 0.33
  const chars = 4
  const lineArea = chars * fontSize * fontSize
  return { fontSize: Math.round(fontSize * 10) / 10, inkPixels: Math.round(lineArea * inkRatio * 2 / 2), bbox: { w: Math.round(fontSize * 2.2), h: Math.round(fontSize * 2.16) } }
}

const pigPng = decodePng(Buffer.from(await import('node:fs').then((fs) => fs.readFileSync(`${process.cwd()}\\src\\assets\\pink-pig-reference.png`))))
const pig = samplePig(pigPng)
console.log('=== 参考图 ===')
console.log(`图片 ${pigPng.width}x${pigPng.height}，非透明包围盒 ${JSON.stringify(pig.alphaBox)}`)
console.log(`内容框(非白) ${JSON.stringify(pig.bounds)}  缩放 ${pig.scale.toFixed(3)}  落点 (${Math.round(pig.offsetX)}, ${Math.round(pig.offsetY)})  绘制 ${Math.round(pig.drawWidth)}x${Math.round(pig.drawHeight)}  采样步长 ${pig.stride}`)
console.log(`pig 采样点 ${pig.points.length} 个`)
let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9
for (const p of pig.points) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y }
const pigBox = { x: Math.round(minX), y: Math.round(minY), w: Math.round(maxX - minX), h: Math.round(maxY - minY) }
const pigBoxArea = pigBox.w * pigBox.h
console.log(`pig 采样包围盒 ${JSON.stringify(pigBox)}，画布 ${WIDTH}x${HEIGHT}`)

const text = textMetrics()
console.log('\n=== 文字（生日快乐）估算 ===')
console.log(`字号 ${text.fontSize}px，两行包围盒约 ${text.bbox.w}x${text.bbox.h}，墨水像素约 ${text.inkPixels}`)

console.log('\n=== 密度需求（点亮像素数 = 粒子数 × πr²，重叠忽略不计） ===')
const shapes = [
  ['pig（整头墨水区）', pigBoxArea],
  ['pig（若只保留轮廓线，约 8% 面积）', Math.round(pigBoxArea * 0.08)],
  ['文字墨水区', text.inkPixels],
]
for (const [label, inkArea] of shapes) {
  const dotsFor = (r) => Math.ceil((inkArea / (Math.PI * r * r)) * 0.55)
  console.log(`${label}: 墨水面 ${inkArea}px² → r=1.5 需 ≈${dotsFor(1.5)} 点 / r=2.2 需 ≈${dotsFor(2.2)} 点 / r=3 需 ≈${dotsFor(3)} 点`)
}

const current = 1379
console.log(`\n当前预算 ${current} 个粒子（r≈1.5）实际只能覆盖约 ${Math.round(current * Math.PI * 1.5 * 1.5)}px² 的点面积：`)
console.log(` - 对文字墨水区覆盖率约 ${Math.round(((current * Math.PI * 2.25) / text.inkPixels) * 100)}%（此值越低越读不出字形）`)
console.log(` - 对猪头采样包围盒覆盖率约 ${Math.round(((current * Math.PI * 2.25) / pigBoxArea) * 100)}%`)

// 输出 SVG 预览，直接肉眼看形状是否成立
mkdirSync(OUT_DIR, { recursive: true })
const dots = (points, r, color) => points.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" fill="${color}"/>`).join('')
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
<rect width="${WIDTH}" height="${HEIGHT}" fill="#090b16"/>
<g opacity="0.95">${dots(pig.points, 1.05, '#f7aeb3')}</g>
<rect x="${pigBox.x}" y="${pigBox.y}" width="${pigBox.w}" height="${pigBox.h}" fill="none" stroke="#4ade80" stroke-width="1" stroke-dasharray="4 3"/>
</svg>`
writeFileSync(`${OUT_DIR}\\density-pig.svg`, svg)
console.log(`\n已输出 ${OUT_DIR}\\density-pig.svg（用同源算法画出的猪头采样点预览）`)
