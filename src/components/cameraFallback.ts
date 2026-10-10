/**
 * 摄像头不可用时的继续方式。
 *
 * 只做一件事：在「摄像头用不了」的时候告诉使用者**现在该怎么继续**，
 * 提示使用者继续往下阅读，或在「怎么玩」中选择星空的其他玩法。
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
  /** 先说明页面可以继续滚动，再说明可选的星空动画切换方式。 */
  steps: readonly string[]
}

/** 提示自动退场时间：看得完、又不长期占用画面。 */
export const CAMERA_FALLBACK_AUTO_HIDE_MS = 14000

/**
 * 五种状态共用的继续方式；手势或按键只改变星空动画，不控制阅读进度。
 */
const CONTINUE_STEPS: readonly string[] = [
  '往下滚动，就能读完这份祝福',
  '点选星空下的按钮，也能换个动画',
  '键盘 1 / 2 / 3 / 4 也只切换星空动画',
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
    body: '祝福都在这一页。想再试一次，在「怎么玩」里点「试试手势」。',
    steps: CONTINUE_STEPS,
  },
  unavailable: {
    status: 'unavailable',
    title: '暂时没有找到摄像头',
    body: '可以直接往下读。连接摄像头后，在「怎么玩」里点「试试手势」。',
    steps: CONTINUE_STEPS,
  },
  unsupported: {
    status: 'unsupported',
    title: '这个浏览器暂时不能用手势',
    body: '直接往下读就能看完整份祝福，星空动画也能用按钮或键盘切换。',
    steps: CONTINUE_STEPS,
  },
  error: {
    status: 'error',
    title: '摄像头暂时没能打开',
    body: '直接往下读就好；想再试一次，在「怎么玩」里点「试试手势」。',
    steps: CONTINUE_STEPS,
  },
  closed: {
    status: 'closed',
    title: '摄像头已关闭',
    body: '祝福还在这里。想再用手势，在「怎么玩」里点「试试手势」。',
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
