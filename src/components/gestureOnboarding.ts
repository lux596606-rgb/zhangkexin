import { HOLD_MS, type GestureMode } from './gestureRecognition'

/** 四种固定手势的图示 id，对应 GestureGuide 里手绘的极简线稿。 */
export type HandGestureId = 'openPalm' | 'pinch' | 'fist' | 'thumbUp'

export type GestureGuideItem = {
  id: HandGestureId
  /** 手势的中文名。 */
  gesture: string
  /** 这个手势（或同编号按键）切换到的样式。 */
  mode: GestureMode
  /** 与手势等价、可独立切换同一样式的键盘按键。 */
  key: string
  /** 样式展示名，沿用体验页的措辞，避免两处叫法不一致。 */
  modeLabel: string
}

/**
 * 需求 3.2 固定的四条映射：张开手掌=银河态、拇食指捏合=生日快乐、握拳=猪头卡通、竖拇指=祝福收束。
 * 这是落地页引导的唯一数据源：改这里就等于同时改了图示、文案和按键提示。
 * modeLabel 必须与体验页四个样式名逐字一致，全站不出现第二个叫法。
 */
export const GESTURE_GUIDE: readonly GestureGuideItem[] = [
  { id: 'openPalm', gesture: '张开手掌', mode: 'galaxy', key: '1', modeLabel: '银河态' },
  { id: 'pinch', gesture: '拇指食指捏合', mode: 'birthday', key: '2', modeLabel: '生日快乐' },
  { id: 'fist', gesture: '握拳', mode: 'pig', key: '3', modeLabel: '猪头卡通' },
  { id: 'thumbUp', gesture: '竖起大拇指', mode: 'closing', key: '4', modeLabel: '祝福收束' },
]

/** 保持时长直接由手势识别的 HOLD_MS 推导，说明文案不会和真实阈值各说各话。 */
export const HOLD_SECONDS = (HOLD_MS / 1000).toFixed(1)

/** 一行标题：既说清手势数量，也说清「保持一下才切换」。 */
export const GESTURE_GUIDE_TITLE = `四种手势 · 保持约 ${HOLD_SECONDS} 秒就会切换`

/** 需求 6 的入口说明：没有摄像头也能看完整个祝福，键盘和鼠标是并行的第二套控制方式。 */
export const GESTURE_GUIDE_FALLBACK_NOTE =
  '没有摄像头也能看完整段祝福：键盘 1 / 2 / 3 / 4，或点选下方的四个星光入口，效果一样。'
