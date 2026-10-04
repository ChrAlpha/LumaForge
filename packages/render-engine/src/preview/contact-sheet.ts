// Contact-sheet composition.
//
// CPU-only grid composer. Takes N RGBA tiles + a grid spec, paints them
// into one big RGBA buffer that callers can hand to
// `encodePreviewFrameToJpeg` for an agent-visible thumbnail of an entire
// candidate sweep.

export type ContactSheetTile = {
  /** RGBA8. Length must be `width * height * 4`. */
  readonly rgba: Uint8ClampedArray | Uint8Array
  readonly width: number
  readonly height: number
}

export type ComposeContactSheetInput = {
  readonly tiles: readonly ContactSheetTile[]
  readonly cols: number
  readonly rows: number
  /** Per-tile target width/height inside the sheet (no resampling at v1 — tiles must already be this size). */
  readonly tileWidth: number
  readonly tileHeight: number
  /** Gap between tiles in pixels. Default 0. */
  readonly gap?: number
  /** Background RGB fill for empty cells. Default opaque black [0,0,0]. */
  readonly background?: readonly [number, number, number]
}

export type ContactSheet = {
  readonly width: number
  readonly height: number
  readonly rgba: Uint8ClampedArray
}

export function composeContactSheet(
  input: ComposeContactSheetInput,
): ContactSheet {
  const { tiles, cols, rows, tileWidth, tileHeight } = input
  if (
    !Number.isInteger(cols) ||
    cols <= 0 ||
    !Number.isInteger(rows) ||
    rows <= 0
  ) {
    throw new Error('CONTACT_SHEET_INVALID_GRID')
  }
  if (
    !Number.isInteger(tileWidth) ||
    tileWidth <= 0 ||
    !Number.isInteger(tileHeight) ||
    tileHeight <= 0
  ) {
    throw new Error('CONTACT_SHEET_INVALID_TILE_SIZE')
  }
  const gap = Math.max(0, Math.floor(input.gap ?? 0))
  const bg = input.background ?? [0, 0, 0]

  const sheetWidth = cols * tileWidth + (cols - 1) * gap
  const sheetHeight = rows * tileHeight + (rows - 1) * gap
  const rgba = new Uint8ClampedArray(sheetWidth * sheetHeight * 4)
  // Pre-fill background (opaque)
  for (let p = 0; p < sheetWidth * sheetHeight; p += 1) {
    const d = p * 4
    rgba[d + 0] = bg[0]
    rgba[d + 1] = bg[1]
    rgba[d + 2] = bg[2]
    rgba[d + 3] = 255
  }

  const cellCount = cols * rows
  const tileCount = Math.min(tiles.length, cellCount)
  for (let i = 0; i < tileCount; i += 1) {
    const tile = tiles[i]
    if (tile.width !== tileWidth || tile.height !== tileHeight) {
      throw new Error('CONTACT_SHEET_TILE_SIZE_MISMATCH')
    }
    if (tile.rgba.length !== tileWidth * tileHeight * 4) {
      throw new Error('CONTACT_SHEET_TILE_BUFFER_MISMATCH')
    }
    const col = i % cols
    const row = Math.floor(i / cols)
    const dstX = col * (tileWidth + gap)
    const dstY = row * (tileHeight + gap)
    blitTile(rgba, sheetWidth, dstX, dstY, tile)
  }

  return { width: sheetWidth, height: sheetHeight, rgba }
}

function blitTile(
  dst: Uint8ClampedArray,
  dstWidth: number,
  dstX: number,
  dstY: number,
  tile: ContactSheetTile,
): void {
  for (let y = 0; y < tile.height; y += 1) {
    const srcRowOffset = y * tile.width * 4
    const dstRowOffset = ((dstY + y) * dstWidth + dstX) * 4
    for (let x = 0; x < tile.width; x += 1) {
      const s = srcRowOffset + x * 4
      const d = dstRowOffset + x * 4
      dst[d + 0] = tile.rgba[s + 0]
      dst[d + 1] = tile.rgba[s + 1]
      dst[d + 2] = tile.rgba[s + 2]
      dst[d + 3] = tile.rgba[s + 3]
    }
  }
}
