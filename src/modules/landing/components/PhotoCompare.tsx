import { ChevronsLeftRight } from 'lucide-react'
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react'
import { useCallback, useRef, useState } from 'react'

import {
  COMPARE_MAX_POSITION,
  COMPARE_MIN_POSITION,
  useComparePosition,
} from '../hooks/useComparePosition'

type CompareStyle = CSSProperties & {
  '--lf-compare-position': string
}

function clampPosition(value: number) {
  return Math.max(COMPARE_MIN_POSITION, Math.min(COMPARE_MAX_POSITION, value))
}

export function PhotoCompare({
  src,
  label,
  neutralTag,
  finishedTag,
  valueText,
  sweep = true,
}: {
  src: string
  label: string
  neutralTag: string
  finishedTag: string
  valueText: (neutralPercent: number, finishedPercent: number) => string
  sweep?: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const finishedImageRef = useRef<HTMLImageElement>(null)
  const activePointerId = useRef<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const { position, setPosition, cancelSweep } = useComparePosition({
    sweep,
    imageRef: finishedImageRef,
  })

  const updatePosition = useCallback(
    (clientX: number) => {
      const element = containerRef.current
      if (!element) return

      const bounds = element.getBoundingClientRect()
      setPosition(clampPosition((clientX - bounds.left) / bounds.width))
    },
    [setPosition],
  )

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!event.isPrimary) return

      cancelSweep()
      activePointerId.current = event.pointerId
      event.currentTarget.setPointerCapture(event.pointerId)
      setDragging(true)
      updatePosition(event.clientX)
    },
    [cancelSweep, updatePosition],
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
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 0.1 : 0.02
      let next: ((current: number) => number) | null = null
      if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
        next = (current) => clampPosition(current - step)
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
        next = (current) => clampPosition(current + step)
      } else if (event.key === 'Home') {
        next = () => COMPARE_MIN_POSITION
      } else if (event.key === 'End') {
        next = () => COMPARE_MAX_POSITION
      }
      if (!next) return

      event.preventDefault()
      cancelSweep()
      setPosition(next)
    },
    [cancelSweep, setPosition],
  )

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
      aria-valuemin={Math.round(COMPARE_MIN_POSITION * 100)}
      aria-valuemax={Math.round(COMPARE_MAX_POSITION * 100)}
      aria-valuenow={neutralPercent}
      aria-valuetext={valueText(neutralPercent, finishedPercent)}
      data-dragging={dragging ? 'true' : undefined}
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
          src={src}
          alt=""
          draggable={false}
        />
        <div className="lf-compare-finished-clip">
          <img
            ref={finishedImageRef}
            className="lf-compare-photo lf-compare-photo-finished"
            src={src}
            alt=""
            draggable={false}
          />
        </div>
        <div className="lf-compare-divider">
          <span className="lf-compare-handle">
            <ChevronsLeftRight size={19} strokeWidth={1.9} />
          </span>
        </div>
      </div>
      <span className="lf-compare-tag lf-tag-left">{neutralTag}</span>
      <span className="lf-compare-tag lf-tag-right">{finishedTag}</span>
    </div>
  )
}
