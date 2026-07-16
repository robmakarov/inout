import { useEffect, useRef, useState } from 'react'

/** Pulsing ring driven by an AnalyserNode on the live stream; falls back to a static pill. */
export function AudioLevelRing({ stream }: { stream: MediaStream }) {
  const ringRef = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (stream.getAudioTracks().length === 0) {
      setFailed(true)
      return
    }
    let ctx: AudioContext
    let raf = 0
    try {
      ctx = new AudioContext()
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      const data = new Uint8Array(analyser.fftSize)
      const tick = () => {
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / data.length)
        const el = ringRef.current
        if (el) {
          const level = Math.min(1, rms * 4)
          el.style.transform = `scale(${1 + level * 0.6})`
          el.style.opacity = `${0.35 + level * 0.65}`
        }
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    } catch {
      setFailed(true)
      return
    }
    return () => {
      cancelAnimationFrame(raf)
      void ctx.close().catch(() => {})
    }
  }, [stream])

  if (failed) return <div className="audio-pill">Recording audio</div>
  return (
    <div className="audio-viz" aria-hidden="true">
      <div ref={ringRef} className="audio-viz__ring" />
      <div className="audio-viz__core" />
    </div>
  )
}
