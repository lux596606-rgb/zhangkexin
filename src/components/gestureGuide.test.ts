import { describe, expect, it } from 'vitest'
import {
  GESTURE_GUIDE,
  GESTURE_GUIDE_FALLBACK_NOTE,
  GESTURE_GUIDE_TITLE,
  HOLD_SECONDS,
} from './gestureOnboarding'
import { HOLD_MS } from './gestureRecognition'

describe('「怎么玩」中的手势说明', () => {
  it('四种手势与四种星空动画、按键、显示名称一一对应', () => {
    expect(GESTURE_GUIDE.map((item) => [item.id, item.mode, item.key, item.modeLabel])).toEqual([
      ['openPalm', 'galaxy', '1', '星光'],
      ['pinch', 'birthday', '2', '生日快乐'],
      ['fist', 'pig', '3', '小彩蛋'],
      ['thumbUp', 'closing', '4', '许个愿'],
    ])
  })

  it('覆盖需求里的四个动画样式，没有遗漏也没有重复', () => {
    const modes = GESTURE_GUIDE.map((item) => item.mode)
    expect(modes).toHaveLength(4)
    expect(new Set(modes).size).toBe(4)
    expect([...modes].sort()).toEqual(['birthday', 'closing', 'galaxy', 'pig'])
    expect(new Set(GESTURE_GUIDE.map((item) => item.id)).size).toBe(4)
  })

  it('保持时长由 HOLD_MS 推导，说明文案不会和识别阈值各说各话', () => {
    expect(HOLD_MS).toBe(700)
    expect(HOLD_SECONDS).toBe('0.7')
    expect(GESTURE_GUIDE_TITLE).toContain('0.7 秒')
    expect(GESTURE_GUIDE_TITLE).toContain('保持')
  })

  it('主线滚动阅读不需要摄像头，按键只改变星空动画', () => {
    expect(GESTURE_GUIDE_FALLBACK_NOTE).toContain('没有摄像头')
    expect(GESTURE_GUIDE_FALLBACK_NOTE).toContain('往下读')
    expect(GESTURE_GUIDE_FALLBACK_NOTE).toContain('星空下的按钮')
    expect(GESTURE_GUIDE_FALLBACK_NOTE).toContain('点选')
    expect(GESTURE_GUIDE_FALLBACK_NOTE).toContain('键盘 1 / 2 / 3 / 4')
    expect(GESTURE_GUIDE_FALLBACK_NOTE).toContain('只改变星空')
    expect(GESTURE_GUIDE_FALLBACK_NOTE).not.toContain('「接着看」')
    expect(GESTURE_GUIDE_FALLBACK_NOTE).not.toContain('星光入口')
    expect(GESTURE_GUIDE_FALLBACK_NOTE).not.toContain('下方')
  })

  it('每一项都有中文手势名与样式名（图示之外仍有文字兜底）', () => {
    for (const item of GESTURE_GUIDE) {
      expect(item.gesture.trim().length).toBeGreaterThan(0)
      expect(item.modeLabel.trim().length).toBeGreaterThan(0)
    }
  })

  it('文案保持温和：不出现失败 / 授权 / 拒绝 / 错误一类生硬措辞', () => {
    const copy = [
      GESTURE_GUIDE_TITLE,
      GESTURE_GUIDE_FALLBACK_NOTE,
      ...GESTURE_GUIDE.flatMap((item) => [item.gesture, item.modeLabel]),
    ].join('')
    for (const word of ['失败', '授权', '拒绝', '错误', '抱歉']) {
      expect(copy).not.toContain(word)
    }
  })
})
