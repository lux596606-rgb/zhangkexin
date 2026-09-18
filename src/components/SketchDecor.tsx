import { BIRTHDAY_AGE, HEART_PATH, type SketchMotif } from './sketchMotifs'

/**
 * 简笔画装饰层（SVG）。
 *
 * 需求里"蛋糕 / 19 岁数字 / 爱心"明确要求是**简笔画**而不是粒子：
 * 粒子的职责是拼出形状（银河、文字、猪头），这些是"贴上去的小画"，
 * 用 SVG 画才有干净的线稿边缘，而且不占粒子预算、不影响帧率。
 *
 * 关键约束：装饰是**配角**。它们只占舞台两侧的空档，绝不压住中央的粒子主体——
 * 因此位置全部用百分比钉在两侧，主体（文字/猪头）落在中间约 60% 的宽度里，两者不会打架。
 */
export function SketchDecor({ side, motif }: { side: 'left' | 'right'; motif: SketchMotif }) {
  if (motif === 'cake') return <CakeDecor side={side} />
  if (motif === 'hearts') return <HeartDecor side={side} />
  return null
}

/**
 * 生日蛋糕：两层奶油 + 数字蜡烛「19」。
 * 年龄是可变业务事实（2007 年出生 → 2026.10.11 满 19 周岁），
 * 所以数字是这层唯一的变量，改 `BIRTHDAY_AGE` 一个常量就能换一年。
 */
function CakeDecor({ side }: { side: 'left' | 'right' }) {
  return (
    <svg
      className={`sketch-decor sketch-decor--cake sketch-decor--${side}`}
      viewBox="0 0 200 214"
      role="img"
      aria-label={`简笔画生日蛋糕，插着数字蜡烛 ${BIRTHDAY_AGE}`}
    >
      {/* 盘子 */}
      <path className="sketch-line sketch-line--soft" d="M20 188c0-6 36-9 80-9s80 3 80 9-36 9-80 9-80-3-80-9Z" />

      {/* 下层蛋糕体 + 顶沿奶油滴落 */}
      <path className="sketch-line" d="M42 186v-28c0-8 26-13 58-13s58 5 58 13v28" />
      <path
        className="sketch-line"
        d="M44 160c4 7 9 7 13 0 4 7 9 7 13 0 4 7 9 7 13 0 4 7 9 7 13 0 4 7 9 7 13 0 4 7 9 7 13 0 4 7 9 7 12 0"
      />

      {/* 上层蛋糕体 + 顶沿奶油滴落 */}
      <path className="sketch-line" d="M58 148v-24c0-7 19-11 43-11s43 4 43 11v24" />
      <path
        className="sketch-line"
        d="M60 126c3 6 8 6 11 0 3 6 8 6 11 0 3 6 8 6 11 0 3 6 8 6 11 0 3 6 8 6 11 0 3 6 8 6 11 0 3 6 7 6 10 0"
      />

      {/* 数字蜡烛「19」：火苗 + 烛身 + 数字，这是"19 岁"的落点 */}
      {(['1', '9'] as const).map((digit, index) => {
        const x = index === 0 ? 84 : 118
        return (
          <g key={digit}>
            <path className="sketch-flame" d={`M${x} 72c7-6 7-14 0-19-7 5-7 13 0 19Z`} />
            <path className="sketch-flame sketch-flame--core" d={`M${x} 69c3-3 3-8 0-11-3 3-3 8 0 11Z`} />
            <rect className="sketch-line" x={x - 7} y="78" width="14" height="24" rx="3" />
            <text className="sketch-digit" x={x} y="97">{digit}</text>
          </g>
        )
      })}

      {/* 几颗点缀的星，和全屏星尘呼应 */}
      <path className="sketch-spark" d="M26 122l2 6 6 2-6 2-2 6-2-6-6-2 6-2Z" />
      <path className="sketch-spark" d="M176 94l1.6 4.8 4.8 1.6-4.8 1.6-1.6 4.8-1.6-4.8-4.8-1.6 4.8-1.6Z" />
      <path className="sketch-spark" d="M164 174l1.4 4.2 4.2 1.4-4.2 1.4-1.4 4.2-1.4-4.2-4.2-1.4 4.2-1.4Z" />
    </svg>
  )
}

