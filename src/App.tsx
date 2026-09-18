import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react'
import {
  Camera,
  CameraOff,
  Check,
  Keyboard,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { ParticleCanvas, type QualitySnapshot } from './components/ParticleCanvas'
import { GestureController, type GestureMode, type GestureStatus } from './components/GestureController'
import { GestureFeedback } from './components/GestureFeedback'
import { createGestureFeedbackState } from './components/gestureFeedbackState'
import { createModeSwitchGuard } from './components/modeSelection'
import { useBirthdayMusic } from './components/BirthdayMusic'
import './App.css'

type ModeId = 'galaxy' | 'birthday' | 'pig' | 'closing'
type CameraStatus =
  | 'idle'
  | 'requesting'
  | 'enabled'
  | 'denied'
  | 'unavailable'
  | 'unsupported'
  | 'error'
  | 'closed'

type Mode = {
  id: ModeId
  key: string
  label: string
  kicker: string
  title: string
  message: string
  detail: string
}

const modes: Mode[] = [
  {
    id: 'galaxy',
    key: '1',
    label: '银河态',
    kicker: '01 / STARFIELD',
    title: '让星光先替我说声生日快乐',
    message: '愿新的一岁，日子像银河一样明亮自在。',
    detail: '星尘自由流动中',
  },
  {
    id: 'birthday',
    key: '2',
    label: '生日快乐',
    kicker: '02 / WISH TEXT',
    title: '生日快乐，张珂欣',
    message: '愿你每天开心，学习顺利，也越来越聪明。',
    detail: '祝福文字已点亮',
  },
  {
    id: 'pig',
    key: '3',
    label: '猪头卡通',
    kicker: '03 / PINK CONSTELLATION',
    title: '一颗可爱的粉色星座',
    message: '把今天的好心情，收进这颗软乎乎的星星里。',
    detail: '粒子已采样猪头轮廓与主要色块',
  },
  {
    id: 'closing',
    key: '4',
    label: '祝福收束',
    kicker: '04 / WARM FINALE',
    title: '生日快乐，张珂欣',
    message: '愿你被温柔照亮，也一直保留自己的可爱。',
    detail: '星光正在聚拢',
  },
]

const stars = Array.from({ length: 42 }, (_, index) => ({
  left: `${(index * 47 + 9) % 100}%`,
  top: `${(index * 31 + 7) % 100}%`,
  size: `${(index % 3) + 1}px`,
  delay: `${(index % 9) * 0.7}s`,
  duration: `${4 + (index % 6)}s`,
}))

function App() {
  const [started, setStarted] = useState(false)
  const [currentMode, setCurrentMode] = useState<ModeId>('galaxy')
  const [paused, setPaused] = useState(false)
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>('idle')
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null)
  const [gestureStatus, setGestureStatus] = useState<GestureStatus>('idle')
  const [galaxyFlow, setGalaxyFlow] = useState({ x: 0, y: 0 })
  const [quality, setQuality] = useState<QualitySnapshot>({ tier: 'high', fps: 0 })
  const videoRef = useRef<HTMLVideoElement>(null)
  const dragPointRef = useRef<{ x: number; y: number } | null>(null)
  // 手势反馈心跳：每帧就地更新，不走 state（否则整页每秒重渲染几十次）。
  const [gestureFeedback] = useState(() => createGestureFeedbackState())
  const modeSwitchGuardRef = useRef(createModeSwitchGuard())
  /** 供手势回调同步读取当前样式：手势回调是常驻的，不能依赖闭包里的 currentMode。 */
  const currentModeRef = useRef<ModeId>('galaxy')
  const {
    available: musicAvailable,
    muted: musicMuted,
    playing: musicPlaying,
    start: startMusic,
    toggleMuted: toggleMusicMuted,
    togglePlaying: toggleMusicPlaying,
  } = useBirthdayMusic()

  const activeMode = useMemo(
    () => modes.find((mode) => mode.id === currentMode) ?? modes[0],
    [currentMode],
  )

  useEffect(() => {
    currentModeRef.current = currentMode
  }, [currentMode])

  const handleStart = useCallback(async () => {
    if (cameraStatus === 'requesting') return

    setStarted(true)
    setCameraStatus('requesting')
    void startMusic()

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraStatus('unsupported')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true })
      setCameraStream(stream)
      setCameraStatus('enabled')
    } catch (error) {
      const errorName = error instanceof DOMException ? error.name : ''
      if (errorName === 'NotAllowedError' || errorName === 'SecurityError') {
        setCameraStatus('denied')
      } else if (errorName === 'NotFoundError' || errorName === 'OverconstrainedError') {
        setCameraStatus('unavailable')
      } else {
        setCameraStatus('error')
      }
    }
  }, [cameraStatus, startMusic])

  const closeCamera = useCallback(() => {
    setCameraStream((stream) => {
      stream?.getTracks().forEach((track) => track.stop())
      return null
    })
    setCameraStatus('closed')
  }, [])

  const selectMode = useCallback((mode: ModeId) => {
    setCurrentMode(mode)
    setPaused(false)
  }, [])

  const handleGesture = useCallback((mode: GestureMode) => {
    // 需求 8：识别不到手势时不会走到这里，当前样式原样保留。
    // 需求 3.4.3：同一个手势重复触发同一目标仍然允许，重复设置同一目标不会产生过渡抖动。
    if (mode === currentModeRef.current) return
    // 只给「换样式」加一道很短的闸门（300ms），远小于做一次手势所需的 700ms 保持时间，
    // 因此正常切换不受影响，只挡住模型在边界上逐帧摇摆造成的过渡动画反复重启。
    if (!modeSwitchGuardRef.current.allow(performance.now())) return
    selectMode(mode)
  }, [selectMode])

  const handleQualityChange = useCallback((snapshot: QualitySnapshot) => {
    setQuality(snapshot)
  }, [])

  const handleStageWheel = useCallback((event: ReactWheelEvent<HTMLElement>) => {
    if (currentMode !== 'galaxy') return
    event.preventDefault()
    setGalaxyFlow((flow) => ({
      x: flow.x,
      y: Math.max(-240, Math.min(240, flow.y + event.deltaY * 0.16)),
    }))
  }, [currentMode])

  const handleStagePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (currentMode !== 'galaxy') return
    dragPointRef.current = { x: event.clientX, y: event.clientY }
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [currentMode])

  const handleStagePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (currentMode !== 'galaxy' || !dragPointRef.current) return
    const deltaX = event.clientX - dragPointRef.current.x
    const deltaY = event.clientY - dragPointRef.current.y
    dragPointRef.current = { x: event.clientX, y: event.clientY }
    setGalaxyFlow((flow) => ({
      x: Math.max(-240, Math.min(240, flow.x + deltaX * 1.4)),
      y: Math.max(-240, Math.min(240, flow.y + deltaY * 1.4)),
    }))
  }, [currentMode])

  const handleStagePointerEnd = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    dragPointRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.srcObject = cameraStream
    return () => {
      video.srcObject = null
    }
  }, [cameraStream, started])

  useEffect(() => {
    return () => {
      cameraStream?.getTracks().forEach((track) => track.stop())
    }
  }, [cameraStream])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!started) {
        if (event.key === 'Enter') {
          event.preventDefault()
          void handleStart()
        }
        return
      }

      const modeByKey: Record<string, ModeId> = {
        '1': 'galaxy',
        '2': 'birthday',
        '3': 'pig',
        '4': 'closing',
      }
      if (modeByKey[event.key]) {
        event.preventDefault()
        selectMode(modeByKey[event.key])
      } else if (event.key === ' ') {
        event.preventDefault()
        setPaused((value) => !value)
      } else if (event.key.toLowerCase() === 'r') {
        event.preventDefault()
        setCurrentMode('galaxy')
        setPaused(false)
        setGalaxyFlow({ x: 0, y: 0 })
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleStart, selectMode, started])

  const cameraLabel: Record<CameraStatus, string> = {
    idle: '摄像头未开启',
    requesting: '摄像头授权中',
    enabled: '摄像头已开启',
    denied: '摄像头未开启 · 权限未授予',
    unavailable: '摄像头未开启 · 未找到设备',
    unsupported: '摄像头未开启 · 浏览器不支持',
    error: '摄像头未开启 · 设备暂不可用',
    closed: '摄像头未开启 · 已关闭',
  }

  const gestureLabel: Record<GestureStatus, string> = {
    idle: '手势识别未启动',
    loading: '手势识别加载中',
    ready: '等待手势',
    holding: '请保持当前手势',
    recognized: '手势已触发',
    unrecognized: '未识别到手势',
    unavailable: '手势识别不可用 · 可用键盘或鼠标',
  }

  return (
    <div className="app-shell">
      <div className="starfield" aria-hidden="true">
        {stars.map((star, index) => (
          <i
            className="star"
            key={index}
            style={
              {
                left: star.left,
                top: star.top,
                width: star.size,
                height: star.size,
                animationDelay: star.delay,
                animationDuration: star.duration,
              } as CSSProperties
            }
          />
        ))}
      </div>
      <div className="aurora aurora-one" aria-hidden="true" />
      <div className="aurora aurora-two" aria-hidden="true" />
      <GestureController
        videoRef={videoRef}
        enabled={cameraStatus === 'enabled' && Boolean(cameraStream)}
        onGesture={handleGesture}
        onStatus={setGestureStatus}
        feedback={gestureFeedback}
      />

      {!started ? (
        <main className="landing" aria-labelledby="landing-title">
          <div className="landing-topline">
            <span className="signal-dot" />
            <span>10.11 · A SMALL UNIVERSE FOR YOU</span>
          </div>
          <div className="landing-content">
            <div className="landing-copy">
              <p className="eyebrow">A BIRTHDAY CONSTELLATION</p>
              <h1 id="landing-title">张珂欣<span>，生日快乐</span></h1>
              <p className="landing-message">
                送你一片可以自由探索的星光。愿新的一岁，开心常在，学习顺利，也越来越聪明。
              </p>
              <div className="landing-actions">
                <button className="primary-button" type="button" onClick={() => void handleStart()}>
                  <Sparkles size={18} aria-hidden="true" />
                  开启星光
                </button>
                <span className="enter-hint">或按 Enter 开始</span>
              </div>
              <div className="privacy-note">
                <ShieldCheck size={16} aria-hidden="true" />
                <span>摄像头只在本地预览，不上传画面；拒绝授权也能完整浏览。</span>
              </div>
            </div>
            <div className="landing-orbit" aria-hidden="true">
              <div className="orbit orbit-outer" />
              <div className="orbit orbit-inner" />
              <div className="orbit-core"><Sparkles size={26} /></div>
              <span className="orbit-label orbit-label-top">FOR KEXIN</span>
              <span className="orbit-label orbit-label-bottom">SOFT LIGHT / 10.11</span>
            </div>
          </div>
          <footer className="landing-footer">
            <span>一份轻轻放在夜空里的祝福</span>
            <span className="footer-rule" />
            <span>键盘 1 / 2 / 3 / 4 可切换星图</span>
          </footer>
        </main>
      ) : (
        <main className={`experience ${paused ? 'is-paused' : ''}`} aria-labelledby="experience-title">
          <header className="topbar">
            <div className="brand">
              <span className="brand-mark"><Sparkles size={14} aria-hidden="true" /></span>
              <span>张珂欣 · 生日星图</span>
            </div>
            <div className="topbar-actions">
              <span className={`camera-status status-${cameraStatus}`}>
                <span className="status-light" />
                {cameraLabel[cameraStatus]}
              </span>
              <button
                type="button"
                className="icon-button"
                onClick={closeCamera}
                disabled={!cameraStream}
                title="关闭摄像头"
                aria-label="关闭摄像头"
              >
                <CameraOff size={17} aria-hidden="true" />
              </button>
              <span className={`gesture-status gesture-${gestureStatus}`} aria-live="polite">
                <span className="status-light" />
                {gestureLabel[gestureStatus]}
              </span>
              <button
                type="button"
                className={`icon-button ${musicMuted ? '' : 'is-active'}`}
                onClick={toggleMusicMuted}
                title={musicMuted ? '打开音乐' : '静音音乐'}
                aria-label={musicMuted ? '打开音乐' : '静音音乐'}
                aria-pressed={!musicMuted}
              >
                {musicMuted ? <VolumeX size={17} aria-hidden="true" /> : <Volume2 size={17} aria-hidden="true" />}
              </button>
              <button
                type="button"
                className={`icon-button ${musicPlaying ? 'is-active' : ''}`}
                onClick={toggleMusicPlaying}
                disabled={!musicAvailable}
                title={musicPlaying ? '暂停音乐' : '继续音乐'}
                aria-label={musicPlaying ? '暂停音乐' : '继续音乐'}
                aria-pressed={musicPlaying}
              >
                {musicPlaying ? <Pause size={17} aria-hidden="true" /> : <Play size={17} aria-hidden="true" />}
              </button>
            </div>
          </header>

          <div className="experience-grid">
            <section className="scene-copy">
              <p className="eyebrow">{activeMode.kicker}</p>
              <h1 id="experience-title">{activeMode.title}</h1>
              <p className="scene-message">{activeMode.message}</p>
              <p className="scene-detail">{activeMode.detail}</p>

              <div className="control-row">
                <button
                  type="button"
                  className="control-button"
                  onClick={() => setPaused((value) => !value)}
                  title={paused ? '继续动画' : '暂停动画'}
                >
                  {paused ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}
                  {paused ? '继续' : '暂停'}
                </button>
                <button
                  type="button"
                  className="control-button control-button-muted"
                  onClick={() => {
                    setCurrentMode('galaxy')
                    setPaused(false)
                    setGalaxyFlow({ x: 0, y: 0 })
                  }}
                  title="回到银河态"
                >
                  <RotateCcw size={16} aria-hidden="true" />
                  回到银河
                </button>
              </div>

              <div className="keyboard-guide">
                <div className="guide-heading"><Keyboard size={15} aria-hidden="true" /> 键盘提示</div>
                <div className="key-list">
                  <span><kbd>1</kbd> 银河</span>
                  <span><kbd>2</kbd> 生日</span>
                  <span><kbd>3</kbd> 猪头</span>
                  <span><kbd>4</kbd> 收束</span>
                  <span><kbd>空格</kbd> 暂停</span>
                  <span><kbd>R</kbd> 重置</span>
                </div>
              </div>
            </section>

            <section
              className={`stage stage-${currentMode}`}
              aria-label={`${activeMode.label}动画预览`}
              onWheel={handleStageWheel}
              onPointerDown={handleStagePointerDown}
              onPointerMove={handleStagePointerMove}
              onPointerUp={handleStagePointerEnd}
              onPointerCancel={handleStagePointerEnd}
            >
              <div className="stage-grid" aria-hidden="true" />
              <div className="stage-halo" aria-hidden="true" />
              <ParticleCanvas mode={currentMode} paused={paused} flow={galaxyFlow} onQualityChange={handleQualityChange} />
              {cameraStatus === 'enabled' && cameraStream && (
                <>
                  <GestureFeedback state={gestureFeedback} />
                  <div className="camera-preview">
                    <video ref={videoRef} autoPlay playsInline muted />
                    <span><Camera size={12} aria-hidden="true" /> 本地预览</span>
                  </div>
                </>
              )}
              <div className="stage-caption">
                <span>{activeMode.label}</span>
                <span className="stage-quality" data-tier={quality.tier}>{quality.tier.toUpperCase()} · {Math.round(quality.fps)} FPS</span>
                <span>{paused ? '已暂停' : 'LIVE'}</span>
              </div>
            </section>
          </div>

          <nav className="mode-nav" aria-label="祝福模式">
            <div className="mode-nav-label">选择一束星光</div>
            <div className="mode-tabs">
              {modes.map((mode) => (
                <button
                  className={`mode-tab ${currentMode === mode.id ? 'is-selected' : ''}`}
                  key={mode.id}
                  type="button"
                  onClick={() => selectMode(mode.id)}
                  aria-pressed={currentMode === mode.id}
                >
                  <span className="mode-key">{mode.key}</span>
                  <span>{mode.label}</span>
                  {currentMode === mode.id && <Check size={14} aria-hidden="true" />}
                </button>
              ))}
            </div>
            <div className="music-note">
              {musicAvailable ? 'Happy Birthday · 星光旋律' : '当前浏览器不支持音乐'}
            </div>
          </nav>
        </main>
      )}
    </div>
  )
}

export default App
