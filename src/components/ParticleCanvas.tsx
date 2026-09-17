import { useEffect, useRef } from 'react'
import pigReference from '../assets/pink-pig-reference.png'
import { clamp, colorString, lerp, type RGB } from './particleMath'
import {
  FrameStats,
  QualityController,
  SHAPE_PARTICLE_SCALE,
  baseParticleBudget,
  devicePixelRatioForTier,
  fireworkWaveCount,
  particleCountForTier,
  type QualityTier,
} from './particleQuality'
import { ParticleTransition, dispersionOffset, scrambleTargetOrder } from './particleTransition'
import {
  buildShapePoints,
  makeGalaxyTarget,
  pigPointWeight,
  pigStructureEmphasis,
  resample,
  type ParticleMode,
  type ShapePoint,
  type ShapeTargets,
} from './particleShapes'
import {
  clearFireworks,
  createFireworkField,
  drawFireworks,
  spawnFireworkWave,
  updateFireworks,
} from './particleFireworks'

export type { ParticleMode } from './particleShapes'

/** 每帧复用的动画上下文：把"整体量"（呼吸、耳朵、公转）一次算好，热循环里只做取值。 */
type FrameAnimation = {
  activeMode: ParticleMode
  reducedMotion: boolean
  dispersion: number
  shapeScale: number
  earLeft: number
  earRight: number
  ringRotation: number
}

type Particle = {
  x: number
  y: number
  vx: number
  vy: number
  /** 质量升档时从 0 淡入，避免新粒子"啪"地出现。 */
  fade: number
  size: number
  phase: number
  alpha: number
  color: RGB
  targetColor: RGB
  /** 目标缓冲的固定槽位：档位变化只增删尾部粒子，既有对应关系不被打乱。 */
  slot: number
}

export type QualitySnapshot = { tier: QualityTier; fps: number }

/**
 * 渲染循环的唯一入口。所有需要"画面继续跑"的路径（样式切换、尺寸变化、暂停恢复、
 * 启动、质量换档）都只能调用它，任何地方都不允许再自己写 requestAnimationFrame。
 */
type RenderLoop = {
  /** resetBaseline=true 时同时重置帧率窗口与时间基准（暂停恢复、重新编排之后）。 */
  start: (resetBaseline?: boolean) => void
  /** 立即让当前 token 失效并取消已排程的帧。 */
  stop: () => void
}

const galaxyPalette: RGB[] = [
  [255, 226, 213],
  [255, 179, 157],
  [202, 195, 255],
  [255, 245, 228],
]

/** 呼吸/弹动都取小幅度，只让画面"活着"，不破坏参考图构图与文字可读性。 */
const PIG_BREATH_CYCLE = 3.4
const PIG_BREATH_AMPLITUDE = 0.022
/** 猪头点径：深色轮廓/五官放大、浅粉面填充收小，与加权抽稀一起构成"轮廓密、面填充疏"。 */
const PIG_FILL_RADIUS = 0.9
const PIG_EDGE_RADIUS = 1.5
const EAR_CYCLE = 1.45
/** 耳朵周期更短、幅度只有几像素：像被轻轻弹了一下，而不是整体变形。 */
const EAR_OFFSET = 3.4
const TEXT_BREATH_CYCLE = 4.6
const TEXT_BREATH_AMPLITUDE = 0.02
/** 光环缓慢公转，保证聚形完成后画面仍有轻微运动。 */
const RING_CYCLE = 26
/** 两波烟花之间的间隔。 */
const WAVE_INTERVAL = 0.72

function createParticle(width: number, height: number, index: number, fade: number): Particle {
  const color = galaxyPalette[index % galaxyPalette.length]
  return {
    x: Math.random() * width,
    y: Math.random() * height,
    vx: (Math.random() - 0.5) * 14,
    vy: (Math.random() - 0.5) * 10,
    fade,
    size: 0.7 + Math.random() * 1.6,
    phase: Math.random() * Math.PI * 2,
    alpha: 0.4 + Math.random() * 0.5,
    color: [...color],
    targetColor: [...color],
    slot: index,
  }
}

