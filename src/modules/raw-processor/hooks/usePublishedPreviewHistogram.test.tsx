import type {
  ColorGraphIntent,
  PreviewHistogramState,
  ReadyPreviewHistogram,
} from '@lumaforge/luma-color-runtime'
import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { jotaiStore } from '~/lib/jotai'
import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'

import {
  NO_IMAGE_HISTOGRAM,
  previewHistogramStateAtom,
} from '../state/histogram.atoms'
import { usePreviewHistogram } from './usePreviewHistogram'
import type { PreviewHistogramSource } from './usePublishedPreviewHistogram'
import { usePublishedPreviewHistogram } from './usePublishedPreviewHistogram'

vi.mock('./usePreviewHistogram', () => ({ usePreviewHistogram: vi.fn() }))

const params: ColorGraphIntent = {
  ...NEUTRAL_USER_COLOR_INTENT,
  intensity: 0.7,
  styleKind: 'none',
  builtinPreset: null,
}

const ready = { state: 'ready', source: 'quick' } as ReadyPreviewHistogram

function source(
  overrides: Partial<PreviewHistogramSource> = {},
): PreviewHistogramSource {
  return {
    decodedImageRef: { current: null },
    decodedFrame: null,
    params,
    lutData: null,
    displaySource: 'none',
    ...overrides,
  }
}

function measures(state: PreviewHistogramState) {
  vi.mocked(usePreviewHistogram).mockReturnValue(state)
}

afterEach(() => {
  jotaiStore.set(previewHistogramStateAtom, NO_IMAGE_HISTOGRAM)
  vi.mocked(usePreviewHistogram).mockReset()
})

describe('usePublishedPreviewHistogram', () => {
  it('measures the workflow frame descriptor itself, with its look', () => {
    measures(NO_IMAGE_HISTOGRAM)
    const frame = { sessionId: 'session-a' } as DecodedPreviewFrame
    const input = source({ decodedFrame: frame, displaySource: 'quick' })

    renderHook(() => usePublishedPreviewHistogram(input))

    const call = vi.mocked(usePreviewHistogram).mock.lastCall?.[0]
    expect(call?.frame).toBe(frame)
    expect(call?.params).toBe(params)
    expect(call?.imageRef).toBe(input.decodedImageRef)
    expect(call?.displaySource).toBe('quick')
  })

  it('publishes each result, and the no-image state once it unmounts', () => {
    measures(ready)
    const { unmount } = renderHook(() => usePublishedPreviewHistogram(source()))
    expect(jotaiStore.get(previewHistogramStateAtom)).toBe(ready)

    unmount()
    expect(jotaiStore.get(previewHistogramStateAtom)).toBe(NO_IMAGE_HISTOGRAM)
  })

  it('keeps a stale state over the same bins instead of republishing it', () => {
    const stale: PreviewHistogramState = { state: 'stale', previous: ready }
    measures(stale)
    const { rerender } = renderHook(() =>
      usePublishedPreviewHistogram(source()),
    )
    const subscriber = vi.fn()
    const unsubscribe = jotaiStore.sub(previewHistogramStateAtom, subscriber)

    measures({ state: 'stale', previous: ready })
    rerender()
    expect(jotaiStore.get(previewHistogramStateAtom)).toBe(stale)
    expect(subscriber).not.toHaveBeenCalled()

    measures(ready)
    rerender()
    expect(jotaiStore.get(previewHistogramStateAtom)).toBe(ready)
    expect(subscriber).toHaveBeenCalledOnce()
    unsubscribe()
  })
})
