import type { CpuPreviewVariant } from '@lumaforge/render-engine/preview'
import { describe, expect, expectTypeOf, it } from 'vitest'

import type { PreviewView, PreviewViewMode } from './preview-view'
import {
  cpuPreviewVariantForViewMode,
  DEFAULT_PREVIEW_VIEW,
  previewSurfaceOutputForViewMode,
} from './preview-view'

const VIEW_MODES: readonly PreviewViewMode[] = [
  'processed',
  'original',
  'compare',
]

describe('preview view', () => {
  it('names the three view modes', () => {
    expectTypeOf<PreviewViewMode>().toEqualTypeOf<
      'processed' | 'original' | 'compare'
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
      VIEW_MODES.map((mode) => [mode, previewSurfaceOutputForViewMode(mode)]),
    ).toEqual([
      ['processed', 'processed'],
      ['original', 'technical-original'],
      ['compare', 'processed'],
    ])
  })

  it('maps original to the neutral CPU frame and everything else to processed', () => {
    expect(
      VIEW_MODES.map((mode) => [mode, cpuPreviewVariantForViewMode(mode)]),
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
