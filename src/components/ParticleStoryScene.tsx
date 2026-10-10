import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { GestureMode } from './gestureRecognition'
import { ParticleCanvas } from './ParticleCanvas'
import { SketchDecor } from './SketchDecor'
import { SKETCH_SIDES } from './sketchMotifs'

const sceneLabels: Record<GestureMode, string> = {
  galaxy: '星光动画',
  birthday: '生日快乐动画',
  pig: '小猪动画',
  closing: '祝愿动画',
}

type DragPoint = { pointerId: number; x: number; y: number }

export function ParticleStoryScene({
  mode,
  paused = false,
  allowFireworks = true,
  className,
}: {
  mode: GestureMode
  paused?: boolean
  allowFireworks?: boolean
  className?: string
}) {
  const stageRef = useRef<HTMLDivElement>(null)
  const dragPointRef = useRef<DragPoint | null>(null)
  const [nearViewport, setNearViewport] = useState(() => typeof IntersectionObserver === 'undefined')
  const [galaxyFlow, setGalaxyFlow] = useState({ x: 0, y: 0 })

  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return

    if (typeof IntersectionObserver === 'undefined') return

    // Mount a scene already on screen before its first paint; the observer keeps
    // the expensive canvas unmounted while the reader is elsewhere in the story.
    const bounds = stage.getBoundingClientRect()
    // oxlint-disable-next-line react/set-state-in-effect -- measure the canvas host before first paint
    setNearViewport(bounds.bottom >= -100 && bounds.top <= window.innerHeight + 100)

    const observer = new IntersectionObserver(
      ([entry]) => setNearViewport(entry.isIntersecting),
      { rootMargin: '100px 0px', threshold: 0.05 },
    )
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch' || dragPointRef.current) return
    dragPointRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const dragPoint = dragPointRef.current
    if (!dragPoint || dragPoint.pointerId !== event.pointerId || event.pointerType === 'touch') return
    const dx = event.clientX - dragPoint.x
    const dy = event.clientY - dragPoint.y
    dragPointRef.current = { pointerId: dragPoint.pointerId, x: event.clientX, y: event.clientY }
    setGalaxyFlow((flow) => ({
      x: Math.max(-240, Math.min(240, flow.x + dx * 1.4)),
      y: Math.max(-240, Math.min(240, flow.y + dy * 1.4)),
    }))
  }

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragPointRef.current?.pointerId !== event.pointerId) return
    dragPointRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const isGalaxy = mode === 'galaxy'
  return (
    <div
      ref={stageRef}
      className={`story-stage story-stage--${mode}${className ? ` ${className}` : ''}`}
      role="img"
      aria-label={sceneLabels[mode]}
      onPointerDown={isGalaxy ? handlePointerDown : undefined}
      onPointerMove={isGalaxy ? handlePointerMove : undefined}
      onPointerUp={isGalaxy ? handlePointerEnd : undefined}
      onPointerCancel={isGalaxy ? handlePointerEnd : undefined}
      onLostPointerCapture={isGalaxy ? handlePointerEnd : undefined}
    >
      <div className="stage-halo" aria-hidden="true" />
      <SketchDecor side="left" motif={SKETCH_SIDES[mode].left} />
      <SketchDecor side="right" motif={SKETCH_SIDES[mode].right} />
      {nearViewport && <ParticleCanvas mode={mode} paused={paused} flow={galaxyFlow} allowFireworks={allowFireworks} />}
    </div>
  )
}
