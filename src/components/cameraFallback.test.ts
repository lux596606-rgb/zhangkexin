import { describe, expect, it } from 'vitest'
import {
  CAMERA_FALLBACK_AUTO_HIDE_MS,
  cameraFallbackFor,
  isDegradedCameraStatus,
  type CameraStatus,
} from './cameraFallback'

const DEGRADED_STATUSES: CameraStatus[] = ['denied', 'unavailable', 'unsupported', 'error', 'closed']
const HEALTHY_STATUSES: CameraStatus[] = ['idle', 'requesting', 'enabled']

describe('摄像头不可用时的继续方式', () => {
  it('五种不可用状态都有提示，且回填的 status 与查询一致', () => {
    for (const status of DEGRADED_STATUSES) {
      const copy = cameraFallbackFor(status)
      expect(copy, status).not.toBeNull()
      expect(copy?.status).toBe(status)
      expect(copy?.title.trim().length).toBeGreaterThan(0)
      expect(copy?.body.trim().length).toBeGreaterThan(0)
    }
  })

  it('idle / requesting / enabled 不给降级提示', () => {
    for (const status of HEALTHY_STATUSES) {
      expect(cameraFallbackFor(status), status).toBeNull()
    }
  })

  it('每条提示都先指向滚动阅读，再说明可选的星空玩法', () => {
    for (const status of DEGRADED_STATUSES) {
      const copy = cameraFallbackFor(status)
      expect(copy?.steps.length, status).toBeGreaterThanOrEqual(3)
      expect(copy?.steps[0], status).toContain('往下滚动')
      const steps = copy?.steps.join(' ') ?? ''
      expect(steps, status).toContain('星空下的按钮')
      expect(steps, status).toContain('点选')
      expect(steps, status).toContain('键盘 1 / 2 / 3 / 4')
      expect(steps, status).toContain('只切换星空动画')
    }
  })

  it('关闭或未能打开摄像头时，可以从帮助面板直接重试', () => {
    for (const status of ['denied', 'unavailable', 'error', 'closed'] as const) {
      const body = cameraFallbackFor(status)?.body ?? ''
      expect(body, status).toContain('「怎么玩」')
      expect(body, status).toContain('「试试手势」')
    }
  })

  it('不指向旧的换幕按钮、跳幕入口或刷新页面', () => {
    for (const status of DEGRADED_STATUSES) {
      const item = cameraFallbackFor(status)
      const copy = [item?.title, item?.body, ...(item?.steps ?? [])].join('')
      for (const outdated of ['刷新', '接着看', '切换画面', '开启星光', '星光入口', '最下面', '不用按顺序']) {
        expect(copy, status).not.toContain(outdated)
      }
    }
  })

  it('五种状态的标题各不相同（不是一句通用话术）', () => {
    const titles = DEGRADED_STATUSES.map((status) => cameraFallbackFor(status)?.title)
    expect(new Set(titles).size).toBe(DEGRADED_STATUSES.length)
  })

  it('文案温和：不出现失败 / 授权 / 拒绝 / 错误 / 抱歉一类生硬措辞', () => {
    const copy = DEGRADED_STATUSES.map((status) => {
      const item = cameraFallbackFor(status)
      return [item?.title, item?.body, ...(item?.steps ?? [])].join('')
    }).join('')
    for (const word of ['失败', '授权', '拒绝', '错误', '抱歉']) {
      expect(copy).not.toContain(word)
    }
  })

  it('自动退场时间在 10~20 秒之间：看得完，又不长期占用画面', () => {
    expect(CAMERA_FALLBACK_AUTO_HIDE_MS).toBeGreaterThanOrEqual(10000)
    expect(CAMERA_FALLBACK_AUTO_HIDE_MS).toBeLessThanOrEqual(20000)
  })

  it('类型守卫口径与 cameraFallbackFor 完全一致', () => {
    for (const status of [...DEGRADED_STATUSES, ...HEALTHY_STATUSES]) {
      expect(isDegradedCameraStatus(status), status).toBe(cameraFallbackFor(status) !== null)
    }
  })
})
