import type { LumaRawProcessedWindow } from '@lumaforge/luma-raw-runtime'
import { describe, expect, it } from 'vitest'

import { processedWindowToRgb16Rows } from './processed-window-transform'

function makeWindow(
  overrides: Partial<LumaRawProcessedWindow> = {},
): LumaRawProcessedWindow {
  return {
    rect: { x: 0, y: 0, width: 2, height: 1 },
    workingSpace: 'linear-prophoto-rgb',
    data: new Uint16Array([0, 32768, 65535, 65535, 0, 32768]),
    width: 2,
    height: 1,
    stride: 6,
    normalized: false,
    orientationApplied: true,
    colorApplied: true,
    warnings: [],
    ...overrides,
  }
}

const dimensionMismatchCases: Array<[string, Partial<LumaRawProcessedWindow>]> =
  [
    [
      'with a width mismatch',
      {
        rect: { x: 0, y: 0, width: 2, height: 1 },
        width: 1,
        stride: 3,
        data: new Uint16Array(3),
      },
    ],
    [
      'with a height mismatch',
      {
        rect: { x: 0, y: 0, width: 2, height: 1 },
        height: 2,
        data: new Uint16Array(12),
      },
    ],
  ]

describe('processedWindowToRgb16Rows', () => {
  it('returns validated processed-window row views without allocating Float32', () => {
    const window = makeWindow({
      rect: { x: 0, y: 0, width: 2, height: 2 },
      data: new Uint16Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
      width: 2,
      height: 2,
      stride: 6,
    })

    const rows = processedWindowToRgb16Rows(window, window.rect)
    const firstRow = rows.row(0)
    const secondRow = rows.row(1)

    expect(rows.width).toBe(2)
    expect(rows.height).toBe(2)
    expect(firstRow.buffer).toBe(window.data.buffer)
    expect(firstRow.byteOffset).toBe(window.data.byteOffset)
    expect(secondRow.buffer).toBe(window.data.buffer)
    expect(secondRow).toEqual(new Uint16Array([7, 8, 9, 10, 11, 12]))
  })

  it.each([-1, 2, 0.5, Number.NaN, Infinity])(
    'rejects invalid row index %s',
    (index) => {
      const rows = processedWindowToRgb16Rows(
        makeWindow({
          rect: { x: 0, y: 0, width: 2, height: 2 },
          data: new Uint16Array(12),
          height: 2,
        }),
        { x: 0, y: 0, width: 2, height: 2 },
      )

      expect(() => rows.row(index)).toThrow(
        'FULL_RES_EXPORT_INVALID_PROCESSED_WINDOW',
      )
    },
  )

  it.each([
    ['not oriented', { orientationApplied: false }],
    ['not color-applied', { colorApplied: false }],
    ['in the wrong working space', { workingSpace: 'display-srgb-preview' }],
    ['already normalized', { normalized: true }],
    ['a stride mismatch', { stride: 5 }],
    ['a data length mismatch', { data: new Uint16Array(5) }],
    ['unsafe dimensions', { width: Number.MAX_SAFE_INTEGER, height: 2 }],
    ...dimensionMismatchCases,
  ])('rejects processed windows %s', (_name, overrides) => {
    expect(() =>
      processedWindowToRgb16Rows(
        makeWindow(overrides as Partial<LumaRawProcessedWindow>),
        { x: 0, y: 0, width: 2, height: 1 },
      ),
    ).toThrow('FULL_RES_EXPORT_INVALID_PROCESSED_WINDOW')
  })

  it('rejects processed windows whose rect does not match the requested output rect', () => {
    expect(() =>
      processedWindowToRgb16Rows(makeWindow(), {
        x: 0,
        y: 1,
        width: 2,
        height: 1,
      }),
    ).toThrow('FULL_RES_EXPORT_INVALID_PROCESSED_WINDOW')
  })
})
