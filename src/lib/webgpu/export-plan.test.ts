import type { PerformancePreference } from '@lumaforge/render-engine/policy'
import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  createExportTiles,
  cropRawUploadInput,
  ExportRenderError,
  getExportRenderOptionsForPreference,
  planExportRenderTarget,
} from './export-plan'

const PREFERENCES: readonly PerformancePreference[] = [
  'safe',
  'balanced',
  'max',
]

describe('export render target planner', () => {
  it('uses a full-frame render when GPU and canvas limits can hold the image', () => {
    expect(
      planExportRenderTarget({
        width: 4000,
        height: 3000,
        maxTextureSize: 8192,
        maxCanvasSize: 16384,
        maxCanvasPixels: 120_000_000,
        memoryBudgetBytes: 768 * 1024 * 1024,
      }),
    ).toEqual({
      strategy: 'full-frame',
      width: 4000,
      height: 3000,
    })
  })

  it('tiles when the export fits canvas limits but exceeds full-frame GPU texture size', () => {
    const plan = planExportRenderTarget({
      width: 9000,
      height: 6000,
      maxTextureSize: 4096,
      maxCanvasSize: 16384,
      maxCanvasPixels: 120_000_000,
      memoryBudgetBytes: 768 * 1024 * 1024,
    })

    expect(plan).toMatchObject({
      strategy: 'tiled',
      width: 9000,
      height: 6000,
      reason: 'texture-limit',
      tileWidth: 4096,
      tileHeight: 4096,
    })
  })

  it('tiles when a full-frame render exceeds the practical memory budget', () => {
    const plan = planExportRenderTarget({
      width: 7000,
      height: 5000,
      maxTextureSize: 8192,
      maxCanvasSize: 16384,
      maxCanvasPixels: 120_000_000,
      memoryBudgetBytes: 256 * 1024 * 1024,
    })

    expect(plan).toMatchObject({
      strategy: 'tiled',
      width: 7000,
      height: 5000,
      reason: 'memory-budget',
    })
    expect(plan.strategy === 'tiled' ? plan.tileWidth : 0).toBeLessThan(7000)
  })

  it('fails closed when the output canvas itself cannot hold the export', () => {
    expect(
      planExportRenderTarget({
        width: 20000,
        height: 12000,
        maxTextureSize: 8192,
        maxCanvasSize: 16384,
        maxCanvasPixels: 120_000_000,
        memoryBudgetBytes: 768 * 1024 * 1024,
      }),
    ).toEqual({
      strategy: 'fail',
      width: 20000,
      height: 12000,
      reason: 'canvas-limit',
      retryable: true,
    })
  })

  it('fails closed when no viable tile can fit the GPU budget', () => {
    expect(
      planExportRenderTarget({
        width: 1024,
        height: 1024,
        maxTextureSize: 0,
        maxCanvasSize: 16384,
        maxCanvasPixels: 120_000_000,
        memoryBudgetBytes: 768 * 1024 * 1024,
      }),
    ).toEqual({
      strategy: 'fail',
      width: 1024,
      height: 1024,
      reason: 'gpu-limit',
      retryable: false,
    })
  })

  it('creates typed retryable errors from failed render plans', () => {
    const error = ExportRenderError.fromFailedPlan({
      strategy: 'fail',
      width: 20000,
      height: 12000,
      reason: 'canvas-limit',
      retryable: true,
    })

    expect(error).toMatchObject({
      code: 'EXPORT_CANVAS_LIMIT_EXCEEDED',
      retryable: true,
      width: 20000,
      height: 12000,
    })
    expect(error.message).toBe('EXPORT_CANVAS_LIMIT_EXCEEDED')
  })

  it('maps performance preferences to explicit export planning budgets', () => {
    const safe = getExportRenderOptionsForPreference('safe')
    const balanced = getExportRenderOptionsForPreference('balanced')
    const max = getExportRenderOptionsForPreference('max')

    expect(safe.memoryBudgetBytes).toBeLessThan(balanced.memoryBudgetBytes)
    expect(balanced.memoryBudgetBytes).toBeLessThan(max.memoryBudgetBytes)
    expect(safe.maxCanvasPixels).toBeLessThan(balanced.maxCanvasPixels)
    expect(balanced.maxCanvasPixels).toBeLessThan(max.maxCanvasPixels)
  })

  it('accepts the engine performance preference as its planning key', () => {
    expectTypeOf(getExportRenderOptionsForPreference)
      .parameter(0)
      .toEqualTypeOf<PerformancePreference>()
  })

  it('keeps the exact planning budget for every performance preference', () => {
    const budgets = Object.fromEntries(
      PREFERENCES.map((preference) => [
        preference,
        getExportRenderOptionsForPreference(preference),
      ]),
    )

    expect(budgets).toEqual({
      safe: {
        maxCanvasSize: 8192,
        maxCanvasPixels: 50_000_000,
        memoryBudgetBytes: 256 * 1024 * 1024,
        renderBytesPerPixel: 32,
      },
      balanced: {
        maxCanvasSize: 12000,
        maxCanvasPixels: 80_000_000,
        memoryBudgetBytes: 512 * 1024 * 1024,
        renderBytesPerPixel: 32,
      },
      max: {
        maxCanvasSize: 16_384,
        maxCanvasPixels: 120_000_000,
        memoryBudgetBytes: 768 * 1024 * 1024,
        renderBytesPerPixel: 32,
      },
    })
  })

  it('returns a fresh budget copy so callers cannot mutate the shared table', () => {
    const first = getExportRenderOptionsForPreference('safe')
    first.memoryBudgetBytes = 1

    expect(getExportRenderOptionsForPreference('safe')).not.toBe(first)
    expect(getExportRenderOptionsForPreference('safe').memoryBudgetBytes).toBe(
      256 * 1024 * 1024,
    )
  })

  it.each([
    {
      size: '4000x3000',
      width: 4000,
      height: 3000,
      expected: {
        safe: {
          strategy: 'tiled',
          width: 4000,
          height: 3000,
          tileWidth: 2896,
          tileHeight: 2896,
          reason: 'memory-budget',
        },
        balanced: { strategy: 'full-frame', width: 4000, height: 3000 },
        max: { strategy: 'full-frame', width: 4000, height: 3000 },
      },
    },
    {
      size: '9000x6000',
      width: 9000,
      height: 6000,
      expected: {
        safe: {
          strategy: 'fail',
          width: 9000,
          height: 6000,
          reason: 'canvas-limit',
          retryable: true,
        },
        balanced: {
          strategy: 'tiled',
          width: 9000,
          height: 6000,
          tileWidth: 4096,
          tileHeight: 4096,
          reason: 'texture-limit',
        },
        max: {
          strategy: 'tiled',
          width: 9000,
          height: 6000,
          tileWidth: 5016,
          tileHeight: 5016,
          reason: 'texture-limit',
        },
      },
    },
    {
      size: '11000x8000',
      width: 11000,
      height: 8000,
      expected: {
        safe: {
          strategy: 'fail',
          width: 11000,
          height: 8000,
          reason: 'canvas-limit',
          retryable: true,
        },
        balanced: {
          strategy: 'fail',
          width: 11000,
          height: 8000,
          reason: 'canvas-limit',
          retryable: true,
        },
        max: {
          strategy: 'tiled',
          width: 11000,
          height: 8000,
          tileWidth: 5016,
          tileHeight: 5016,
          reason: 'texture-limit',
        },
      },
    },
  ])(
    'plans a $size snapshot per performance preference on an 8192 texture limit',
    ({ width, height, expected }) => {
      for (const preference of PREFERENCES) {
        expect(
          planExportRenderTarget({
            width,
            height,
            maxTextureSize: 8192,
            ...getExportRenderOptionsForPreference(preference),
          }),
        ).toEqual(expected[preference])
      }
    },
  )

  it('refuses a GPU without a viable tile under every performance preference', () => {
    for (const preference of PREFERENCES) {
      expect(
        planExportRenderTarget({
          width: 1024,
          height: 1024,
          maxTextureSize: 128,
          ...getExportRenderOptionsForPreference(preference),
        }),
      ).toEqual({
        strategy: 'fail',
        width: 1024,
        height: 1024,
        reason: 'gpu-limit',
        retryable: false,
      })
    }
  })
})