/** 质量档位变化只增删尾部粒子，不重建数组；新增粒子落在目标附近并淡入。 */
function growParticles(
  particles: Particle[],
  width: number,
  height: number,
  count: number,
  targets: ShapeTargets | null,
  mode: ParticleMode,
): void {
  for (let index = particles.length; index < count; index += 1) {
    const particle = createParticle(width, height, index, 0)
    const point = targets && targets.points.length > 0 ? targets.points[index % targets.points.length] : null
    if (mode !== 'galaxy' && point) {
      particle.x = point.x + (Math.random() - 0.5) * 14
      particle.y = point.y + (Math.random() - 0.5) * 14
      particle.targetColor = [...point.color]
    }
    particles.push(particle)
  }
  if (particles.length > count) particles.length = count
}

function createShapeTargets(
  mode: Exclude<ParticleMode, 'galaxy'>,
  width: number,
  height: number,
  pigImage: HTMLImageElement | null,
  count: number,
  seed: number,
): ShapeTargets {
  // 猪头按亮度加权抽稀：参考图 82% 的采样点是浅粉面填充，均匀抽取会把轮廓和五官稀释成噪点团。
  // 文字样式不传权重，保持既有的均匀抽取（字形现在是对的，不动它）。
  const points = resample(
    buildShapePoints(mode, width, height, pigImage),
    count,
    mode === 'pig' ? pigPointWeight : undefined,
  )
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of points) {
    if (point.y < minY) minY = point.y
    if (point.y > maxY) maxY = point.y
  }
  return {
    points,
    buffer: new Array<ShapePoint>(count),
    order: scrambleTargetOrder(count, seed),
    centerX: width / 2,
    centerY: height / 2,
    // 形状包围盒半高：烟花发射点据此避开文字区域。
    halfHeight: Number.isFinite(minY) && Number.isFinite(maxY) ? Math.max(0, (maxY - minY) / 2) : height * 0.12,
  }
}

/** 打散后的固定对应关系：第 i 颗粒子接管 order[i] 号目标。 */
function assignTargets(particles: Particle[], targets: ShapeTargets): void {
  const total = Math.max(1, targets.order.length)
  for (let index = 0; index < particles.length; index += 1) {
    const point = targets.points[targets.order[index % total] % targets.points.length]
    particles[index].slot = index
    targets.buffer[index] = point
    particles[index].targetColor = [...point.color]
  }
}

function earOffset(point: ShapePoint, animation: FrameAnimation): number {
  if (animation.activeMode !== 'pig') return 0
  if (point.pigRegion === 'ear-left') return animation.earLeft
  if (point.pigRegion === 'ear-right') return animation.earRight
  return 0
}

