import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Camera, CameraOff, HelpCircle, Pause, Play, Sparkles, Volume2, VolumeX, X } from 'lucide-react'
import { GestureController, type GestureMode } from './components/GestureController'
import { GestureFeedback } from './components/GestureFeedback'
import { GestureGuide } from './components/GestureGuide'
import { cameraFallbackFor, type CameraStatus } from './components/cameraFallback'
import { createGestureFeedbackState } from './components/gestureFeedbackState'
import { createModeSwitchGuard } from './components/modeSelection'
import { useBirthdayMusic } from './components/BirthdayMusic'
import { PhotoMoment, birthdayPortrait } from './components/PhotoMoment'
import { ParticleStoryScene } from './components/ParticleStoryScene'
import { BIRTHDAY_AGE } from './components/sketchMotifs'
import { giftCopy } from './content/giftCopy'
import './App.css'

const animationModes: { id: GestureMode; label: string; key: string }[] = [
  { id: 'galaxy', label: '星光', key: '1' },
  { id: 'birthday', label: '生日快乐', key: '2' },
  { id: 'pig', label: '小彩蛋', key: '3' },
  { id: 'closing', label: '许个愿', key: '4' },
]

const ignoreGestureStatus = () => undefined

const stars = Array.from({ length: 42 }, (_, index) => ({
  left: String((index * 47 + 9) % 100) + '%',
  top: String((index * 31 + 7) % 100) + '%',
  size: String((index % 3) + 1) + 'px',
  delay: String((index % 9) * -0.7) + 's',
}))