describe('tiled RGB16 source crops', () => {
  const source = {
    data: Uint16Array.from({ length: 3 * 2 * 3 }, (_, index) => index),
    width: 3,
    height: 2,
    layout: 'rgb-u16' as const,
    colorSpace: 'linear-prophoto-rgb' as const,
    renderExposureEv: 1,
    renderExposureMultiplier: 2,
  }

  it('copies exact RGB16 rows and keeps the source exposure', () => {
    const crop = cropRawUploadInput(source, { x: 1, y: 0, width: 2, height: 2 })
    expect(crop).toEqual({
      ...source,
      width: 2,
      height: 2,
      data: new Uint16Array([3, 4, 5, 6, 7, 8, 12, 13, 14, 15, 16, 17]),
    })
    expect(crop.data.buffer).not.toBe(source.data.buffer)
  })

  it('reassembles the source from its tiles', () => {
    const tiles = createExportTiles({
      width: 3,
      height: 2,
      tileWidth: 2,
      tileHeight: 1,
    })
    const restored = new Uint16Array(source.data.length)
    for (const tile of tiles) {
      const crop = cropRawUploadInput(source, tile)
      for (let row = 0; row < tile.height; row++)
        restored.set(
          crop.data.subarray(row * tile.width * 3, (row + 1) * tile.width * 3),
          ((tile.y + row) * source.width + tile.x) * 3,
        )
    }
    expect(restored).toEqual(source.data)
  })

  it('refuses tiles outside the source', () => {
    expect(() =>
      cropRawUploadInput(source, { x: 2, y: 0, width: 2, height: 1 }),
    ).toThrow('EXPORT_TILE_OUT_OF_BOUNDS')
  })
})
