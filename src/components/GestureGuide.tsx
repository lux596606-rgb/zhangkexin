import { Hand } from 'lucide-react'
import {
  GESTURE_GUIDE,
  GESTURE_GUIDE_FALLBACK_NOTE,
  GESTURE_GUIDE_TITLE,
  type HandGestureId,
} from './gestureOnboarding'

/**
 * 四种手势的极简线稿：只画「手指姿态」这一个信息，够认出是哪种手势即可。
 * 全部手写在 SVG 里（不引图形库、不用外部图片），描边跟随 currentColor，
 * 因此配色完全复用页面现有的暖白 / 珊瑚粉。
 */
function HandGlyph({ id }: { id: HandGestureId }) {
  const common = {
    viewBox: '0 0 32 32',
    width: 30,
    height: 30,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }

  if (id === 'openPalm') {
    // 五指张开：掌根 + 四根伸直的手指 + 外侧拇指。
    return (
      <svg {...common}>
        <rect x="9.6" y="18" width="13.2" height="8.8" rx="4.2" />
        <path d="M12.4 18V8.8M15.7 18V7.2M19 18V8.4M22 18v-5.4" />
        <path d="M10.4 22.8 6.6 18.4" />
      </svg>
    )
  }

  if (id === 'pinch') {
    // 捏合：指尖相接的小圈 + 拇指与食指的两道连线 + 折在掌心的其余手指。
    return (
      <svg {...common}>
        <circle cx="14.6" cy="10.6" r="2.9" />
        <path d="M12.5 12.8c-1.5 2.2-1.5 4.6.2 6.2" />
        <path d="M17.1 12c1.9 1.9 2.6 4.4 2.1 7" />
        <rect x="11.6" y="18.6" width="10.2" height="7.6" rx="3.6" />
        <path d="M13.5 21.4h6.3M14.1 23.6h5.1" />
      </svg>
    )
  }

  if (id === 'fist') {
    // 握拳：闭合的拳头 + 指节折线 + 压住的拇指。
    return (
      <svg {...common}>
        <rect x="10" y="11.6" width="13.4" height="14" rx="5.4" />
        <path d="M13.3 12.2v2.6M16.7 11.8v2.8M20.1 12.2v2.6" />
        <path d="M10.4 18.6h4.4M10.9 21.4h3.8" />
      </svg>
    )
  }

  // 竖大拇指：拳头 + 向上伸出的拇指 + 折起的手指。
  return (
    <svg {...common}>
      <rect x="10.4" y="14.6" width="13.2" height="11.4" rx="4.8" />
      <path d="M13.6 14.6V9.8a2.6 2.6 0 0 1 5.2 0v4.8" />
      <path d="M14.6 18.8h6.4M15 21.6h5.8" />
    </svg>
  )
}

/**
 * 落地页的四种手势说明（需求 3.2 / 8）：一行极简图示 + 一行补充。
 *
 * 刻意不做成教程弹窗或分步向导：它排在「开启星光」和隐私说明**之后**，
 * 属于落地页的自然延伸，既不会挡住主按钮，也不打断原来的呼吸感。
 * 进入体验页后不再重复 —— 那里已经有手势反馈条和键盘提示。
 */
export function GestureGuide() {
  return (
    <section className="landing-guide" aria-labelledby="landing-guide-title">
      <div className="landing-guide__head">
        <p className="landing-guide__heading" id="landing-guide-title">
          <Hand size={15} aria-hidden="true" />
          {GESTURE_GUIDE_TITLE}
        </p>
        <p className="landing-guide__note">{GESTURE_GUIDE_FALLBACK_NOTE}</p>
      </div>
      <ul className="landing-guide__list">
        {GESTURE_GUIDE.map((item) => (
          <li className="landing-guide__item" key={item.id}>
            <span className="landing-guide__icon">
              <HandGlyph id={item.id} />
            </span>
            <span className="landing-guide__gesture">{item.gesture}</span>
            <span className="landing-guide__target">
              <kbd>{item.key}</kbd>
              {item.modeLabel}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
