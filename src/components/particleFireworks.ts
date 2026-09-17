import { colorString, clamp, hexToRgb, lerp, type RGB } from './particleMath'
import { fireworkParticleCount, type QualityTier } from './particleQuality'

const FIREWORK_COLORS: RGB[] = [
  hexToRgb('#fff4e6'),
  hexToRgb('#ff9f8e'),
  hexToRgb('#ffc978'),
]

type FireworkParticle = {
  x: number
  y: number
  vx: number
  vy: number
  age: number
  /** 前一段是先上升的拖尾飞行，到点后才爆发。 */
  fuse: number
  life: number
  size: number
  color: RGB
}

type Flash = { x: number; y: number; age: number; life: number; radius: number }

export type FireworkField = { particles: FireworkParticle[]; flashes: Flash[] }

export function createFireworkField(): FireworkField {
  return { particles: [], flashes: [] }
}

export function clearFireworks(field: FireworkField): void {
  field.particles.length = 0
  field.flashes.length = 0
}

/**
 * 发射一波烟花。文字包围盒上方的左右两角是"空白区"：
 * 爆发点固定在那里，发射点在文字下方，扩散方向再向外偏，整个过程不压在"生日快乐，张珂欣"上。
 */
export function spawnFireworkWave(
  field: FireworkField,
  width: number,
  height: number,
  halfHeight: number,
  tier: QualityTier,
  particleBudget: number,
): void {
  const count = fireworkParticleCount(tier, particleBudget)
  const textTop = Math.max(height * 0.04, height / 2 - halfHeight)
  const textBottom = Math.min(height * 0.96, height / 2 + halfHeight)
  const burstY = textTop * 0.72
  const burstX = width * (Math.random() < 0.5 ? 0.13 + Math.random() * 0.14 : 0.73 + Math.random() * 0.14)
  const emitY = Math.min(height * 0.94, Math.max(burstY + height * 0.25, textBottom + height * 0.04))
  const riseTime = 0.5 + Math.random() * 0.08
  const outward = burstX < width / 2 ? -1 : 1
  const spreadAngle = outward * (0.34 + Math.random() * 0.16)

  for (let index = 0; index < count; index += 1) {
    const angle = spreadAngle + (Math.random() - 0.5) * Math.PI * 1.8
    // 速度的平方分布让外圈稀疏、中心密集，更接近真实烟花。
    const speed = (70 + Math.pow(Math.random(), 0.6) * 190) * (tier === 'low' ? 0.9 : 1)
    const life = riseTime + 0.9 + Math.random() * 0.5
    field.particles.push({
      x: burstX + (Math.random() - 0.5) * 5,
      y: emitY,
      vx: Math.cos(angle) * speed * 0.3,
      // 发射速度由"上升距离 / 上升时间"给出，保证爆发点落在预期位置。
      vy: (burstY - emitY) / riseTime + Math.sin(angle) * speed * 0.25,
      age: 0,
      fuse: riseTime,
      life,
      size: 0.8 + Math.random() * 1.3,
      color: FIREWORK_COLORS[Math.floor(Math.random() * FIREWORK_COLORS.length)],
    })
  }
  field.flashes.push({ x: burstX, y: burstY, age: 0, life: 0.42, radius: Math.max(26, Math.min(width, height) * 0.06) })
}

/** 拖尾阶段的重力只有很小一部分，爆发后才完全生效。 */
const GRAVITY = 210
const FUSE_GRAVITY_RATIO = 0.22
const DRAG = 1.5

export function updateFireworks(field: FireworkField, deltaSeconds: number): void {
  const drag = Math.exp(-DRAG * deltaSeconds)
  let write = 0
  for (let read = 0; read < field.particles.length; read += 1) {
    const particle = field.particles[read]
    particle.age += deltaSeconds
    if (particle.age >= particle.life) continue
    if (particle.age < particle.fuse) {
      // 拖尾飞行阶段速度基本保持，接近顶点时才爆发。
      particle.vy += GRAVITY * FUSE_GRAVITY_RATIO * deltaSeconds
      particle.vx *= Math.exp(-0.4 * deltaSeconds)
    } else {
      particle.vy += GRAVITY * deltaSeconds
      particle.vx *= drag
      particle.vy *= drag
    }
    particle.x += particle.vx * deltaSeconds
    particle.y += particle.vy * deltaSeconds
    field.particles[write] = particle
    write += 1
  }
  field.particles.length = write

  let flashWrite = 0
  for (let read = 0; read < field.flashes.length; read += 1) {
    const flash = field.flashes[read]
    flash.age += deltaSeconds
    if (flash.age >= flash.life) continue
    field.flashes[flashWrite] = flash
    flashWrite += 1
  }
  field.flashes.length = flashWrite
}

export function drawFireworks(context: CanvasRenderingContext2D, field: FireworkField): void {
  for (const flash of field.flashes) {
    const t = clamp(flash.age / flash.life, 0, 1)
    const radius = flash.radius * (0.35 + t * 0.9)
    context.fillStyle = `rgba(255, 244, 228, ${(1 - t) * 0.3})`
    context.beginPath()
    context.arc(flash.x, flash.y, radius, 0, Math.PI * 2)
    context.fill()
  }

  for (const particle of field.particles) {
    const t = clamp(particle.age / particle.life, 0, 1)
    // 前 12% 生命淡入、后 55% 淡出，避免爆发瞬间的硬边。
    const fade = t < 0.12 ? t / 0.12 : 1 - clamp((t - 0.45) / 0.55, 0, 1)
    const alpha = fade * (particle.age < particle.fuse ? 0.75 : 0.9)
    if (alpha <= 0.02) continue
    const radius = particle.size * (particle.age < particle.fuse ? 0.8 : lerp(1.05, 0.6, t))
    context.fillStyle = colorString(particle.color, clamp(alpha, 0, 0.95))
    context.beginPath()
    context.arc(particle.x, particle.y, radius, 0, Math.PI * 2)
    context.fill()
  }
}
