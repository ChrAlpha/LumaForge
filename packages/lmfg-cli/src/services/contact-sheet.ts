import type { LumaJpegNodeRuntime } from '@lumaforge/luma-jpeg-runtime/node'
import type { ContactSheet } from '@lumaforge/render-engine/preview'
import {
  composeContactSheet,
  encodePreviewFrameToJpeg,
} from '@lumaforge/render-engine/preview'

import { LmfgError } from '../protocol/errors'
import type { IterationResult } from '../schemas/results'
import type { IterationStore } from '../workspace/iteration-store'
import { toFileUri } from '../workspace/paths'

export function fitTileSize(
  srcWidth: number,
  srcHeight: number,
  tileWidth: number,
): { width: number; height: number } {
  const width = Math.max(1, Math.min(srcWidth, Math.floor(tileWidth)))
  const height = Math.max(1, Math.round((srcHeight * width) / srcWidth))
  return { width, height }
}

/** Area-averaging box filter. Never upsamples: callers pass dst ≤ src. */
export function downsampleRgba(
  src: Uint8ClampedArray | Uint8Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): Uint8ClampedArray {
  const dst = new Uint8ClampedArray(dstWidth * dstHeight * 4)
  for (let y = 0; y < dstHeight; y += 1) {
    const y0 = Math.floor((y * srcHeight) / dstHeight)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * srcHeight) / dstHeight))
    for (let x = 0; x < dstWidth; x += 1) {
      const x0 = Math.floor((x * srcWidth) / dstWidth)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * srcWidth) / dstWidth))
      let r = 0
      let g = 0
      let b = 0
      let count = 0
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const o = (sy * srcWidth + sx) * 4
          r += src[o]
          g += src[o + 1]
          b += src[o + 2]
          count += 1
        }
      }
      const d = (y * dstWidth + x) * 4
      dst[d] = Math.round(r / count)
      dst[d + 1] = Math.round(g / count)
      dst[d + 2] = Math.round(b / count)
      dst[d + 3] = 255
    }
  }
  return dst
}

export type SheetTile = {
  id: string
  rgba: Uint8ClampedArray
  width: number
  height: number
}

export type BuiltContactSheet = {
  sheet: ContactSheet
  rows: number
  cols: number
  gap: number
  tileWidth: number
  tileHeight: number
  map: Array<{
    candidate_id: string
    index: number
    x: number
    y: number
    width: number
    height: number
  }>
}

export function buildContactSheet(input: {
  tiles: SheetTile[]
  cols: number
  gap?: number
  rows?: number
}): BuiltContactSheet {
  const { tiles } = input
  if (tiles.length === 0) {
    throw new LmfgError('args.invalid', {
      message: 'A contact sheet needs at least one tile.',
    })
  }
  const cols = Math.max(1, Math.floor(input.cols))
  const rows = input.rows ?? Math.ceil(tiles.length / cols)
  if (cols * rows < tiles.length) {
    throw new LmfgError('args.invalid', {
      message: `Layout ${cols}x${rows} has ${cols * rows} cells but ${tiles.length} tiles were requested.`,
    })
  }
  const gap = Math.max(0, Math.floor(input.gap ?? 4))
  const tileWidth = tiles[0].width
  const tileHeight = tiles[0].height
  if (
    tiles.some((tile) => tile.width !== tileWidth || tile.height !== tileHeight)
  ) {
    throw new LmfgError('internal', {
      message: 'Contact sheet tiles must share one size.',
    })
  }
  const sheet = composeContactSheet({
    tiles,
    cols,
    rows,
    tileWidth,
    tileHeight,
    gap,
  })
  const map = tiles.map((tile, index) => ({
    candidate_id: tile.id,
    index,
    x: (index % cols) * (tileWidth + gap),
    y: Math.floor(index / cols) * (tileHeight + gap),
    width: tileWidth,
    height: tileHeight,
  }))
  return { sheet, rows, cols, gap, tileWidth, tileHeight, map }
}

export type ContactSheetSummary = NonNullable<IterationResult['contact_sheet']>

/** Composes a contact sheet of an iteration's tiles and writes it with its map. */
export async function writeIterationContactSheet(input: {
  jpegRuntime: LumaJpegNodeRuntime
  iterationStore: IterationStore
  iterationId: string
  tiles: SheetTile[]
  cols: number
  rows?: number
  gap?: number
  name?: string
}): Promise<{ summary: ContactSheetSummary; map: BuiltContactSheet['map'] }> {
  const built = buildContactSheet(input)
  const jpeg = (await encodePreviewFrameToJpeg(
    (options) => input.jpegRuntime.createEncoder(options),
    {
      rgba: built.sheet.rgba,
      width: built.sheet.width,
      height: built.sheet.height,
      quality: 0.85,
    },
  )) as Uint8Array
  const written = await input.iterationStore.writeContactSheet(
    input.iterationId,
    {
      name: input.name,
      jpeg,
      map: {
        schema: 'lmfg.contact-sheet-map.v1',
        iteration_id: input.iterationId,
        cols: built.cols,
        rows: built.rows,
        tile_width: built.tileWidth,
        tile_height: built.tileHeight,
        gap: built.gap,
        width: built.sheet.width,
        height: built.sheet.height,
        tiles: built.map,
      },
    },
  )
  return {
    summary: {
      uri: toFileUri(written.sheet),
      map_uri: toFileUri(written.map),
      width: built.sheet.width,
      height: built.sheet.height,
      cols: built.cols,
      rows: built.rows,
      tile_width: built.tileWidth,
      tile_height: built.tileHeight,
    },
    map: built.map,
  }
}
