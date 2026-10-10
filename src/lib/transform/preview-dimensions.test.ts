import { describe, expect, it } from 'vitest'

import { previewDimensions } from '~/lib/transform/preview-dimensions'
import {
  ImageInputError,
  MAX_PREVIEW_EDGE,
} from '~/lib/transform/preview-types'

describe('transform preview dimensions', () => {
  it('bounds landscape and portrait previews without upscaling', () => {
    expect(previewDimensions(6000, 4000)).toEqual({ width: 1600, height: 1067 })
    expect(previewDimensions(4000, 6000)).toEqual({ width: 1067, height: 1600 })
    expect(previewDimensions(640, 480)).toEqual({ width: 640, height: 480 })
  })

  it('keeps the long edge at the preview bound and never collapses an edge', () => {
    expect(previewDimensions(MAX_PREVIEW_EDGE, 10)).toEqual({
      width: MAX_PREVIEW_EDGE,
      height: 10,
    })
    expect(previewDimensions(100_000, 1)).toEqual({
      width: MAX_PREVIEW_EDGE,
      height: 1,
    })
  })

  it('rejects non-finite and empty dimensions as a decode failure', () => {
    for (const [width, height] of [
      [Infinity, 10],
      [10, Number.NaN],
      [0, 10],
      [10, 0.5],
    ] as const) {
      let failure: unknown
      try {
        previewDimensions(width, height)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(ImageInputError)
      const code = (failure as ImageInputError).code
      expect(code).toBe('decode')
      // Literal-code assertion: the only production-thrown value.
      const _check: 'decode' = code
    }
  })
})
