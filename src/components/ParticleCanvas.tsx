import { useEffect, useRef } from 'react'
import pigReference from '../assets/pink-pig-reference.png'
import { clamp, colorString, colorStringFast, lerp, type RGB } from './particleMath'
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
import { ParticleTransition, dispersionOffset, hashUnit, scrambleTargetOrder } from './particleTransition'
import {
  buildShapePoints,
  makeGalaxyTarget,
  pigPointWeight,
  pigStructureEmphasis,
  resample,
  textLinesFor,
  type ParticleMode,
  type ShapePoint,
  type ShapeTargets,
} from './particleShapes'
import {
  clearFireworks,
  createFireworkField,
  drawFireworks,
  spawnBackgroundFirework,
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

type AmbientParticle = {
  x: number
  y: number
  vx: number
  vy: number
  size: number
  alpha: number
  phase: number
  color: RGB
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

/**
 * 收束样式的点径系数。
 * 每颗粒子都是一枚圆点：点径接近笔画宽度就会糊成一块，太细则字形退化成"串珠"。
 * 0.62 是与字号 106px、密度 2.6 一起在参数试验台上对照定下的档位
 * （见 tmp-artifacts/closing-final.png）：笔画连贯成线，四个字仍然一眼可读，
 * 且保留了"星光点阵"的质感而不是变成一块灯牌。
 */
const CLOSING_DOT_SCALE = 0.62
/**
 * 收束样式的密度加成。
 * 采样步长按字号走，采样点数量与字号呈平方关系；
 * 这里把粒子预算提到 2.6 倍，让"采样点多于粒子数"，笔画才是密点排成的实线，
 * 而不是同一批采样点被反复复用的串珠。
 */
const CLOSING_DENSITY_SCALE = 2.6

/**
 * 收束文字底下的"柔光"层。
 *
 * 纯靠粒子画 CJK 字形有一个物理上限：`愿望成真` 四个字的笔画数量远多于 `生日快乐`，
 * 在同样的画布与粒子预算下，"看得出是哪个字"始终不稳——这是采样密度与笔画复杂度的问题，
 * 再调点径也解决不了，所以在粒子之下垫一层同字体、同字号、同位置的底。
 *
 * 这一层**必须是柔光，不能是描边**：
 * 描边会沿笔画拉出一圈等宽实线，远看就是"套在文字外面的一只框"，非常突兀
 * （第一版就是等宽描边，被一眼看出来）。
 * 现在改成"多层递减的圆头描边"叠出来的光晕：每层都很淡、越外越淡，
 * 视觉上像字在薄雾里发着光，而不是字被框起来。
 * 半径压在几个像素以内，它只托住字形、不糊字。
 * 另外整层画在**一半分辨率**的离屏画布上再放大回来，天然带一层柔化，
 * 避开了低分辨率下的硬边。
 */
const TEXT_GLOW_LAYERS: ReadonlyArray<{ width: number; alpha: number }> = [
  { width: 8, alpha: 0.035 },
  { width: 5, alpha: 0.055 },
  { width: 2.8, alpha: 0.08 },
]
/** 光晕的暖色：取金色高光，与星尘同一套色系。 */
const TEXT_GLOW_COLOR: RGB = [255, 226, 176]
/** 光晕层分辨率相对画布的比值：越低越柔，但太低会糊掉字形。 */
const TEXT_GLOW_RESOLUTION = 0.5
/** 与 sampleText 的 TEXT_LINE_HEIGHT_RATIO 同源；改一处必须同时改另一处。 */
const TEXT_OUTLINE_LINE_HEIGHT = 1.12
/** CJK 在 600 字重下的字身高度与字号之比，用于从采样点包围盒反推字号。 */
const TEXT_OUTLINE_GLYPH_RATIO = 1.16

/** 全部向一个焦点收拢的完成比例：到这里才算"成形"，许愿层在此之前保持安静。 */
const WISH_FOCUS_RATIO = 0.55
const WISH_BEAM_COUNT = 46
/** 上升流星的条数与最长寿命。 */
const WISH_METEOR_COUNT = 16

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

function createAmbientParticle(width: number, height: number, index: number): AmbientParticle {
  const colors: RGB[] = [[255, 220, 190], [188, 204, 255], [255, 246, 220]]
  // 分远近两层：多数是又小又暗的远景尘埃，少数是大而亮的近景星。
  // 全都一样亮会让画面糊成一层白噪点——星空的层次感全靠这个反差。
  const depth = hashUnit(index * 1.31 + 0.7)
  const near = depth > 0.76
  return {
    x: Math.random() * width,
    y: Math.random() * height,
    // 近景横向漂移更快，远景几乎悬停，两层叠起来才有纵深。
    vx: (near ? 17 : 4) + Math.random() * 11,
    vy: (Math.random() - 0.5) * (near ? 11 : 5),
    size: near ? 0.95 + Math.random() * 0.75 : 0.34 + Math.random() * 0.5,
    alpha: near ? 0.44 + Math.random() * 0.34 : 0.13 + Math.random() * 0.26,
    phase: Math.random() * Math.PI * 2,
    color: colors[index % colors.length],
  }
}

/**
 * 全屏星尘的数量。
 * 需求 3.3「深色背景与星尘/银河粒子组成主要场景」——星尘是**整个舞台**的底子，
 * 不能只在中央那一团。按舞台面积给量（每约 1900 平方像素一颗），
 * 560×418 上约 123 颗，矮屏/宽屏按比例跟着变，画面不会被拉空。
 * 这个量刻意压得比"铺满"更低：银河态中央本来就有一千多颗粒子，
 * 底子再密就会把主体淹掉——星尘要的是"满天都是"，不是"满屏都是"。
 * 上限 240 是同时兼顾帧率的硬约束：收束样式已经有 2600 多颗主粒子。
 */
function ambientParticleCount(tier: QualityTier, width: number, height: number): number {
  const tierScale = tier === 'high' ? 1 : tier === 'medium' ? 0.78 : 0.55
  const byArea = (width * height) / 1900
  return Math.max(80, Math.round(clamp(byArea, 100, 240) * tierScale))
}

/**
 * 高亮流星：斜向划过舞台的亮拖尾，是全屏星尘里唯一的"动势"。
 * 与许愿流（竖直、只走两侧）方向刻意不同——流星走对角线、可以横穿画面，
 * 因为它是短暂的，不会像竖线那样在文字上停住。
 */
type StarMeteor = {
  x: number
  y: number
  vx: number
  vy: number
  length: number
  size: number
  life: number
  age: number
  tint: RGB
}

const STAR_METEOR_LIFE = 1.15
/** 相邻两颗流星的间隔（秒）：留出"偶尔划过"的呼吸感，而不是持续不断的雨。 */
const STAR_METEOR_MIN_GAP = 1.9
const STAR_METEOR_MAX_GAP = 4.6
/** 流星速度相对画布对角线之比：越大越"嗖"，越小越"缓缓划过"。 */
const STAR_METEOR_SPEED_MIN = 0.46
const STAR_METEOR_SPEED_MAX = 0.82
/** 拖尾长度相对画布对角线之比。太短像一根短线，太长就糊成一条亮带。 */
const STAR_METEOR_TAIL_RATIO = 0.2

function createStarMeteor(width: number, height: number): StarMeteor {
  // 入口全部落在画面**之内或紧贴边缘**：从很靠外的地方出发，
  // 划进来的过程有一大半在画布外，等于白白浪费一次流星。
  const diagonal = Math.hypot(width, height)
  const speed = diagonal * (STAR_METEOR_SPEED_MIN + Math.random() * (STAR_METEOR_SPEED_MAX - STAR_METEOR_SPEED_MIN))
  // 统一走斜线：多数"左上 → 右下"，少数反向，角度在 26°~44° 之间。
  const downRight = Math.random() < 0.62
  const angle = 0.46 + Math.random() * 0.3
  const dirX = downRight ? Math.cos(angle) : -Math.cos(angle)
  const dirY = Math.sin(angle)
  return {
    x: downRight
      ? -width * 0.04 + Math.random() * width * 0.34
      : width * 1.04 - Math.random() * width * 0.34,
    y: -height * 0.04 + Math.random() * height * 0.24,
    vx: dirX * speed,
    vy: dirY * speed,
    length: diagonal * STAR_METEOR_TAIL_RATIO * (0.8 + Math.random() * 0.5),
    size: 1.5 + Math.random() * 1.3,
    life: STAR_METEOR_LIFE,
    age: 0,
    tint: Math.random() < 0.45 ? [255, 236, 220] : [226, 232, 255],
  }
}

/** 各样式相对基准预算的密度加成：靠点阵认形状的样式需要更密的点。 */
function densityScaleForMode(mode: ParticleMode): number {
  if (mode === 'galaxy') return 1
  if (mode === 'closing') return CLOSING_DENSITY_SCALE
  return SHAPE_PARTICLE_SCALE
}

/** 按目标数量增删数组尾部：增档时补新元素，降档时截断，不重建整个数组。 */
function keepCount<T>(items: T[], target: number, create: (index: number) => T): void {
  while (items.length < target) items.push(create(items.length))
  if (items.length > target) items.length = target
}

/**
 * 上升的许愿流：细长的光丝从底部升起、越往上越淡，给"许愿"一个方向感。
 * 与全屏流动粒子（横向漂移）刻意错开方向，两者叠起来才有纵深感。
 * 横向位置被刻意推到画布两侧：中间留给文字，正中央不出现竖线。
 */
type WishRay = {
  x: number
  baseY: number
  length: number
  width: number
  alpha: number
  speed: number
  offset: number
  phase: number
}

/** 左右各留出一条"跑道"：中间 46% 的宽度不让许愿流进入，文字始终落在干净的区域里。 */
const WISH_RAY_EDGE_RATIO = 0.27

function createWishRay(width: number, height: number): WishRay {
  const lane = Math.random() < 0.5 ? 0 : 1
  const inner = width * WISH_RAY_EDGE_RATIO
  const laneWidth = Math.max(1, width / 2 - inner)
  return {
    x: lane === 0 ? Math.random() * laneWidth : width - Math.random() * laneWidth,
    baseY: height * (0.55 + Math.random() * 0.55),
    length: height * (0.12 + Math.random() * 0.2),
    width: 0.4 + Math.random() * 0.75,
    alpha: 0.06 + Math.random() * 0.13,
    speed: 9 + Math.random() * 17,
    offset: Math.random() * height,
    phase: Math.random() * Math.PI * 2,
  }
}

/** 上升流星：短促的斜向拖尾，与许愿流同向但更快，负责"这一刻在动"的观感。 */
type WishMeteor = {
  x: number
  y: number
  speed: number
  length: number
  alpha: number
  size: number
  tilt: number
}

function createWishMeteor(width: number, height: number): WishMeteor {
  return {
    x: width * (0.05 + Math.random() * 0.9),
    y: height * (1.05 + Math.random() * 0.35),
    speed: 46 + Math.random() * 76,
    length: 16 + Math.random() * 34,
    alpha: 0.18 + Math.random() * 0.4,
    size: 0.5 + Math.random() * 0.7,
    tilt: (Math.random() - 0.5) * 0.5,
  }
}

/** 渐变的量化档数：把逐帧变化的透明度归到有限几档，渐变对象因此可以缓存复用。 */
const GRADIENT_QUANTUM = 12

type GradientCache = {
  get: (key: string, alpha: number, build: () => CanvasGradient) => CanvasGradient
  clear: () => void
}

/**
 * 线性渐变缓存。
 * 每根光丝 / 每颗流星都要一条纵向渐隐，逐帧新建的话一帧就是几十个渐变对象——
 * 实测这正是把收束画面从 150+FPS 拖到 30FPS 的元凶（会触发自动降档、画面反而变糊）。
 * 这里按"几何 + 量化透明度"缓存：档位有限，画布尺寸变化时整体清空即可。
 */
function createGradientCache(): GradientCache {
  const entries = new Map<string, { alpha: number; gradient: CanvasGradient }>()
  return {
    get(key, alpha, build) {
      const level = Math.round(clamp(alpha, 0, 1) * GRADIENT_QUANTUM) / GRADIENT_QUANTUM
      const cached = entries.get(key)
      if (cached && cached.alpha === level) return cached.gradient
      const gradient = build()
      entries.set(key, { alpha: level, gradient })
      return gradient
    },
    clear() {
      entries.clear()
    },
  }
}

/**
 * 质量档位变化只增删尾部粒子，不重建数组；新增粒子落在目标附近并淡入。 */
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
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  for (const point of points) {
    if (point.y < minY) minY = point.y
    if (point.y > maxY) maxY = point.y
    if (point.x < minX) minX = point.x
    if (point.x > maxX) maxX = point.x
  }
  const hasBounds = Number.isFinite(minY) && Number.isFinite(maxY)
  return {
    points,
    buffer: new Array<ShapePoint>(count),
    order: scrambleTargetOrder(count, seed),
    centerX: width / 2,
    centerY: height / 2,
    // 形状包围盒半高/半宽：烟花发射点据此避开文字区域，收束画面的字几乎占满宽度时尤其重要。
    halfHeight: hasBounds ? Math.max(0, (maxY - minY) / 2) : height * 0.12,
    halfWidth: Number.isFinite(minX) && Number.isFinite(maxX) ? Math.max(0, (maxX - minX) / 2) : 0,
    lines: textLinesFor(mode),
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

/**
 * 形状点的确定性抖动（像素）。
 * 采样点是按固定步长在网格上取的，直接落到网格上会让字形带一层规整的点阵纹理
 * （放大后像"格子布"）。给每个点加半个步长以内的固定偏移，网格感就散了，
 * 而字形轮廓不变——用哈希而不是随机数，保证同一颗粒子每一帧都落在同一个位置，不会抖成噪点。
 */
const TARGET_JITTER_RATIO = 0.7

function targetJitter(point: ShapePoint): { x: number; y: number } {
  const stride = point.sampleStride ?? 3
  // 猪头来自参考图采样，本身已按图像纹理分布，不需要再打散。
  if (point.pigRegion) return { x: 0, y: 0 }
  const amount = stride * TARGET_JITTER_RATIO * 0.5
  return {
    x: (hashUnit(point.x * 0.37 + point.y * 0.11 + 1.7) - 0.5) * 2 * amount,
    y: (hashUnit(point.x * 0.19 + point.y * 0.43 + 4.3) - 0.5) * 2 * amount,
  }
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
  /** 基准预算与当前档位：换样式时要据此算出该样式的粒子目标数量。 */
  const baseParticleCountRef = useRef(1)
  const tierRef = useRef<QualityTier>('high')
  /** 当前形状的采样点：换样式时用作新粒子的落点参考，避免它们从画面角落飞进来。 */
  const shapeTargetsRef = useRef<ShapeTargets | null>(null)
  /** 文字柔光层：随形状重建一次，每帧只 drawImage，不重复描字。 */
  const textOutlineRef = useRef<HTMLCanvasElement | null>(null)
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
    // 数量目标随样式变化（收束样式的密度加成更高），所以换样式时必须让粒子池先长到该样式的目标数量，
    // 否则新形状只能拿到上一个样式留下的粒子数——采样点被迫反复复用，笔画会退化成"串珠"。
    const target = particleCountForTier(
      baseParticleCountRef.current,
      tierRef.current,
      reducedMotionRef.current,
      densityScaleForMode(mode),
    )
    const { width, height } = dimensionsRef.current
    const particles = particlesRef.current
    // 优先用上一个形状的采样点作为新粒子的落点：增量的粒子从形状附近淡入，而不是从角落飞进来。
    const growthTargets =
      shapeTargetsRef.current ??
      (mode === 'galaxy'
        ? null
        : createShapeTargets(mode, width, height, pigImageRef.current, target, particles.length + 3))
    growParticles(particles, width, height, target, growthTargets, mode)
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
    const surface: HTMLCanvasElement = canvas
    const context = canvas.getContext('2d')
    if (!context) return undefined
    const ctx: CanvasRenderingContext2D = context

    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    reducedMotionRef.current = mediaQuery.matches

    const frameStats = new FrameStats()
    const controller = new QualityController({ reducedMotion: reducedMotionRef.current })
    const transition = new ParticleTransition()
    const fireworks = createFireworkField()
    const backgroundFireworks = createFireworkField()
    const ambientParticles: AmbientParticle[] = []
    const wishRays: WishRay[] = []
    const wishMeteors: WishMeteor[] = []
    /** 固定 3 条的流星池：复用对象，不在热循环里反复新建。 */
    const starMeteors: StarMeteor[] = Array.from({ length: 3 }, () => ({ x: 0, y: 0, vx: 0, vy: 0, length: 0, size: 0, life: 1, age: STAR_METEOR_LIFE, tint: [255, 226, 213] }))
    const gradientCache = createGradientCache()
    let tier: QualityTier = controller.tier
    let baseParticleCount = 1
    let shapeTargets: ShapeTargets | null = null
    let activeApplyMode: ParticleMode | null = null
    let nextWaveAt = 0
    let wavesLaunched = 0
    let fireworksStarted = false
    let nextBackgroundFireworkAt = 0
    /** 下一颗流星的时刻：进入任何样式都会很快看到第一颗，之后按随机间隔出现。 */
    let nextStarMeteorAt = 0.6
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
        shapeTargets?.halfWidth ?? 0,
      )
    }

    /**
     * 本帧生效的粒子数量：银河沿用基准预算，
     * 文字/猪头样式加一档密度——它们靠点阵本身认形状，太疏就看不出字形/五官。
     * 收束样式只有四个字、字最大，但点径被压到最小，因此需要更高的覆盖密度才不显稀。
     */
    const activeParticleCount = () =>
      particleCountForTier(
        baseParticleCount,
        tier,
        reducedMotionRef.current,
        densityScaleForMode(modeRef.current),
      )

    /** 形状采样点的唯一写入口：本地变量与 ref 必须同步，否则换样式时的落点参考会用到旧形状。 */
    const setShapeTargets = (next: ShapeTargets | null) => {
      shapeTargets = next
      shapeTargetsRef.current = next
      // 柔光层是纯几何、不随时间变化，随形状一起重建一次即可（只有文字样式有）。
      const { width, height } = dimensionsRef.current
      textOutlineRef.current = next ? buildTextGlow(next, width, height) : null
    }

    /**
     * 画布尺寸必须在设置 width/height 之后重设变换，否则 dpr 缩放会叠加。
     * CSS 尺寸永远等于舞台尺寸：后备缓冲可以按档位降分辨率（省性能），
     * 但显示尺寸降下去会在舞台里留出一条空白、并把画面比例带偏。
     */
    const applyCanvasSize = (width: number, height: number) => {
      const dpr = devicePixelRatioForTier(window.devicePixelRatio || 1, tier)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      canvas.dataset.quality = tier
      canvas.dataset.pixelRatio = dpr.toFixed(2)
      dimensionsRef.current = { width, height }
    }

    /** 许愿层的粒子数量按档位缩放：这一层是氛围，永远不该抢走主画质的预算。 */
    const syncWishLayers = (nextTier: QualityTier) => {
      const { width, height } = dimensionsRef.current
      const rayScale = nextTier === 'high' ? 1 : nextTier === 'medium' ? 0.74 : 0.5
      const meteorScale = nextTier === 'high' ? 1 : nextTier === 'medium' ? 0.7 : 0.45
      keepCount(wishRays, Math.max(16, Math.round(WISH_BEAM_COUNT * rayScale)), () => createWishRay(width, height))
      keepCount(wishMeteors, Math.max(6, Math.round(WISH_METEOR_COUNT * meteorScale)), () => createWishMeteor(width, height))
    }

    /** 档位变化：联动分辨率与粒子数量，形状重新采样但不重播整套过渡。 */
    const applyTier = (nextTier: QualityTier) => {
      tier = nextTier
      tierRef.current = nextTier
      const { width, height } = dimensionsRef.current
      applyCanvasSize(width, height)
      const count = activeParticleCount()
      const ambientCount = ambientParticleCount(nextTier, width, height)
      keepCount(ambientParticles, ambientCount, (index) => createAmbientParticle(width, height, index))
      syncWishLayers(nextTier)
      const particles = particlesRef.current
      if (modeRef.current === 'galaxy') {
        setShapeTargets(null)
        growParticles(particles, width, height, count, null, 'galaxy')
      } else {
        // 新粒子落在新形状的目标附近，避免增档时"从天而降"地乱飞。
        const targets = createShapeTargets(modeRef.current, width, height, pigImageRef.current, count, particles.length + 3)
        growParticles(particles, width, height, count, targets, modeRef.current)
        assignTargets(particles, targets)
        setShapeTargets(targets)
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
      // 画布尺寸变了，缓存里的渐变坐标全部失效，整体清空。
      gradientCache.clear()
      applyCanvasSize(width, height)
      baseParticleCount = baseParticleBudget(width, height, reducedMotionRef.current)
      baseParticleCountRef.current = baseParticleCount
      const ambientCount = ambientParticleCount(tier, width, height)
      keepCount(ambientParticles, ambientCount, (index) => createAmbientParticle(width, height, index))
      syncWishLayers(tier)
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
        setShapeTargets(targets)
      } else {
        growParticles(particlesRef.current, width, height, count, shapeTargets, modeRef.current)
      }
      ctx.clearRect(0, 0, width, height)
      if (reducedMotionRef.current) loop.start(true)
    }

    /**
     * 许愿场景的叙事层：许愿流从下往上生长、流星随聚拢进度出现。
     * 两层的出现时机都被收拢进度 gate 住——文字成形之前先留住视线，成形之后才加动势，
     * 这样"更丰富"不会变成"更花"。
     */
    function drawWishScene(delta: number, opacity: number, motion: number) {
      const { width, height } = dimensionsRef.current
      if (opacity <= 0.02) return

      if (motion > 0) {
        for (const meteor of wishMeteors) {
          meteor.y -= meteor.speed * delta
          meteor.x += meteor.speed * delta * meteor.tilt
        }
      }
      for (const meteor of wishMeteors) {
        if (meteor.y + meteor.length < -20) {
          meteor.x = width * (0.05 + Math.random() * 0.9)
          meteor.y = height * (1.05 + Math.random() * 0.35)
          meteor.speed = 46 + Math.random() * 76
          meteor.length = 16 + Math.random() * 34
          meteor.alpha = 0.18 + Math.random() * 0.4
          meteor.size = 0.5 + Math.random() * 0.7
          meteor.tilt = (Math.random() - 0.5) * 0.5
        }
        if (meteor.y > height + 40 || meteor.x < -40 || meteor.x > width + 40) continue
        const fade = clamp((meteor.y + meteor.length) / (height * 0.35), 0, 1)
        const alpha = meteor.alpha * opacity * fade
        if (alpha <= 0.01) continue
        const tailX = meteor.x - meteor.tilt * meteor.length
        const tailY = meteor.y + meteor.length
        // 量化到像素：拖尾位置的小数变化不影响观感，却能让缓存命中。
        const key = `m:${meteor.tilt.toFixed(2)}:${Math.round(meteor.length)}:${Math.round(meteor.x)}:${Math.round(meteor.y)}`
        ctx.strokeStyle = gradientCache.get(key, alpha, () => {
          const gradient = ctx.createLinearGradient(meteor.x, meteor.y, tailX, tailY)
          gradient.addColorStop(0, colorString([255, 246, 224], alpha))
          gradient.addColorStop(1, colorString([255, 205, 156], 0))
          return gradient
        })
        ctx.lineWidth = meteor.size
        ctx.beginPath()
        ctx.moveTo(meteor.x, meteor.y)
        ctx.lineTo(tailX, tailY)
        ctx.stroke()
      }

      // 许愿流：每条光丝一条纵向渐隐，位置量化到像素以命中缓存。
      const baseAlpha = clamp(0.2 + opacity * 0.42, 0, 0.7)
      for (let index = 0; index < wishRays.length; index += 1) {
        const ray = wishRays[index]
        if (motion > 0) ray.offset += ray.speed * delta
        const span = height + ray.offset + ray.length * 2
        const cycle = ray.baseY - (motion > 0 ? ray.offset % span : 0)
        const head = cycle < -ray.length ? cycle + span : cycle
        const tail = head + ray.length
        if (head < -30 || tail > height + 30) continue
        // 纵向渐隐：越靠中间越淡，文字所在的中段不会糊上一层光。
        const centerBias = 1 - Math.abs((head + tail) / 2 / height - 0.5) * 0.9
        const strength = 0.6 + (baseAlpha * (1 + (index % 4))) / 4
        const alpha = ray.alpha * opacity * clamp(centerBias, 0.15, 1) * strength
        if (alpha <= 0.01) continue
        const key = `r:${index}:${Math.round(head)}`
        ctx.strokeStyle = gradientCache.get(key, alpha, () => {
          const gradient = ctx.createLinearGradient(ray.x, head, ray.x, tail)
          gradient.addColorStop(0, colorString([255, 240, 214], alpha))
          gradient.addColorStop(1, colorString([255, 190, 152], 0))
          return gradient
        })
        ctx.lineWidth = ray.width
        ctx.beginPath()
        ctx.moveTo(ray.x, head)
        ctx.lineTo(ray.x, tail)
        ctx.stroke()
        ctx.fillStyle = colorString([255, 248, 230], Math.min(0.9, alpha * 1.25))
        ctx.beginPath()
        ctx.arc(ray.x, tail, ray.width * 1.4, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    /**
     * 全屏星尘：铺满整个舞台的底子，所有样式都画。
     * 需求 3.3 要的是"深色背景与星尘组成主要场景"，所以它不是收束样式的专属装饰；
     * 每颗粒子是"短拖尾 + 一枚亮点"的两笔，画出来才有星尘的毛边感而不是整齐的点阵。
     */
    function drawAmbientStars(delta: number, seconds: number, motion: number) {
      const { width, height } = dimensionsRef.current
      for (const particle of ambientParticles) {
        let previousX = particle.x
        let previousY = particle.y
        particle.x += particle.vx * delta * motion
        particle.y += particle.vy * delta * motion
        if (particle.x > width + 18) {
          particle.x = -18
          previousX = particle.x
        }
        if (particle.y < -18) {
          particle.y = height + 18
          previousY = particle.y
        }
        if (particle.y > height + 18) {
          particle.y = -18
          previousY = particle.y
        }
        // 每颗星有自己的闪烁相位，整片星尘因此不会一起明灭。
        const twinkle = motion > 0 ? 0.66 + Math.sin(seconds * 1.4 + particle.phase) * 0.3 : 0.86
        ctx.strokeStyle = colorStringFast(particle.color, particle.alpha * twinkle)
        ctx.lineWidth = particle.size
        ctx.beginPath()
        ctx.moveTo(previousX, previousY)
        ctx.lineTo(particle.x, particle.y)
        ctx.stroke()
        ctx.fillStyle = colorStringFast(particle.color, particle.alpha * twinkle * 0.78)
        ctx.beginPath()
        ctx.arc(particle.x, particle.y, particle.size * 1.25, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    /**
     * 高亮流星：按间隔生成、斜向划过、两端渐隐。
     * 亮度走 `lighter` 混合，所以它经过的地方会短暂提亮而不是盖住底下的星尘。
     */
    function drawStarMeteors(delta: number, motion: number) {
      let visible = 0
      if (motion > 0) {
        for (const meteor of starMeteors) {
          meteor.age += delta
          meteor.x += meteor.vx * delta * motion
          meteor.y += meteor.vy * delta * motion
        }
      }
      for (const meteor of starMeteors) {
        if (meteor.age >= meteor.life) continue
        const t = clamp(meteor.age / meteor.life, 0, 1)
        // 前 18% 淡入、后 45% 淡出：划过的过程有头有尾，不会"啪"地出现又消失。
        const fade = t < 0.18 ? t / 0.18 : 1 - clamp((t - 0.55) / 0.45, 0, 1)
        if (fade <= 0.02) continue
        const speedLength = Math.hypot(meteor.vx, meteor.vy) || 1
        const tailX = meteor.x - (meteor.vx / speedLength) * meteor.length
        const tailY = meteor.y - (meteor.vy / speedLength) * meteor.length
        // 头部在最前端：从头部的高亮一路衰减到拖尾末端，这是"高亮流星"的关键。
        const gradient = ctx.createLinearGradient(meteor.x, meteor.y, tailX, tailY)
        gradient.addColorStop(0, colorString([255, 250, 240], Math.min(1, 0.98 * fade)))
        gradient.addColorStop(0.16, colorString(meteor.tint, 0.62 * fade))
        gradient.addColorStop(0.55, colorString(meteor.tint, 0.17 * fade))
        gradient.addColorStop(1, colorString(meteor.tint, 0))
        ctx.strokeStyle = gradient
        ctx.lineWidth = meteor.size
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(meteor.x, meteor.y)
        ctx.lineTo(tailX, tailY)
        ctx.stroke()
        // 头部亮点 + 一圈很克制的柔光。
        // 柔光半径必须小：大一点就从"流星"变成一颗糊在画面上的白色药丸（改大一档就试出来了）。
        ctx.fillStyle = colorString([255, 253, 246], Math.min(1, fade))
        ctx.beginPath()
        ctx.arc(meteor.x, meteor.y, meteor.size * 1.1, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = colorString(meteor.tint, 0.2 * fade)
        ctx.beginPath()
        ctx.arc(meteor.x, meteor.y, meteor.size * 2.4, 0, Math.PI * 2)
        ctx.fill()
        visible += 1
      }
      // 取证用：一帧里画了几颗流星。流星只活 1 秒多，肉眼与截图都容易错过，靠这个计数判断。
      surface.dataset.meteors = String(visible)
    }

    /**
     * 柔光层：用同字体、同字号把文字在原位叠几层递减的圆头描边，做出"字在薄雾里发光"的底。
     *
     * 字号不另外计算，而是从采样点的包围盒**反推**——采样点就是这批字自己留下的痕迹，
     * 反推出来的字号必然与粒子所在的那批字严格同尺寸，不会因为两处各算一次而错位。
     * 两个系数（行高比、字身比）与 sampleText 里的排版常量同源，改一处必须同时改另一处。
     *
     * 结果**只算一次**：光晕是纯几何、不随时间变化，放进每帧的热循环里描字
     * 会白吃掉十几帧（实测 57FPS → 48FPS）。这里一次性画进离屏画布，之后每帧只 drawImage。
     */
    function buildTextGlow(targets: ShapeTargets, width: number, height: number): HTMLCanvasElement | null {
      if (targets.lines.length === 0) return null
      let minY = Number.POSITIVE_INFINITY
      let maxY = Number.NEGATIVE_INFINITY
      for (const point of targets.points) {
        if (point.shapeBand !== 'text') continue
        if (point.y < minY) minY = point.y
        if (point.y > maxY) maxY = point.y
      }
      if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return null
      const lineCount = targets.lines.length
      // 采样点覆盖的高度 = 行高×(行数-1) + 字身。CJK 在 600 字重下字身约为字号的 1.16 倍。
      const stackRatio = TEXT_OUTLINE_LINE_HEIGHT * (lineCount - 1) + TEXT_OUTLINE_GLYPH_RATIO
      const fontSize = (maxY - minY) / Math.max(0.1, stackRatio)
      if (!Number.isFinite(fontSize) || fontSize < 8) return null

      // 画在一半分辨率上再放大回来：低分辨率天然带柔化，避开硬边（这正是"描边感"的来源）。
      const scale = TEXT_GLOW_RESOLUTION
      const layer = document.createElement('canvas')
      layer.width = Math.max(1, Math.round(width * scale))
      layer.height = Math.max(1, Math.round(height * scale))
      const layerCtx = layer.getContext('2d')
      if (!layerCtx) return null
      layerCtx.scale(scale, scale)
      const lineStep = fontSize * TEXT_OUTLINE_LINE_HEIGHT
      const centerY = height / 2
      const firstLineY = centerY - (lineStep * (lineCount - 1)) / 2
      // 与 sampleText 同一套字体栈：字形必须逐字对齐，否则光晕和粒子会错位。
      layerCtx.font = `600 ${fontSize}px "Manrope", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", "Segoe UI", sans-serif`
      layerCtx.textAlign = 'center'
      layerCtx.textBaseline = 'middle'
      layerCtx.lineJoin = 'round'
      layerCtx.lineCap = 'round'
      // 外层先画、内层后画：越靠里越亮，叠出由外向内收拢的柔和衰减。
      for (const { width: strokeWidth, alpha } of TEXT_GLOW_LAYERS) {
        layerCtx.lineWidth = strokeWidth
        layerCtx.strokeStyle = colorString(TEXT_GLOW_COLOR, alpha)
        for (let index = 0; index < lineCount; index += 1) {
          layerCtx.strokeText(targets.lines[index], width / 2, firstLineY + index * lineStep)
        }
      }
      return layer
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

      // 收束模式的远景节奏：烟花在画布两侧轮换出现，和中央文字保持明确层级。
      if (activeMode === 'closing' && !reducedMotion && seconds >= nextBackgroundFireworkAt) {
        spawnBackgroundFirework(backgroundFireworks, width, height, tier, particles.length)
        nextBackgroundFireworkAt = seconds + 0.9 + Math.random() * 0.7
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
      updateFireworks(backgroundFireworks, delta * motion)

      ctx.clearRect(0, 0, width, height)
      ctx.globalCompositeOperation = 'lighter'

      // 淡描层垫在粒子之下：它是"让字形认得出"的保险，不参与星光效果，所以不能盖在粒子上。
      // 用 source-over 画：叠加混合会让淡描变亮，失去"极淡"的意义。
      const outline = textOutlineRef.current
      if (activeMode === 'closing' && outline) {
        const previousOp = ctx.globalCompositeOperation
        ctx.globalCompositeOperation = 'source-over'
        ctx.drawImage(outline, 0, 0, width, height)
        ctx.globalCompositeOperation = previousOp
      }

      // 全屏星尘是所有样式的底子；流星按间隔生成，任何样式下都会偶尔划过。
      drawAmbientStars(delta * motion, seconds, motion)
      if (!reducedMotion && seconds >= nextStarMeteorAt) {
        const slot = starMeteors.findIndex((meteor) => meteor.age >= meteor.life)
        const target = slot >= 0 ? slot : 0
        starMeteors[target] = createStarMeteor(width, height)
        nextStarMeteorAt = seconds + STAR_METEOR_MIN_GAP + Math.random() * (STAR_METEOR_MAX_GAP - STAR_METEOR_MIN_GAP)
      }
      drawStarMeteors(delta * motion, motion)

      if (activeMode === 'closing') {
        // 许愿层的强度跟收拢进度走：先留出聚拢的注意力，成形之后才把动势加上去。
        const settled = reducedMotion
          ? 1
          : clamp((transition.gatherProgress - WISH_FOCUS_RATIO) / (1 - WISH_FOCUS_RATIO), 0, 1)
        drawWishScene(delta * motion, settled, motion)

        ctx.globalAlpha = 0.68
        drawFireworks(ctx, backgroundFireworks)
        ctx.globalAlpha = 1
      }

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
            // 点径比其它样式更小：文字点不发光晕，字形只靠点阵的排列给出，笔画才不会被粘成一块。
            radiusScale = CLOSING_DOT_SCALE
            if (point.shapeBand === 'ring') {
              twinkleAmplitude = 0.18
              glowStrength = reducedMotion ? 0.16 : 0.2 + Math.cos((seconds / TEXT_BREATH_CYCLE) * Math.PI * 2) * 0.1
              pointScale = textBreath
              const angle = animation.ringRotation * (point.bandFactor ?? 1)
              const cos = Math.cos(angle)
              const sin = Math.sin(angle)
              const rotatedX = offsetX * cos - offsetY * sin
              offsetY = offsetX * sin + offsetY * cos
              offsetX = rotatedX
            } else {
              twinkleAmplitude = 0.16
            }
          }
          if (activeMode === 'pig') {
            // 点径也参与疏密对比：轮廓/五官点更大，浅粉面填充点更小（判定与加权同源，只看亮度）。
            radiusScale =
              1.18 * (PIG_FILL_RADIUS + (PIG_EDGE_RADIUS - PIG_FILL_RADIUS) * pigStructureEmphasis(point.color))
          }
          if (activeMode === 'birthday') {
            radiusScale = 1.08
            // 生日文字里散落几颗会呼吸的高光，让它更像一块正在发亮的祝福牌。
            if (!reducedMotion && particle.slot % 9 === 0) {
              glowStrength = 0.14 + Math.max(0, Math.sin(seconds * 2.6 + particle.phase)) * 0.22
              twinkleAmplitude = 0.34
            }
          }
          const targetX = targets.centerX + offsetX * pointScale + earOffset(point, animation)
          const targetY = targets.centerY + offsetY * pointScale
          if (follow > 0) {
            const jitter = targetJitter(point)
            particle.x += (targetX + jitter.x - particle.x) * follow
            particle.y += (targetY + jitter.y - particle.y) * follow
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
        ctx.fillStyle = colorStringFast(particle.color, clamp(particle.alpha * twinkle * particle.fade, 0.08, 0.95))
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
      clearFireworks(backgroundFireworks)
      fireworksStarted = false
      wavesLaunched = 0
      nextBackgroundFireworkAt = 0

      if (nextMode === 'galaxy') {
        setShapeTargets(null)
        for (const particle of particles) {
          particle.targetColor = [...makeGalaxyTarget(width, height).color]
        }
      } else {
        const targets = createShapeTargets(nextMode, width, height, pigImageRef.current, particles.length, particles.length + 3)
        assignTargets(particles, targets)
        setShapeTargets(targets)
        if (nextMode === 'closing') fireworksStarted = true
      }
      // 取证用：采样点数与粒子数的比值决定字形是"实线"还是"串珠"，出问题时一眼能看出来。
      surface.dataset.sampledPoints = String(shapeTargets?.points.length ?? 0)
      surface.dataset.particleCount = String(particles.length)
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