/**
 * 爱心簇。
 *
 * 第一版只放了三个"空心 + 平涂"的爱心，问题有两个：
 * ① 太素——和平涂色块没区别，跟满屏星光的质感不在一个层级；
 * ② 太孤——三个孤立的心飘在空处，和页面的星尘/暖光没有任何联系，所以显得突兀。
 *
 * 现在改成**一簇**：大小拉开差距、带渐变与高光、再撒一圈光点和小星把爱心和星尘缝在一起。
 * 渐变用 `<defs>` 里的 id，同一个页面可能同时挂左右两个爱心层，
 * 所以 id 必须带上 side 前缀，否则两边的滤镜会互相覆盖。
 */
function HeartDecor({ side }: { side: 'left' | 'right' }) {
  const uid = `heart-${side}`
  return (
    <svg
      className={`sketch-decor sketch-decor--hearts sketch-decor--${side}`}
      viewBox="0 0 78 210"
      role="img"
      aria-label="粒子文字旁的手绘爱心与光点"
    >
      <defs>
        {/* 从暖粉到珊瑚粉：和平涂相比，有了上亮下深的体积感 */}
        <linearGradient id={`${uid}-fill`} x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0%" stopColor="#ff9d9d" stopOpacity="0.72" />
          <stop offset="55%" stopColor="#ff7f8f" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#e8607a" stopOpacity="0.36" />
        </linearGradient>
        <linearGradient id={`${uid}-dim`} x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0%" stopColor="#ffb3ae" stopOpacity="0.48" />
          <stop offset="100%" stopColor="#ff8f9c" stopOpacity="0.26" />
        </linearGradient>
      </defs>

      {/* 主心：最大一颗，带高光 */}
      <g className="heart-beat heart-beat--main">
        <path className="sketch-heart" d={HEART_PATH} fill={`url(#${uid}-fill)`} />
        <path className="sketch-heart-shine" d="M11 8c2.6-2.6 6.4-2.4 8 0.4-1.8-1.4-4.4-1.2-6 0.6Z" />
      </g>

      {/* 次心：大小与角度都错开，避免"复制粘贴"的观感 */}
      <g className="heart-beat heart-beat--b">
        <path className="sketch-heart sketch-heart--thin" d={HEART_PATH} fill={`url(#${uid}-dim)`} transform="translate(40 4) scale(0.62) rotate(18 18 16)" />
      </g>
      <g className="heart-beat heart-beat--c">
        <path className="sketch-heart sketch-heart--thin" d={HEART_PATH} fill={`url(#${uid}-dim)`} transform="translate(36 116) scale(0.48) rotate(-20 18 16)" />
      </g>
      <g className="heart-beat heart-beat--b">
        <path className="sketch-heart sketch-heart--thin" d={HEART_PATH} fill={`url(#${uid}-dim)`} transform="translate(2 146) scale(0.78) rotate(9 18 16)" />
      </g>
      <g className="heart-beat heart-beat--c">
        <path className="sketch-heart sketch-heart--thin" d={HEART_PATH} fill={`url(#${uid}-dim)`} transform="translate(46 168) scale(0.4) rotate(-8 18 16)" />
      </g>

      {/* 光点与小星：把爱心和满屏星尘缝在一起，这是"不突兀"的关键 */}
      <circle className="sketch-dot sketch-dot--a" cx="62" cy="34" r="1.5" />
      <circle className="sketch-dot sketch-dot--b" cx="8" cy="66" r="1.2" />
      <circle className="sketch-dot sketch-dot--c" cx="58" cy="96" r="1.8" />
      <circle className="sketch-dot sketch-dot--a" cx="20" cy="112" r="1.1" />
      <circle className="sketch-dot sketch-dot--b" cx="66" cy="140" r="1.4" />
      <circle className="sketch-dot sketch-dot--c" cx="14" cy="186" r="1.3" />
      <path className="sketch-spark sketch-spark--a" d="M70 62l1.5 4.5 4.5 1.5-4.5 1.5-1.5 4.5-1.5-4.5-4.5-1.5 4.5-1.5Z" />
      <path className="sketch-spark sketch-spark--b" d="M6 26l1.2 3.6 3.6 1.2-3.6 1.2-1.2 3.6-1.2-3.6-3.6-1.2 3.6-1.2Z" />
      <path className="sketch-spark sketch-spark--c" d="M44 196l1.3 3.9 3.9 1.3-3.9 1.3-1.3 3.9-1.3-3.9-3.9-1.3 3.9-1.3Z" />
    </svg>
  )
}
