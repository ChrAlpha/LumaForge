import type { ProcessingParams } from '@lumaforge/luma-color-runtime'
import type { CpuPreviewVariant } from '@lumaforge/render-engine/preview'
import { describe, expect, expectTypeOf, it } from 'vitest'

import type { GpuPreviewOutput } from '~/lib/webgpu/contract'

import type {
  PreviewSurfaceOutput,
  PreviewView,
  PreviewViewMode,
} from './preview-view'
import {
  cpuPreviewVariantForViewMode,
  DEFAULT_PREVIEW_VIEW,
  PREVIEW_VIEW_MODES,
  previewSurfaceOutputForViewMode,
} from './preview-view'

describe('preview view', () => {
  it('names the three modes the legacy params already use', () => {
    expect(PREVIEW_VIEW_MODES).toEqual(['processed', 'original', 'compare'])
    expect(Object.isFrozen(PREVIEW_VIEW_MODES)).toBe(true)
    // Legacy params may still carry a view mode; when they do it is one of
    // these, so a legacy record maps onto the app view without translation.
    expectTypeOf<PreviewViewMode>().toEqualTypeOf<
      NonNullable<ProcessingParams['viewMode']>
    >()
  })

  it('starts in compare at the middle split, as a new session does', () => {
    expect(DEFAULT_PREVIEW_VIEW).toEqual({ mode: 'compare', compareSplit: 0.5 })
    expect(Object.isFrozen(DEFAULT_PREVIEW_VIEW)).toBe(true)
  })

  it('holds only view state, no color and no viewport', () => {
    expectTypeOf<keyof PreviewView>().toEqualTypeOf<'mode' | 'compareSplit'>()
  })

  it('draws compare as a processed surface; the stage layers the original', () => {
    expect(
      PREVIEW_VIEW_MODES.map((mode) => [
        mode,
        previewSurfaceOutputForViewMode(mode),
      ]),
    ).toEqual([
      ['processed', 'processed'],
      ['original', 'technical-original'],
      ['compare', 'processed'],
    ])
  })

  it('selects an output the GPU executor accepts', () => {
    expectTypeOf<PreviewSurfaceOutput>().toEqualTypeOf<GpuPreviewOutput>()
  })

  it('maps original to the neutral CPU frame and everything else to processed', () => {
    expect(
      PREVIEW_VIEW_MODES.map((mode) => [
        mode,
        cpuPreviewVariantForViewMode(mode),
      ]),
    ).toEqual([
      ['processed', 'processed'],
      ['original', 'neutral'],
      ['compare', 'processed'],
    ])
    expectTypeOf(
      cpuPreviewVariantForViewMode,
    ).returns.toEqualTypeOf<CpuPreviewVariant>()
  })
})
