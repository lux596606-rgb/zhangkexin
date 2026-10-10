import { useEffect, useId, useRef } from 'react'
import portrait from '../assets/kexin-birthday.jpg'
import './PhotoMoment.css'

// This component intentionally shares its local image URL with the surrounding scene.
// oxlint-disable-next-line react/only-export-components
export const birthdayPortrait = portrait

export function PhotoMoment() {
  const viewerRef = useRef<HTMLDialogElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const previousOverflow = useRef<string | null>(null)
  const viewerId = useId()
  const viewerTitleId = useId()

  function restoreScroll() {
    if (previousOverflow.current !== null) {
      document.body.style.overflow = previousOverflow.current
      previousOverflow.current = null
    }
  }

  useEffect(() => restoreScroll, [])

  function openViewer() {
    const viewer = viewerRef.current
    if (!viewer || viewer.open) return

    viewer.showModal()
    previousOverflow.current = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }

  function closeViewer() {
    viewerRef.current?.close()
  }

  return (
    <>
      <figure className="photo-moment">
        <div className="photo-moment__frame">
          <img
            className="photo-moment__portrait"
            src={birthdayPortrait}
            alt="张珂欣戴着蓝色迷彩帽和眼镜的照片"
            width={1280}
            height={2182}
            loading="lazy"
            decoding="async"
          />
        </div>
        <figcaption className="photo-moment__caption">
          <span>今天的主角，当然是你。</span>
          <button
            className="photo-moment__open"
            type="button"
            ref={triggerRef}
            aria-haspopup="dialog"
            aria-controls={viewerId}
            onClick={openViewer}
          >
            看看完整照片
          </button>
        </figcaption>
      </figure>

      <dialog
        className="photo-viewer"
        id={viewerId}
        ref={viewerRef}
        aria-labelledby={viewerTitleId}
        onClose={() => {
          restoreScroll()
          triggerRef.current?.focus({ preventScroll: true })
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeViewer()
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div className="photo-viewer__content">
          <div className="photo-viewer__bar">
            <h2 className="photo-viewer__title" id={viewerTitleId}>
              今天的主角
            </h2>
            <button
              className="photo-viewer__close"
              type="button"
              onClick={closeViewer}
              autoFocus
            >
              <span>关闭照片</span>
              <span className="photo-viewer__close-mark" aria-hidden="true">×</span>
            </button>
          </div>
          <img
            className="photo-viewer__image"
            src={birthdayPortrait}
            alt="张珂欣戴着蓝色迷彩帽和眼镜的完整照片"
            width={1280}
            height={2182}
            decoding="async"
          />
        </div>
      </dialog>
    </>
  )
}
