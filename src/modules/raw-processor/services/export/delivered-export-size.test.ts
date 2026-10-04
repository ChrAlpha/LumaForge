import { describe, expect, it } from 'vitest'

import { resolveDeliveredExportSize } from './delivered-export-size'

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1]

describe('resolveDeliveredExportSize', () => {
  it('reports nothing until full resolution has been probed', () => {
    for (const status of ['unknown', 'probing'] as const) {
      expect(
        resolveDeliveredExportSize({
          fullResCapability: { status },
          exportGeometry: null,
        }),
      ).toBeNull()
    }
    expect(
      resolveDeliveredExportSize({
        fullResCapability: { status: 'unsupported', reason: 'no' },
        exportGeometry: null,
      }),
    ).toBeNull()
    expect(
      resolveDeliveredExportSize({
        fullResCapability: undefined,
        exportGeometry: null,
      }),
    ).toBeNull()
  })

  it('is the probed source size without a Transform', () => {
    expect(
      resolveDeliveredExportSize({
        fullResCapability: { status: 'supported', width: 9728, height: 6656 },
        exportGeometry: null,
      }),
    ).toEqual({ width: 9728, height: 6656 })
  })

  it('follows the committed Transform geometry', () => {
    expect(
      resolveDeliveredExportSize({
        fullResCapability: { status: 'supported', width: 6000, height: 4000 },
        exportGeometry: { matrix: IDENTITY, constrainCrop: true },
      }),
    ).toEqual({ width: 6000, height: 4000 })

    // A rotation constrained to the frame crops the matte corners away,
    // keeping the frame's aspect.
    const c = Math.cos(0.1)
    const s = Math.sin(0.1)
    const rotated = resolveDeliveredExportSize({
      fullResCapability: { status: 'supported', width: 6000, height: 4000 },
      exportGeometry: {
        matrix: [
          c,
          -s,
          0.5 - 0.5 * c + 0.5 * s,
          s,
          c,
          0.5 - 0.5 * s - 0.5 * c,
          0,
          0,
          1,
        ],
        constrainCrop: true,
      },
    })
    expect(rotated!.width).toBeLessThan(6000)
    expect(rotated!.width / rotated!.height).toBeCloseTo(1.5, 2)
  })

  it('states no size for a geometry the export would reject', () => {
    expect(
      resolveDeliveredExportSize({
        fullResCapability: { status: 'supported', width: 6000, height: 4000 },
        exportGeometry: {
          matrix: [0, 0, 0, 0, 0, 0, 0, 0, 0],
          constrainCrop: true,
        },
      }),
    ).toBeNull()
  })
})
