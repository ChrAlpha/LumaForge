import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react'
import { useCallback, useRef, useState } from 'react'

const MIN_POSITION = 0.02
const MAX_POSITION = 0.98

type CompareStyle = CSSProperties & {
  '--lf-compare-position': string
}

export function LandingPhotoCompare({
  label,
  neutralTag,
  finishedTag,
  valueText,
}: {
  label: string
  neutralTag: string
  finishedTag: string
  valueText: (neutralPercent: number, finishedPercent: number) => string
}) {
  const [position, setPosition] = useState(0.5)
  const containerRef = useRef<HTMLDivElement>(null)
  const activePointerId = useRef<number | null>(null)

  const updatePosition = useCallback((clientX: number) => {
    const element = containerRef.current
    if (!element) return

    const bounds = element.getBoundingClientRect()
    const next = (clientX - bounds.left) / bounds.width
    setPosition(Math.max(MIN_POSITION, Math.min(MAX_POSITION, next)))
  }, [])

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!event.isPrimary) return

      activePointerId.current = event.pointerId
      event.currentTarget.setPointerCapture(event.pointerId)
      updatePosition(event.clientX)
    },
    [updatePosition],
  )

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (activePointerId.current !== event.pointerId) return
      updatePosition(event.clientX)
    },
    [updatePosition],
  )

  const finishPointer = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (activePointerId.current !== event.pointerId) return
    activePointerId.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.1 : 0.02
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault()
      setPosition((current) => Math.max(MIN_POSITION, current - step))
      return
    }
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault()
      setPosition((current) => Math.min(MAX_POSITION, current + step))
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      setPosition(MIN_POSITION)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      setPosition(MAX_POSITION)
    }
  }, [])

  const neutralPercent = Math.round(position * 100)
  const finishedPercent = 100 - neutralPercent
  const style: CompareStyle = {
    '--lf-compare-position': `${neutralPercent}%`,
  }

  return (
    <div
      ref={containerRef}
      className="lf-compare-container"
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={2}
      aria-valuemax={98}
      aria-valuenow={neutralPercent}
      aria-valuetext={valueText(neutralPercent, finishedPercent)}
      style={style}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
      onKeyDown={handleKeyDown}
    >
      <div className="lf-compare-visual" aria-hidden="true">
        <img
          className="lf-compare-photo lf-compare-photo-neutral"
          src="/landing-raw-finish.webp"
          alt=""
          draggable={false}
        />
        <div className="lf-compare-finished-clip">
          <img
            className="lf-compare-photo lf-compare-photo-finished"
            src="/landing-raw-finish.webp"
            alt=""
            draggable={false}
          />
        </div>
        <div className="lf-compare-divider">
          <span className="lf-compare-handle" aria-hidden="true">
            <span>‹</span>
            <span>›</span>
          </span>
        </div>
      </div>
      <span className="lf-compare-tag lf-tag-left">{neutralTag}</span>
      <span className="lf-compare-tag lf-tag-right">{finishedTag}</span>
    </div>
  )
}
