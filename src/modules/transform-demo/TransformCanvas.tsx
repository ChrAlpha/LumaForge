import { useEffect, useRef } from 'react'

import { useI18n } from '~/lib/i18n'

import { applyMatrix, identityMatrix } from './geometry/matrix'
import type { LineSegment } from './geometry/types'
import type { PreviewFrame } from './preview-types'
import type { RenderedPreview } from './transform-types'

export function TransformCanvas({
  source,
  result,
  lines,
  original,
  showLines,
  showGrid,
}: {
  source: PreviewFrame
  result: RenderedPreview | null
  lines: LineSegment[]
  original: boolean
  showLines: boolean
  showGrid: boolean
}) {
  const { t } = useI18n()
  const ref = useRef<HTMLCanvasElement>(null)
  const frame = original || !result ? source : result.frame
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    canvas.width = frame.width
    canvas.height = frame.height
    const context = canvas.getContext('2d')
    if (!context) return
    context.putImageData(
      new ImageData(
        new Uint8ClampedArray(frame.data),
        frame.width,
        frame.height,
      ),
      0,
      0,
    )
    const colors = getComputedStyle(document.documentElement)
    if (showGrid) {
      context.strokeStyle = colors
        .getPropertyValue('--color-lf-on-surface')
        .trim()
      context.globalAlpha = 0.45
      context.lineWidth = Math.max(1, frame.width / 1200)
      for (let i = 1; i < 4; i++) {
        context.beginPath()
        context.moveTo((frame.width * i) / 4, 0)
        context.lineTo((frame.width * i) / 4, frame.height)
        context.moveTo(0, (frame.height * i) / 4)
        context.lineTo(frame.width, (frame.height * i) / 4)
        context.stroke()
      }
      context.globalAlpha = 1
    }
    if (!showLines) return
    const matrix = original || !result ? identityMatrix() : result.displayMatrix
    context.lineWidth = Math.max(1.5, frame.width / 550)
    for (const line of lines) {
      if (line.kind === 'other') continue
      const start = applyMatrix(matrix, {
        x: line.start.x / source.width,
        y: line.start.y / source.height,
      })
      const end = applyMatrix(matrix, {
        x: line.end.x / source.width,
        y: line.end.y / source.height,
      })
      if (!start || !end) continue
      context.strokeStyle = colors
        .getPropertyValue(
          line.kind === 'vertical' ? '--color-lf-green' : '--color-lf-sky',
        )
        .trim()
      context.beginPath()
      context.moveTo(start.x * frame.width, start.y * frame.height)
      context.lineTo(end.x * frame.width, end.y * frame.height)
      context.stroke()
    }
  }, [
    frame,
    lines,
    original,
    result,
    showGrid,
    showLines,
    source.height,
    source.width,
  ])

  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={t(original ? 'transform.original' : 'transform.corrected')}
      data-testid="transform-canvas"
      data-view={original ? 'original' : 'corrected'}
      className="block max-h-full max-w-full object-contain"
    />
  )
}
