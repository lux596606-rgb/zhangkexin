import { HOLD_MS, type GestureMode } from './gestureRecognition'

/** 四种固定手势的图示 id，对应 GestureGuide 里手绘的极简线稿。 */
export type HandGestureId = 'openPalm' | 'pinch' | 'fist' | 'thumbUp'

export type GestureGuideItem = {
  id: HandGestureId
  /** 手势的中文名。 */
  gesture: string
  /** 这个手势（或同编号按键）切换到的星空动画样式。 */
  mode: GestureMode
  /** 与手势等价、可独立切换同一样式的键盘按键。 */
  key: string
  /** 星空动画的展示名，与星空互动区的按钮保持一致。 */
  modeLabel: string
}

/**
 * 四条固定映射：张开手掌=星光、拇食指捏合=生日快乐、握拳=小彩蛋、竖拇指=许个愿。
 * 这是「怎么玩」面板中手势说明的数据源：改这里会同时更新图示、文案和按键提示。
 * modeLabel 必须与星空互动区四个动画样式名逐字一致，全站不出现第二个叫法。
 */
export const GESTURE_GUIDE: readonly GestureGuideItem[] = [
  { id: 'openPalm', gesture: '张开手掌', mode: 'galaxy', key: '1', modeLabel: '星光' },
  { id: 'pinch', gesture: '拇指食指捏合', mode: 'birthday', key: '2', modeLabel: '生日快乐' },
  { id: 'fist', gesture: '握拳', mode: 'pig', key: '3', modeLabel: '小彩蛋' },
  { id: 'thumbUp', gesture: '竖起大拇指', mode: 'closing', key: '4', modeLabel: '许个愿' },
]

/** 保持时长直接由手势识别的 HOLD_MS 推导，说明文案不会和真实阈值各说各话。 */
export const HOLD_SECONDS = (HOLD_MS / 1000).toFixed(1)

/** 一行标题：既说清手势数量，也说清「保持一下才切换星空动画」。 */
export const GESTURE_GUIDE_TITLE = `四种手势 · 保持约 ${HOLD_SECONDS} 秒切换星空动画`

/** 手势只是星空里的可选玩法；主线靠滚动阅读，不受手势切换影响。 */
export const GESTURE_GUIDE_FALLBACK_NOTE =
  '没有摄像头也能往下读完整份祝福。想换个星空动画，可以点选这片星空下的按钮，或按键盘 1 / 2 / 3 / 4；这些操作只改变星空，不会跳到别处。'
