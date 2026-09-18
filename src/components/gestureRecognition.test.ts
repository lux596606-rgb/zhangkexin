import { describe, expect, it } from 'vitest'
import {
  CONFIDENCE_THRESHOLD,
  GestureStabilityTracker,
  classifyGesture,
  type DetectedGesture,
  type GestureMode,
  type GestureRecognitionInput,
} from './gestureRecognition'

function category(categoryName: string, score = 0.92, landmarks?: GestureRecognitionInput['landmarks']): GestureRecognitionInput {
  return { gestures: [[{ categoryName, score }]], landmarks }
}

function pinchLandmarks() {
  const points = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.7 }))
  points[0] = { x: 0.5, y: 0.92 }
  points[4] = { x: 0.47, y: 0.26 }
  points[8] = { x: 0.49, y: 0.25 }
  // 捏合要求食指真的"伸直"：MCP/PIP 必须偏离腕-指尖连线。
  // 否则 5-6-8 三点共线会让 PIP 夹角退化成 NaN，伸直判定不成立。
  points[5] = { x: 0.42, y: 0.67 }
  points[6] = { x: 0.43, y: 0.47 }
  points[7] = { x: 0.45, y: 0.36 }

  for (const [mcp, pip, tip, x] of [
    [9, 10, 12, 0.5],
    [13, 14, 16, 0.62],
    [17, 18, 20, 0.73],
  ] as const) {
    points[mcp] = { x, y: 0.67 }
    points[pip] = { x, y: 0.47 }
    points[tip] = { x, y: 0.13 }
  }
  return points
}

const detected = (mode: GestureMode, confidence = 0.9): DetectedGesture => ({ mode, confidence })

describe('classifyGesture', () => {
  it.each([
    ['Open_Palm', 'galaxy'],
    ['Closed_Fist', 'pig'],
    ['Thumb_Up', 'closing'],
  ] as const)('maps %s to %s', (categoryName, mode) => {
    expect(classifyGesture(category(categoryName))).toEqual({ mode, confidence: 0.92 })
  })

  it('maps an explicit pinch with the other three fingers extended to birthday', () => {
    expect(classifyGesture(category('None', 0.9, [pinchLandmarks()]))?.mode).toBe('birthday')
  })

  it('does not let pinch-like fist landmarks override Closed_Fist', () => {
    expect(classifyGesture(category('Closed_Fist', 0.9, [pinchLandmarks()]))?.mode).toBe('pig')
  })

  it('rejects a built-in category below the confidence threshold', () => {
    expect(classifyGesture(category('Open_Palm', CONFIDENCE_THRESHOLD - 0.01))).toBeNull()
  })
})

describe('GestureStabilityTracker', () => {
  it('does not trigger before 700ms', () => {
    const tracker = new GestureStabilityTracker()
    expect(tracker.update(detected('galaxy'), 0).trigger).toBeNull()
    expect(tracker.update(detected('galaxy'), 699).trigger).toBeNull()
    expect(tracker.update(detected('galaxy'), 700).trigger).toBe('galaxy')
  })

  it('triggers only once while the same gesture remains held', () => {
    const tracker = new GestureStabilityTracker()
    tracker.update(detected('pig'), 0)
    expect(tracker.update(detected('pig'), 700).trigger).toBe('pig')
    expect(tracker.update(detected('pig'), 1400).trigger).toBeNull()
    expect(tracker.update(detected('pig'), 3000).trigger).toBeNull()
  })

  it('allows the same gesture again after the release window and a new hold', () => {
    const tracker = new GestureStabilityTracker()
    tracker.update(detected('birthday'), 0)
    tracker.update(detected('birthday'), 700)
    tracker.update(null, 800)
    tracker.update(null, 1050)
    tracker.update(detected('birthday'), 1100)
    expect(tracker.update(detected('birthday'), 1800).trigger).toBe('birthday')
  })

  it('allows a different stable gesture to switch modes', () => {
    const tracker = new GestureStabilityTracker()
    tracker.update(detected('galaxy'), 0)
    tracker.update(detected('galaxy'), 700)
    tracker.update(detected('closing'), 800)
    expect(tracker.update(detected('closing'), 1500).trigger).toBe('closing')
  })

  it('does not accumulate a low-confidence gesture', () => {
    const tracker = new GestureStabilityTracker()
    const weak = detected('pig', CONFIDENCE_THRESHOLD - 0.01)
    tracker.update(weak, 0)
    expect(tracker.update(weak, 1000).trigger).toBeNull()
  })
})
