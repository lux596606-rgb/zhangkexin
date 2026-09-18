/**
 * 摄像头降级路径的文案（需求 3.1 / 6 / 8）。
 *
 * 只做一件事：在「摄像头用不了」的时候告诉使用者**现在该怎么继续**，
 * 措辞保持温和 —— 这是送给一位腼腆女孩的生日页面，不出现「授权失败」这类生硬说法。
 * 标题要与 App 顶部状态行的说法错开，不要读成同义重复；正文只讲「接下来怎么玩」。
 * 摄像头状态机本身仍然由 App 掌握，这里只消费状态、给出下一步。
 */

export type CameraStatus =
  | 'idle'
  | 'requesting'
  | 'enabled'
  | 'denied'
  | 'unavailable'
  | 'unsupported'
  | 'error'
  | 'closed'

/** 需要给出降级提示的状态；`idle / requesting / enabled` 都不需要。 */
export type DegradedCameraStatus = 'denied' | 'unavailable' | 'unsupported' | 'error' | 'closed'

export type CameraFallbackCopy = {
  status: DegradedCameraStatus
  title: string
  body: string
  /** 明确的可操作步骤：键盘 1 / 2 / 3 / 4 或点选四个样式入口。 */
  steps: readonly string[]
}

/** 提示自动退场时间：看得完、又不长期占用画面。 */
export const CAMERA_FALLBACK_AUTO_HIDE_MS = 14000

/**
 * 五种降级状态共用的「接着怎么玩」：只讲下一步，不解释技术原因。
 * 「星光入口」是页面上对四个样式入口的统一叫法，和落地页引导、模式导航用同一个词。
 */
const CONTINUE_STEPS: readonly string[] = [
  '键盘 1 / 2 / 3 / 4 切换四种画面',
  '或点选最下面的四个星光入口',
  '四种画面都能反复看，不用按顺序',
]

const DEGRADED_STATUSES: readonly DegradedCameraStatus[] = [
  'denied',
  'unavailable',
  'unsupported',
  'error',
  'closed',
]

const FALLBACKS: Record<DegradedCameraStatus, CameraFallbackCopy> = {
  denied: {
    status: 'denied',
    title: '不开摄像头也能看',
    body: '这次没有打开摄像头也没关系，祝福一样是完整的。',
    steps: CONTINUE_STEPS,
  },
  unavailable: {
    status: 'unavailable',
    title: '这台电脑没有找到摄像头',
    body: '用键盘和鼠标接着看就好，祝福一样是完整的。',
    steps: CONTINUE_STEPS,
  },
  unsupported: {
    status: 'unsupported',
    title: '这个浏览器先不带摄像头玩',
    body: '不用装任何东西，键盘和鼠标就能走完整个祝福。',
    steps: CONTINUE_STEPS,
  },
  error: {
    status: 'error',
    title: '摄像头暂时没能打开',
    body: '可能被别的程序占用了。刷新页面再点一次「开启星光」就能重试。',
    steps: CONTINUE_STEPS,
  },
  closed: {
    status: 'closed',
    title: '摄像头先收起来了',
    body: '星图还在，随时可以接着看；想再用摄像头，刷新页面重新开启就好。',
    steps: CONTINUE_STEPS,
  },
}

export function isDegradedCameraStatus(status: CameraStatus): status is DegradedCameraStatus {
  return DEGRADED_STATUSES.some((item) => item === status)
}

/** 摄像头状态 → 降级提示；不需要提示的状态返回 null。 */
export function cameraFallbackFor(status: CameraStatus): CameraFallbackCopy | null {
  return isDegradedCameraStatus(status) ? FALLBACKS[status] : null
}