function App() {
  const [paused, setPaused] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>('idle')
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null)
  const [activeMode, setActiveMode] = useState<GestureMode>('galaxy')
  const [wishOpened, setWishOpened] = useState(false)
  const [starsInView, setStarsInView] = useState(() => typeof IntersectionObserver === 'undefined')
  const [gestureFeedback] = useState(createGestureFeedbackState)
  const videoRef = useRef<HTMLVideoElement>(null)
  const starsRef = useRef<HTMLElement>(null)
  const helpButtonRef = useRef<HTMLButtonElement>(null)
  const cameraStreamRef = useRef<MediaStream | null>(null)
  const cameraRequestRef = useRef(0)
  const cameraPendingRef = useRef(false)
  const modeSwitchGuardRef = useRef(createModeSwitchGuard())
  const { available: musicAvailable, playing: musicPlaying, togglePlaying: toggleMusicPlaying } = useBirthdayMusic()
  const fallbackCopy = cameraFallbackFor(cameraStatus)

  const closeCamera = useCallback(() => {
    cameraRequestRef.current += 1
    cameraPendingRef.current = false
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop())
    cameraStreamRef.current = null
    setCameraStream(null)
    setCameraStatus('closed')
  }, [])

  const enableCamera = useCallback(async () => {
    if (cameraPendingRef.current || cameraStreamRef.current) return
    const request = ++cameraRequestRef.current
    cameraPendingRef.current = true
    setCameraStatus('requesting')
    if (!navigator.mediaDevices?.getUserMedia) {
      cameraPendingRef.current = false
      setCameraStatus('unsupported')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true })
      if (request !== cameraRequestRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      cameraStreamRef.current = stream
      setCameraStream(stream)
      setCameraStatus('enabled')
    } catch (error) {
      if (request !== cameraRequestRef.current) return
      const name = error instanceof DOMException ? error.name : ''
      setCameraStatus(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied'
        : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'unavailable' : 'error')
    } finally {
      if (request === cameraRequestRef.current) cameraPendingRef.current = false
    }
  }, [])

  useEffect(() => () => {
    cameraRequestRef.current += 1
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop())
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.srcObject = cameraStream
    return () => { video.srcObject = null }
  }, [cameraStream])

  useEffect(() => {
    const section = starsRef.current
    if (!section) return
    if (typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      ([entry]) => setStarsInView(entry.isIntersecting),
      { rootMargin: '80px 0px', threshold: 0.08 },
    )
    observer.observe(section)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if ((!starsInView || !helpOpen) && (cameraStreamRef.current || cameraPendingRef.current)) closeCamera()
  }, [starsInView, helpOpen, closeCamera])

  const handleGesture = useCallback((mode: GestureMode) => {
    if (mode === activeMode || !modeSwitchGuardRef.current.allow(performance.now())) return
    setActiveMode(mode)
  }, [activeMode])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!starsInView || event.altKey || event.ctrlKey || event.metaKey || event.repeat) return
      if (document.querySelector('dialog[open]')) return
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return
      const mode = animationModes.find((item) => item.key === event.key)
      if (mode) {
        event.preventDefault()
        setActiveMode(mode.id)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [starsInView])

  const closeHelp = () => {
    if (cameraStreamRef.current || cameraPendingRef.current) closeCamera()
    setHelpOpen(false)
    helpButtonRef.current?.focus()
  }

  return (
    <div className={`app-shell${paused ? ' is-paused' : ''}`} id="top">
      <div className="starfield" aria-hidden="true">
        {stars.map((star, index) => <i className="star" key={index} style={{ left: star.left, top: star.top, width: star.size, height: star.size, animationDelay: star.delay } as CSSProperties} />)}
      </div>
      <GestureController
        videoRef={videoRef}
        enabled={cameraStatus === 'enabled' && helpOpen && starsInView}
        onGesture={handleGesture}
        onStatus={ignoreGestureStatus}
        feedback={gestureFeedback}
      />

      <header className="site-header">
        <div className="site-header__inner">
          <a className="site-brand" href="#top"><Sparkles size={17} aria-hidden="true" /> 给张珂欣</a>
          <div className="header-actions">
            {cameraStatus === 'enabled' && <button className="text-button camera-active" type="button" onClick={closeCamera}><CameraOff size={16} aria-hidden="true" /> 关闭摄像头</button>}
            <button className="text-button motion-button" type="button" onClick={() => setPaused((value) => !value)} aria-label={paused ? '继续全部动效' : '暂停全部动效'} aria-pressed={paused} title={paused ? '继续全部动效' : '暂停全部动效'}>
              {paused ? <Play size={17} aria-hidden="true" /> : <Pause size={17} aria-hidden="true" />}
            </button>
            <button className="text-button music-button" type="button" onClick={toggleMusicPlaying} disabled={!musicAvailable} aria-label={!musicAvailable ? '音乐暂不可用' : musicPlaying ? '暂停音乐' : '播放音乐'} aria-pressed={musicPlaying}>
              {musicPlaying ? <Volume2 size={17} aria-hidden="true" /> : <VolumeX size={17} aria-hidden="true" />}
              {musicPlaying ? '暂停音乐' : '播放音乐'}
            </button>
          </div>
        </div>
      </header>

      <main className="story">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero__inner">
            <div className="hero__copy">
              <h1 className="hero__title" id="hero-title"><span>{giftCopy.hero.title[0]}</span><span>{giftCopy.hero.title[1]}</span></h1>
            </div>
            <figure className="hero__photo">
              <img src={birthdayPortrait} alt="张珂欣戴着蓝色迷彩帽和眼镜，看向镜头" width={1280} height={2182} fetchPriority="high" />
            </figure>
          </div>
        </section>

        <section className="story-section story-section--stars" id="stars" ref={starsRef} aria-labelledby="stars-title">
          <div className="section-inner">
            <div className="stars-intro">
              <h2 className="section-heading" id="stars-title">{giftCopy.opening.title}</h2>
            </div>
            <div className="stars-stage-wrap">
              <ParticleStoryScene mode={activeMode} paused={paused} allowFireworks={wishOpened} className="story-stage--main" />
              <div className="stars-tools">
                <p>鼠标可以轻轻拖动星河。手机上，直接往下滑就好。</p>
                <button className="icon-button" type="button" onClick={() => setPaused((value) => !value)} aria-pressed={paused} aria-label={paused ? '继续动画' : '暂停动画'} title={paused ? '继续动画' : '暂停动画'}>{paused ? <Play size={17} aria-hidden="true" /> : <Pause size={17} aria-hidden="true" />}</button>
              </div>
            </div>
            <div className="mode-choices" role="group" aria-label="切换星空里的粒子效果">
              {animationModes.map((mode) => <button className="mode-choice" key={mode.id} type="button" aria-pressed={activeMode === mode.id} onClick={() => setActiveMode(mode.id)}><span>{mode.key}</span>{mode.label}</button>)}
            </div>
            <button ref={helpButtonRef} className="text-button help-toggle" type="button" aria-expanded={helpOpen} aria-controls="gift-help" onClick={() => setHelpOpen((value) => !value)}><HelpCircle size={16} aria-hidden="true" /> 怎么玩</button>
            <div className="play-panel" id="gift-help" hidden={!helpOpen}>
              <div className="play-panel__head"><h3>多玩一会儿</h3><button className="icon-button" aria-label="收起手势玩法" type="button" onClick={closeHelp}><X size={18} /></button></div>
              <p>这只是星空里的一种玩法。直接往下读，整份祝福也都在。</p>
              <GestureGuide />
              <div className="camera-invitation">
                <button className="secondary-button" type="button" onClick={cameraStatus === 'requesting' || cameraStream ? closeCamera : () => void enableCamera()}>
                  {cameraStatus === 'requesting' || cameraStream ? <CameraOff size={17} /> : <Camera size={17} />}
                  {cameraStatus === 'requesting' ? '取消开启' : cameraStream ? '关闭摄像头' : '试试手势'}
                </button>
                <p>只有点这里才会打开摄像头；识别只在你的设备上进行。离开这片星空后，摄像头会自动关闭。</p>
              </div>
              {cameraStatus === 'requesting' && <p role="status">可以在浏览器提示里选择是否开启；也可以取消，继续往下读。</p>}
              {fallbackCopy && <div className="camera-message" role="status"><p>{fallbackCopy.title}</p><p>{fallbackCopy.body}</p></div>}
              {cameraStream && <div className="camera-dock"><video ref={videoRef} autoPlay playsInline muted aria-label="本地摄像头预览" /><GestureFeedback state={gestureFeedback} /></div>}
              <p className="keyboard-note">不用摄像头也可以按 <kbd>1</kbd>—<kbd>4</kbd> 换星空效果。键盘空格仍然可以正常向下翻页。</p>
            </div>
          </div>
        </section>

        <section className="story-section story-section--birthday" aria-labelledby="birthday-title">
          <div className="section-inner birthday-layout">
            <div className="birthday-copy">
              <h2 className="section-heading" id="birthday-title">{giftCopy.birthday.title}</h2>
              <div className="section-prose">{giftCopy.birthday.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</div>
              <ul className="birthday-wishes">{giftCopy.birthday.wishes.map((wish) => <li key={wish}>{wish}</li>)}</ul>
            </div>
            <div className="birthday-visual"><ParticleStoryScene mode="birthday" paused={paused} /></div>
          </div>
        </section>

        <section className="story-section story-section--photo" aria-labelledby="photo-title">
          <div className="section-inner photo-layout">
            <div className="photo-copy">
              <h2 className="section-heading" id="photo-title">{giftCopy.photo.title}</h2>
              <div className="section-prose">{giftCopy.photo.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</div>
            </div>
            <div className="photo-visual"><PhotoMoment /></div>
          </div>
        </section>

        <section className="story-section story-section--pig" aria-labelledby="pig-title">
          <div className="section-inner pig-layout">
            <div className="pig-copy"><h2 className="section-heading" id="pig-title">{giftCopy.pig.title}</h2></div>
            <div className="pig-visual"><ParticleStoryScene mode="pig" paused={paused} /></div>
          </div>
        </section>

        <section className="story-section story-section--letter" aria-labelledby="letter-title">
          <div className="section-inner letter-layout">
            <h2 className="section-heading" id="letter-title">{giftCopy.letter.title}</h2>
            <article className="birthday-letter" aria-label="写给张珂欣的短笺">
              {giftCopy.letter.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
            </article>
          </div>
        </section>

        <section className="story-section story-section--wish" aria-labelledby="wish-title">
          <div className="section-inner wish-layout">
            <div className="wish-copy">
              <h2 className="section-heading" id="wish-title">{giftCopy.wish.title}</h2>
              <div className="section-prose">{giftCopy.wish.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</div>
            </div>
            <div className="wish-stage">
              <p className="sr-only" role="status">{wishOpened ? '愿望收好啦。送给你的烟花和最后几句祝福，就在下面。' : ''}</p>
              {wishOpened ? (
                <div className="wish-reveal">
                  <ParticleStoryScene mode="closing" paused={paused} />
                  <div className="finale">
                    <h3>{giftCopy.finale.title}</h3>
                    {giftCopy.finale.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                    <p className="closing-signature">{giftCopy.finale.signoff}<br /><time dateTime="2026-10-11">{giftCopy.finale.date}</time></p>
                  </div>
                </div>
              ) : (
                <div className="wish-pause">
                  <div className="wish-orbit" aria-hidden="true"><Sparkles size={25} /><span>{BIRTHDAY_AGE}</span></div>
                  <button className="primary-button wish-button" type="button" onClick={() => setWishOpened(true)}>{giftCopy.wish.prompt} <Sparkles size={18} aria-hidden="true" /></button>
                </div>
              )}
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer"><span>给张珂欣的十九岁。</span><a href="#top">回到开头 ↑</a></footer>
    </div>
  )
}

export default App
