import { useEffect, useRef } from 'react'
import { CAMERA_FALLBACK_AUTO_HIDE_MS, type CameraFallbackCopy } from './cameraFallback'

type CameraFallbackNoticeProps = {
  copy: CameraFallbackCopy
  /** 收起（点「知道了」或自动退场）时通知 App。 */
  onDismiss: () => void
}

/**
 * 摄像头不可用时的降级提示（需求 3.1 / 6 / 8）。
 *
 * 位置与手势反馈条同一个角落 —— 摄像头没开启时反馈条本来就不渲染，二者互斥，
 * 所以既不会叠加，也不会压住居中的粒子主体。可以点「知道了」收起，
 * 也会在 14 秒后自动退场，不长期占用画面；顶部状态行仍然保留原因。
 */
export function CameraFallbackNotice({ copy, onDismiss }: CameraFallbackNoticeProps) {
  const dismissRef = useRef(onDismiss)

  useEffect(() => {
    dismissRef.current = onDismiss
  }, [onDismiss])

  // 计时只跟状态种类绑定：父组件因为帧率/画质刷新而重渲染时，倒计时不会被反复重置。
  useEffect(() => {
    const timer = window.setTimeout(() => dismissRef.current(), CAMERA_FALLBACK_AUTO_HIDE_MS)
    return () => window.clearTimeout(timer)
  }, [copy.status])

  return (
    <aside
      className={`camera-fallback camera-fallback--${copy.status}`}
      aria-label={`摄像头提示：${copy.title}`}
      // 提示条自己处理指针事件，不让舞台的银河拖拽/滚轮抢走点击。
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="camera-fallback__message" role="status" aria-live="polite">
        <p className="camera-fallback__head">
          <span className="camera-fallback__dot" />
          {copy.title}
        </p>
        <p className="camera-fallback__body">{copy.body}</p>
        <ul className="camera-fallback__steps">
          {copy.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ul>
      </div>
      <div className="camera-fallback__foot">
        <button
          type="button"
          className="camera-fallback__dismiss"
          onClick={() => dismissRef.current()}
        >
          知道了
        </button>
      </div>
    </aside>
  )
}