export function ParticleCanvas({
  mode,
  paused,
  flow = { x: 0, y: 0 },
  onQualityChange,
}: {
  mode: ParticleMode
  paused: boolean
  flow?: { x: number; y: number }
  onQualityChange?: (snapshot: QualitySnapshot) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const modeRef = useRef(mode)
  const pausedRef = useRef(paused)
  const reducedMotionRef = useRef(false)
  const particlesRef = useRef<Particle[]>([])
  const dimensionsRef = useRef({ width: 1, height: 1 })
  const animationRef = useRef<number | null>(null)
  const renderFrameRef = useRef<((token: number, timestamp: number) => void) | null>(null)
  /** 由主 effect 挂载的循环所有者；暂停/恢复只通过它操作，不各自排程。 */
  const loopRef = useRef<RenderLoop | null>(null)
  const lastTimeRef = useRef(0)
  const pigImageRef = useRef<HTMLImageElement | null>(null)
  const applyTargetsRef = useRef<((nextMode: ParticleMode) => void) | null>(null)
  const flowRef = useRef(flow)
  const onQualityChangeRef = useRef(onQualityChange)

  useEffect(() => {
    flowRef.current = flow
  }, [flow])

  useEffect(() => {
    onQualityChangeRef.current = onQualityChange
  }, [onQualityChange])

  useEffect(() => {
    modeRef.current = mode
    applyTargetsRef.current?.(mode)
  }, [mode])

  useEffect(() => {
    pausedRef.current = paused
    if (paused) {
      // 暂停交给循环所有者自己取消排程，避免两处各自管理同一个 id。
      loopRef.current?.stop()
      return
    }
    // 恢复：以当前时刻为新基准，不把暂停时长算进 delta。
    lastTimeRef.current = performance.now()
    loopRef.current?.start(true)
  }, [paused])

  useEffect(() => {
    const canvas = canvasRef.current
    const stage = canvas?.parentElement
    if (!canvas || !stage) return undefined
    const context = canvas.getContext('2d')
    if (!context) return undefined
    const ctx: CanvasRenderingContext2D = context

    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    reducedMotionRef.current = mediaQuery.matches

    const frameStats = new FrameStats()
    const controller = new QualityController({ reducedMotion: reducedMotionRef.current })
    const transition = new ParticleTransition()
    const fireworks = createFireworkField()
    let tier: QualityTier = controller.tier
    let baseParticleCount = 1
    let shapeTargets: ShapeTargets | null = null
    let activeApplyMode: ParticleMode | null = null
    let nextWaveAt = 0
    let wavesLaunched = 0
    let fireworksStarted = false
    let lastSnapshotAt = 0
    let lastSnapshotFps = -1
    let lastSnapshotTier: QualityTier | null = null

    const reportQuality = (now: number, nextTier: QualityTier, fps: number | null) => {
      const roundedFps = fps === null ? 0 : Math.round(fps * 10) / 10
      const sameTier = nextTier === lastSnapshotTier
      if (sameTier && Math.abs(roundedFps - lastSnapshotFps) < 1.5) return
      if (sameTier && now - lastSnapshotAt < 420) return
      lastSnapshotAt = now
      lastSnapshotFps = roundedFps
      lastSnapshotTier = nextTier
      onQualityChangeRef.current?.({ tier: nextTier, fps: roundedFps })
    }

    const spawnWave = () => {
      const { width, height } = dimensionsRef.current
      spawnFireworkWave(
        fireworks,
        width,
        height,
        shapeTargets?.halfHeight ?? height * 0.12,
        tier,
        particlesRef.current.length,
      )
    }

    /**
     * 本帧生效的粒子数量：银河沿用基准预算，
     * 文字/猪头样式加一档密度——它们靠点阵本身认形状，太疏就看不出字形/五官。
     */
    const activeParticleCount = () =>
      particleCountForTier(
        baseParticleCount,
        tier,
        reducedMotionRef.current,
        modeRef.current === 'galaxy' ? 1 : SHAPE_PARTICLE_SCALE,
      )

    /** 画布尺寸必须在设置 width/height 之后重设变换，否则 dpr 缩放会叠加。 */
    const applyCanvasSize = (width: number, height: number) => {
      const dpr = devicePixelRatioForTier(window.devicePixelRatio || 1, tier)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      canvas.dataset.quality = tier
      dimensionsRef.current = { width, height }
    }

    /** 档位变化：联动分辨率与粒子数量，形状重新采样但不重播整套过渡。 */
    const applyTier = (nextTier: QualityTier) => {
      tier = nextTier
      const { width, height } = dimensionsRef.current
      applyCanvasSize(width, height)
      const count = activeParticleCount()
      const particles = particlesRef.current
      if (modeRef.current === 'galaxy') {
        shapeTargets = null
        growParticles(particles, width, height, count, null, 'galaxy')
      } else {
        // 新粒子落在新形状的目标附近，避免增档时"从天而降"地乱飞。
        const targets = createShapeTargets(modeRef.current, width, height, pigImageRef.current, count, particles.length + 3)
        growParticles(particles, width, height, count, targets, modeRef.current)
        assignTargets(particles, targets)
        shapeTargets = targets
      }
      ctx.clearRect(0, 0, width, height)
      if (reducedMotionRef.current) loop.start(true)
    }

    const resize = () => {
      const rect = stage.getBoundingClientRect()
      const width = Math.max(1, rect.width)
      const height = Math.max(1, rect.height)
      const previous = dimensionsRef.current
      const layoutChanged = Math.abs(previous.width - width) > 1 || Math.abs(previous.height - height) > 1
      applyCanvasSize(width, height)
      baseParticleCount = baseParticleBudget(width, height, reducedMotionRef.current)
      const count = activeParticleCount()
      if (particlesRef.current.length === 0) {
        particlesRef.current = Array.from({ length: count }, (_, index) => createParticle(width, height, index, 1))
        applyTargets(modeRef.current)
      } else if (layoutChanged && modeRef.current !== 'galaxy') {
        // 形状坐标与画布尺寸绑定：重采样后让粒子柔和飞向新目标，不重播扩散。
        const particles = particlesRef.current
        growParticles(particles, width, height, count, null, modeRef.current)
        const targets = createShapeTargets(modeRef.current, width, height, pigImageRef.current, particles.length, particles.length + 3)
        assignTargets(particles, targets)
        shapeTargets = targets
      } else {
        growParticles(particlesRef.current, width, height, count, shapeTargets, modeRef.current)
      }
      ctx.clearRect(0, 0, width, height)
      if (reducedMotionRef.current) loop.start(true)
    }

    /** 把一帧交给循环所有者：非当前 token（陈旧闭包）的帧在这里就被丢掉，不渲染也不排程。 */
    function runFrame(token: number, timestamp: number) {
      animationRef.current = null
      if (!loop.owner(token)) return
      loop.scheduled = false
      renderFrame(timestamp)
    }

    function renderFrame(timestamp: number) {
      animationRef.current = null
      // 同一帧被多个回调拿到完全相同的 timestamp：只允许当前 token 的那一次推进时间，
      // 这一帧既不推进时钟也不重复绘制、不污染帧率统计。
      // 但仍要续排下一帧：重复帧若直接中断调度链，画面会永久冻住。
      if (timestamp <= loop.lastTimestamp) {
        loop.start()
        return
      }
      loop.lastTimestamp = timestamp

      const previous = lastTimeRef.current || timestamp
      const delta = clamp((timestamp - previous) / 1000, 0, 0.05)
      lastTimeRef.current = timestamp
      // 窗口被节流后（切标签页、恢复播放）本帧不渲染，也不把巨大间隔计入帧率窗口。
      if (timestamp - previous > 300) {
        frameStats.reset()
        loop.start()
        return
      }

      const { width, height } = dimensionsRef.current
      const activeMode = modeRef.current
      const reducedMotion = reducedMotionRef.current
      const particles = particlesRef.current
      const targets = shapeTargets
      const seconds = timestamp / 1000
      const motion = reducedMotion ? 0 : 1
      // 缓动按 60fps 标定：不同刷新率下收拢速度一致，不会在 144Hz 上忽快忽慢。
      const frameScale = clamp(delta * 60, 0.5, 2)

      frameStats.update(timestamp)
      const fps = frameStats.averageFps()
      const decided = controller.update(fps, timestamp)
      if (decided !== tier) applyTier(decided)
      reportQuality(timestamp, decided, fps)

      // 过渡本身不被减少动态效果拦截：形状仍要成形，只是没有多余的持续运动。
      transition.advance(delta)

      // 呼吸与弹动是"整体一个值"，每帧算一次即可，避免逐粒子的三角函数开销。
      const pigBreath = reducedMotion ? 1 : 1 + Math.cos((seconds / PIG_BREATH_CYCLE) * Math.PI * 2) * PIG_BREATH_AMPLITUDE
      const textBreath = reducedMotion ? 1 : 1 + Math.cos((seconds / TEXT_BREATH_CYCLE) * Math.PI * 2) * TEXT_BREATH_AMPLITUDE
      const animation: FrameAnimation = {
        activeMode,
        reducedMotion,
        dispersion: transition.dispersionBlend,
        shapeScale: activeMode === 'pig' ? pigBreath : activeMode === 'birthday' ? textBreath : 1,
        earLeft: reducedMotion ? 0 : -Math.cos(seconds * ((Math.PI * 2) / EAR_CYCLE) + 0.6) * EAR_OFFSET,
        earRight: reducedMotion ? 0 : -Math.cos(seconds * ((Math.PI * 2) / EAR_CYCLE) + 1.9) * EAR_OFFSET,
        ringRotation: reducedMotion ? 0 : (seconds / RING_CYCLE) * Math.PI * 2,
      }

      // 收束样式：星光聚拢完成后放一到两波轻量烟花，总量受档位限制。
      if (activeMode === 'closing' && fireworksStarted && !transition.isRunning) {
        if (wavesLaunched === 0) {
          spawnWave()
          wavesLaunched = 1
          nextWaveAt = seconds + WAVE_INTERVAL
        } else if (wavesLaunched < fireworkWaveCount(tier, reducedMotion) && seconds >= nextWaveAt) {
          spawnWave()
          wavesLaunched += 1
          nextWaveAt = seconds + WAVE_INTERVAL
        }
      }
      updateFireworks(fireworks, delta * motion)

      ctx.clearRect(0, 0, width, height)
      ctx.globalCompositeOperation = 'lighter'

      for (let index = 0; index < particles.length; index += 1) {
        const particle = particles[index]
        if (particle.fade < 1) particle.fade = Math.min(1, particle.fade + delta * 1.5)

        let radiusScale = 1
        let twinkleAmplitude = 0.24
        let glowStrength = 0
        const follow = activeMode === 'galaxy' ? 0 : Math.min(1, transition.gatherWeight(particle.slot + 1) * 0.86 * frameScale)

        if (activeMode === 'galaxy' || !targets) {
          particle.x += (particle.vx + flowRef.current.x * 0.035) * delta * motion
          particle.y += (particle.vy + flowRef.current.y * 0.035) * delta * motion
          if (particle.x < -16) particle.x = width + 16
          if (particle.x > width + 16) particle.x = -16
          if (particle.y < -16) particle.y = height + 16
          if (particle.y > height + 16) particle.y = -16
        } else {
          // 缓冲未命中时退回"粒子自己的槽位取目标"的分支，避免脏数据把粒子甩到角落。
          const point = targets.buffer[particle.slot] ?? targets.points[particle.slot % targets.points.length]
          let offsetX = point.x - targets.centerX
          let offsetY = point.y - targets.centerY
          let pointScale = animation.shapeScale
          if (activeMode === 'closing') {
            twinkleAmplitude = 0.3
            // 光晕强度随文字呼吸周期一起变化，呼吸"看得见"但不会糊掉字形。
            glowStrength = reducedMotion ? 0.3 : 0.5 + Math.cos((seconds / TEXT_BREATH_CYCLE) * Math.PI * 2) * 0.35
            if (point.shapeBand === 'ring') {
              pointScale = textBreath
              const angle = animation.ringRotation * (point.bandFactor ?? 1)
              const cos = Math.cos(angle)
              const sin = Math.sin(angle)
              const rotatedX = offsetX * cos - offsetY * sin
              offsetY = offsetX * sin + offsetY * cos
              offsetX = rotatedX
            }
          }
          if (activeMode === 'pig') {
            // 点径也参与疏密对比：轮廓/五官点更大，浅粉面填充点更小（判定与加权同源，只看亮度）。
            radiusScale =
              1.18 * (PIG_FILL_RADIUS + (PIG_EDGE_RADIUS - PIG_FILL_RADIUS) * pigStructureEmphasis(point.color))
          }
          if (activeMode === 'birthday') radiusScale = 1.08
          const targetX = targets.centerX + offsetX * pointScale + earOffset(point, animation)
          const targetY = targets.centerY + offsetY * pointScale
          if (follow > 0) {
            particle.x += (targetX - particle.x) * follow
            particle.y += (targetY - particle.y) * follow
          }
        }

        // 扩散位移直接累积到位置上，随后被收拢拉回，形成"先散开再聚拢"的编排。
        if (animation.dispersion > 0) {
          const push = dispersionOffset(particle.slot + 1, animation.dispersion, delta * motion)
          particle.x += push.x
          particle.y += push.y
        }

        particle.color[0] = lerp(particle.color[0], particle.targetColor[0], 0.08)
        particle.color[1] = lerp(particle.color[1], particle.targetColor[1], 0.08)
        particle.color[2] = lerp(particle.color[2], particle.targetColor[2], 0.08)

        const twinkle = reducedMotion ? 1 : 1 - twinkleAmplitude + Math.sin(seconds * 2.2 + particle.phase) * twinkleAmplitude
        const radius = particle.size * radiusScale
        if (glowStrength > 0.02) {
          ctx.fillStyle = colorString([255, 235, 193], clamp(glowStrength * 0.4, 0, 0.5))
          ctx.beginPath()
          ctx.arc(particle.x, particle.y, radius * 2.6, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.fillStyle = colorString(particle.color, clamp(particle.alpha * twinkle * particle.fade, 0.08, 0.95))
        ctx.beginPath()
        ctx.arc(particle.x, particle.y, radius, 0, Math.PI * 2)
        ctx.fill()
      }

      drawFireworks(ctx, fireworks)
      ctx.globalCompositeOperation = 'source-over'
      // 只有当前 token 的那一帧才会走到这里，续排下一帧的所有者因此始终唯一。
      if (!reducedMotion) loop.start()
    }

    // 只有 runFrame 具备排程能力：它是 renderFrame 的唯一入口，token 校验在这里完成。
    renderFrameRef.current = runFrame

    /**
     * 渲染循环的唯一所有者。
     * 每次调度都带一个单调递增的 token，runFrame 第一行校验 token：
     * StrictMode 双挂载、HMR、样式快速切换留下的陈旧闭包一定拿不到当前 token，
     * 于是既不会渲染、也不会再次排程，更不会覆盖 animationRef 里的 id。
     */
    const loop = {
      token: 0,
      scheduled: false,
      /** 已渲染的最后一帧时间戳：同一帧被多个回调拿到时必须被识别成重复调用。 */
      lastTimestamp: -1,
      /** 用 start 会重置帧率统计与时间基准（暂停恢复、切换样式后的第一帧）。 */
      start(resetBaseline = false) {
        if (pausedRef.current) {
          loop.stop()
          return
        }
        if (resetBaseline) {
          loop.lastTimestamp = -1
          frameStats.reset()
        }
        if (loop.scheduled) return
        loop.token += 1
        loop.scheduled = true
        animationRef.current = requestAnimationFrame((timestamp) => runFrame(loop.token, timestamp))
      },
      /** 让当前 token 立即失效并取消已排程的帧：旧闭包之后再也无法排程。 */
      stop() {
        loop.token += 1
        loop.scheduled = false
        if (animationRef.current !== null) {
          cancelAnimationFrame(animationRef.current)
          animationRef.current = null
        }
      },
      owner(token: number) {
        return token === loop.token
      },
    }
    // 暴露给暂停/恢复：它们只操作这一个所有者，不各自 requestAnimationFrame。
    loopRef.current = loop

    /** 样式切换：重播"散开→缓动收拢"编排，并按打散后的顺序重新绑定目标。 */
    function applyTargets(nextMode: ParticleMode) {
      const { width, height } = dimensionsRef.current
      const particles = particlesRef.current
      if (particles.length === 0) return
      if (nextMode !== activeApplyMode) {
        // 同一目标的重复触发也会重新播放收拢过程，但不会因为"再次进入"而跳变。
        transition.restart()
        activeApplyMode = nextMode
      }
      clearFireworks(fireworks)
      fireworksStarted = false
      wavesLaunched = 0

      if (nextMode === 'galaxy') {
        shapeTargets = null
        for (const particle of particles) {
          particle.targetColor = [...makeGalaxyTarget(width, height).color]
        }
      } else {
        const targets = createShapeTargets(nextMode, width, height, pigImageRef.current, particles.length, particles.length + 3)
        assignTargets(particles, targets)
        shapeTargets = targets
        if (nextMode === 'closing') fireworksStarted = true
      }

      // 只在循环没跑起来时补一次调度；运行中什么都不做，绝不出现第二条循环。
      loop.start(true)
    }

    const onMotionPreferenceChange = (event: MediaQueryListEvent) => {
      reducedMotionRef.current = event.matches
      controller.setReducedMotion(event.matches)
      // 档位立即同步：开启减少动态效果时当场进入低档，不用等下一次帧率决策。
      if (event.matches && tier !== 'low') {
        tier = 'low'
        applyTier('low')
        return
      }
      resize()
    }
    mediaQuery.addEventListener('change', onMotionPreferenceChange)

    const image = new Image()
    image.src = pigReference
    image.onload = () => {
      pigImageRef.current = image
      if (modeRef.current === 'pig') applyTargetsRef.current?.('pig')
    }

    applyTargetsRef.current = applyTargets
    loopRef.current = loop
    const observer = new ResizeObserver(resize)
    observer.observe(stage)
    resize()
    applyTargets(modeRef.current)
    // 启动整个画面只有这一个入口：先立好时间基准，再让循环所有者排第一帧。
    lastTimeRef.current = performance.now()
    loop.start(true)

    return () => {
      observer.disconnect()
      mediaQuery.removeEventListener('change', onMotionPreferenceChange)
      image.onload = null
      // 让 token 失效：StrictMode 双挂载 / HMR 留下的旧闭包再也无法排程或渲染。
      loop.stop()
      loopRef.current = null
      renderFrameRef.current = null
      applyTargetsRef.current = null
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    }
  }, [])

  return <canvas ref={canvasRef} className="particle-canvas" aria-hidden="true" />
}
