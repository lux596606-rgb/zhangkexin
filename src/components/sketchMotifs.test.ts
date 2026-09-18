import { describe, expect, it } from 'vitest'
import { BIRTHDAY_AGE, HEART_PATH, SKETCH_SIDES, type SketchMotif } from './sketchMotifs'
import { GESTURE_GUIDE } from './gestureOnboarding'

const ALL_MODES = ['galaxy', 'birthday', 'pig', 'closing'] as const
const ALL_MOTIFS: SketchMotif[] = ['none', 'cake', 'hearts']

describe('简笔画装饰的样式映射', () => {
  it('四个样式都有映射，且主题值合法', () => {
    expect(Object.keys(SKETCH_SIDES).sort()).toEqual([...ALL_MODES].sort())
    for (const mode of ALL_MODES) {
      expect(ALL_MOTIFS).toContain(SKETCH_SIDES[mode].left)
      expect(ALL_MOTIFS).toContain(SKETCH_SIDES[mode].right)
    }
  })

  it('画面 2「生日快乐」左蛋糕右爱心', () => {
    expect(SKETCH_SIDES.birthday).toEqual({ left: 'cake', right: 'hearts' })
  })

  it('画面 4 只在右侧加爱心，不挤占已经占满宽度的文字', () => {
    expect(SKETCH_SIDES.closing).toEqual({ left: 'none', right: 'hearts' })
  })

  it('银河态与猪头不加装饰（它们是"纯粒子"的两个画面）', () => {
    expect(SKETCH_SIDES.galaxy).toEqual({ left: 'none', right: 'none' })
    expect(SKETCH_SIDES.pig).toEqual({ left: 'none', right: 'none' })
  })

  it('装饰映射覆盖的样式名与手势引导里的样式完全一致', () => {
    // 两处各写一份样式名时最容易出的错：这里新增一个样式、那里忘了加。
    const guided = [...new Set(GESTURE_GUIDE.map((item) => item.mode))].sort()
    expect(Object.keys(SKETCH_SIDES).sort()).toEqual(guided)
  })
})

describe('蛋糕上的年龄', () => {
  it('是 19（2007 年出生 → 2026.10.11 满 19 周岁）', () => {
    expect(BIRTHDAY_AGE).toBe(19)
  })

  it('是可直接渲染的正整数', () => {
    expect(Number.isInteger(BIRTHDAY_AGE)).toBe(true)
    expect(BIRTHDAY_AGE).toBeGreaterThan(0)
  })
})

describe('爱心路径', () => {
  it('是一条闭合路径', () => {
    expect(HEART_PATH.endsWith('Z')).toBe(true)
    expect(HEART_PATH.startsWith('M')).toBe(true)
  })

  it('从数据上就是"尖角朝下"的爱心，不会画成倒过来的', () => {
    // 取路径里所有坐标点，心口/尖端应当落在下方：最大 y 明显大于两瓣的顶部 y。
    const numbers = HEART_PATH.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? []
    expect(numbers.length).toBeGreaterThan(8)
    const xs = numbers.filter((_, index) => index % 2 === 0)
    const ys = numbers.filter((_, index) => index % 2 === 1)
    const top = Math.min(...ys)
    const bottom = Math.max(...ys)
    // 尖端（最大 y）与顶部之间要有足够高度，且尖端在水平中间附近。
    expect(bottom - top).toBeGreaterThan(20)
    const bottomPointXs = numbers.filter((_, index) => index % 2 === 0 && numbers[index + 1] === bottom)
    const centerX = (Math.min(...xs) + Math.max(...xs)) / 2
    for (const x of bottomPointXs) expect(Math.abs(x - centerX)).toBeLessThan(2)
  })
})
