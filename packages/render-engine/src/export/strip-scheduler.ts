import type { LumaRawWindowRect } from '@lumaforge/luma-raw-runtime'

export type ExportStrip = {
  output: LumaRawWindowRect
  input: LumaRawWindowRect
}

const MAX_EXPORT_STRIP_ROWS = 4096

export function normalizePreferredStripRows(
  preferredRows: number,
  maxRows = MAX_EXPORT_STRIP_ROWS,
) {
  if (!Number.isFinite(preferredRows) || preferredRows <= 0) {
    throw new Error('FULL_RES_EXPORT_INVALID_PREFERRED_ROWS')
  }

  return Math.min(maxRows, Math.max(1, Math.floor(preferredRows)))
}

export function expandRectWithHalo(
  rect: LumaRawWindowRect,
  bounds: { width: number; height: number },
  halo: number,
): LumaRawWindowRect {
  const x = Math.max(0, rect.x - halo)
  const y = Math.max(0, rect.y - halo)
  const right = Math.min(bounds.width, rect.x + rect.width + halo)
  const bottom = Math.min(bounds.height, rect.y + rect.height + halo)

  return { x, y, width: right - x, height: bottom - y }
}

export function planExportStrips(input: {
  width: number
  height: number
  preferredRows: number
  minRows: number
  halo: number
}): ExportStrip[] {
  const rows = Math.max(
    input.minRows,
    normalizePreferredStripRows(input.preferredRows),
  )
  const strips: ExportStrip[] = []

  for (let y = 0; y < input.height; y += rows) {
    const output = {
      x: 0,
      y,
      width: input.width,
      height: Math.min(rows, input.height - y),
    }

    strips.push({
      output,
      input: expandRectWithHalo(output, input, input.halo),
    })
  }

  return strips
}

export function reduceStripRows(currentRows: number, minRows: number) {
  if (currentRows <= minRows) {
    return minRows
  }

  return Math.max(
    minRows,
    Math.min(currentRows - 1, Math.floor(currentRows / 2)),
  )
}
