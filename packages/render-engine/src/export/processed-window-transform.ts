import type {
  LumaRawProcessedWindow,
  LumaRawWindowRect,
} from '@lumaforge/luma-raw-runtime'

const UINT16_MAX = 65535
const CHANNELS_PER_PIXEL = 3
const INVALID_PROCESSED_WINDOW = 'FULL_RES_EXPORT_INVALID_PROCESSED_WINDOW'

export type LinearProPhotoTile = {
  width: number
  height: number
  data: Float32Array
}

export type ProcessedRgb16Rows = {
  width: number
  height: number
  row: (index: number) => Uint16Array
}

function assertSafePositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function rectsMatch(left: LumaRawWindowRect, right: LumaRawWindowRect) {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  )
}

function assertValidProcessedWindow(
  window: LumaRawProcessedWindow,
  expectedRect: LumaRawWindowRect,
): number {
  if (
    window.workingSpace !== 'linear-prophoto-rgb' ||
    window.normalized !== false ||
    window.orientationApplied !== true ||
    window.colorApplied !== true ||
    !assertSafePositiveInteger(window.width) ||
    !assertSafePositiveInteger(window.height) ||
    window.width !== expectedRect.width ||
    window.height !== expectedRect.height ||
    window.stride !== window.width * CHANNELS_PER_PIXEL ||
    !rectsMatch(window.rect, expectedRect)
  ) {
    throw new Error(INVALID_PROCESSED_WINDOW)
  }

  const expectedLength = window.width * window.height * CHANNELS_PER_PIXEL
  if (
    !Number.isSafeInteger(expectedLength) ||
    expectedLength <= 0 ||
    window.data.length !== expectedLength
  ) {
    throw new Error(INVALID_PROCESSED_WINDOW)
  }

  return expectedLength
}

export function processedWindowToLinearProPhotoTile(
  window: LumaRawProcessedWindow,
  expectedRect: LumaRawWindowRect,
): LinearProPhotoTile {
  const expectedLength = assertValidProcessedWindow(window, expectedRect)
  const data = new Float32Array(expectedLength)
  for (let index = 0; index < expectedLength; index += 1) {
    data[index] = (window.data[index] ?? 0) / UINT16_MAX
  }

  return { width: window.width, height: window.height, data }
}

/**
 * The window as a flat linear ProPhoto RGB buffer plus the rect it covers.
 *
 * The geometry stage samples across rows rather than walking them in order, so
 * it needs the rect and the buffer together instead of a row accessor.
 */
export function processedWindowToSourceWindow(
  window: LumaRawProcessedWindow,
  expectedRect: LumaRawWindowRect,
): { rect: LumaRawWindowRect; data: Uint16Array } {
  assertValidProcessedWindow(window, expectedRect)

  return { rect: expectedRect, data: window.data }
}

export function processedWindowToRgb16Rows(
  window: LumaRawProcessedWindow,
  expectedRect: LumaRawWindowRect,
): ProcessedRgb16Rows {
  assertValidProcessedWindow(window, expectedRect)

  return {
    width: window.width,
    height: window.height,
    row(index) {
      if (!Number.isInteger(index) || index < 0 || index >= window.height) {
        throw new Error(INVALID_PROCESSED_WINDOW)
      }

      const start = index * window.stride
      return window.data.subarray(
        start,
        start + window.width * CHANNELS_PER_PIXEL,
      )
    },
  }
}
