import { useCallback, useEffect, useRef, useState } from 'react'

type MelodyNote = readonly [frequency: number, duration: number]

/** A short, generated Happy Birthday melody keeps the first version self-contained. */
const MELODY: readonly MelodyNote[] = [
  [392, 0.28], [392, 0.28], [440, 0.48], [392, 0.48], [523.25, 0.48], [493.88, 0.8],
  [392, 0.28], [392, 0.28], [440, 0.48], [392, 0.48], [587.33, 0.48], [523.25, 0.8],
  [392, 0.28], [392, 0.28], [783.99, 0.48], [659.25, 0.48], [523.25, 0.48], [493.88, 0.48], [440, 0.8],
  [698.46, 0.28], [698.46, 0.28], [659.25, 0.48], [523.25, 0.48], [587.33, 0.48], [523.25, 0.95],
]

type BirthdayMusicControls = {
  available: boolean
  muted: boolean
  playing: boolean
  start: () => Promise<void>
  toggleMuted: () => void
  togglePlaying: () => void
}

type WindowWithWebkitAudio = Window & typeof globalThis & {
  webkitAudioContext?: typeof AudioContext
}

export function useBirthdayMusic(): BirthdayMusicControls {
  const [available, setAvailable] = useState(true)
  const [muted, setMuted] = useState(false)
  const [playing, setPlaying] = useState(false)
  const contextRef = useRef<AudioContext | null>(null)
  const outputRef = useRef<GainNode | null>(null)
  const timerRef = useRef<number | null>(null)
  const nextNoteAtRef = useRef(0)
  const noteIndexRef = useRef(0)
  const playingRef = useRef(false)
  const mutedRef = useRef(muted)

  useEffect(() => {
    mutedRef.current = muted
    const context = contextRef.current
    const output = outputRef.current
    if (context && output) {
      output.gain.setTargetAtTime(muted ? 0 : 0.16, context.currentTime, 0.04)
    }
  }, [muted])

  const scheduleNote = useCallback(() => {
    const context = contextRef.current
    const output = outputRef.current
    if (!context || !output) return

    const [frequency, duration] = MELODY[noteIndexRef.current]
    const start = Math.max(nextNoteAtRef.current, context.currentTime + 0.02)
    const end = start + duration
    const oscillator = context.createOscillator()
    const envelope = context.createGain()

    oscillator.type = 'triangle'
    oscillator.frequency.setValueAtTime(frequency, start)
    envelope.gain.setValueAtTime(0.0001, start)
    envelope.gain.exponentialRampToValueAtTime(0.22, start + 0.025)
    envelope.gain.setValueAtTime(0.22, Math.max(start + 0.03, end - 0.07))
    envelope.gain.exponentialRampToValueAtTime(0.0001, end)
    oscillator.connect(envelope)
    envelope.connect(output)
    oscillator.start(start)
    oscillator.stop(end + 0.03)

    nextNoteAtRef.current = end + 0.055
    noteIndexRef.current = (noteIndexRef.current + 1) % MELODY.length
  }, [])

  const scheduleAhead = useCallback(function schedule() {
    const context = contextRef.current
    if (!context || !playingRef.current) return

    while (nextNoteAtRef.current < context.currentTime + 0.45) {
      scheduleNote()
    }
    timerRef.current = window.setTimeout(schedule, 120)
  }, [scheduleNote])

  const start = useCallback(async () => {
    if (typeof window === 'undefined') return

    try {
      if (!contextRef.current) {
        const audioWindow = window as WindowWithWebkitAudio
        const AudioContextConstructor = window.AudioContext ?? audioWindow.webkitAudioContext
        if (!AudioContextConstructor) {
          setAvailable(false)
          return
        }

        const context = new AudioContextConstructor()
        const output = context.createGain()
        output.gain.value = mutedRef.current ? 0 : 0.16
        output.connect(context.destination)
        contextRef.current = context
        outputRef.current = output
      }

      const context = contextRef.current
      if (!context) return
      await context.resume()
      playingRef.current = true
      setPlaying(true)
      if (nextNoteAtRef.current <= context.currentTime) {
        nextNoteAtRef.current = context.currentTime + 0.05
      }
      if (timerRef.current === null) scheduleAhead()
    } catch {
      setAvailable(false)
      playingRef.current = false
      setPlaying(false)
    }
  }, [scheduleAhead])

  const toggleMuted = useCallback(() => {
    setMuted((value) => !value)
  }, [])

  const togglePlaying = useCallback(() => {
    const context = contextRef.current
    if (!context || !playingRef.current) {
      void start()
      return
    }

    playingRef.current = false
    setPlaying(false)
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    void context.suspend()
  }, [start])

  useEffect(() => {
    return () => {
      playingRef.current = false
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      const context = contextRef.current
      if (context) void context.close()
    }
  }, [])

  return { available, muted, playing, start, toggleMuted, togglePlaying }
}
