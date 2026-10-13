import type {
  ColorGraphIntent,
  ProcessingParams,
} from '@lumaforge/luma-color-runtime'
import {
  NEUTRAL_SELECTIVE_COLOR,
  parseCubeLUT,
} from '@lumaforge/luma-color-runtime'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_PREVIEW_VIEW } from '~/lib/preview/preview-view'

import { getDetachedPreviewView } from '../state/preview-view.atoms'
import { getProcessingParams } from '../state/workflow.atoms'
import { resetToDefaults } from '../test-support/workflow-store'
import { useRawDetachedWorkflowState } from './useRawDetachedWorkflowState'

describe('useRawDetachedWorkflowState', () => {
  beforeEach(() => {
    act(() => {
      resetToDefaults()
    })
  })

  it('exposes pre-session color intent and LUT state through one hook', () => {
    const lut = parseCubeLUT(
      [
        'TITLE "Client Look"',
        'LUT_3D_SIZE 2',
        '0 0 0',
        '1 0 0',
        '0 1 0',
        '1 1 0',
        '0 0 1',
        '1 0 1',
        '0 1 1',
        '1 1 1',
      ].join('\n'),
      { sourceName: 'look.cube' },
    )

    const { result } = renderHook(() => useRawDetachedWorkflowState())

    expect(result.current.colorIntent.styleKind).toBe('none')
    expect(result.current.lut).toBeNull()

    act(() => {
      result.current.setColorIntent((prev) => ({
        ...prev,
        styleKind: 'custom',
      }))
      result.current.setLut(lut)
    })

    expect(result.current.colorIntent.styleKind).toBe('custom')
    expect(result.current.lut).toBe(lut)
  })

  it('starts from a strict neutral intent with the app look strength and the default sample view', () => {
    const { result } = renderHook(() => useRawDetachedWorkflowState())

    expect(result.current.colorIntent).toEqual({
      styleKind: 'none',
      builtinPreset: null,
      intensity: 0.7,
      userExposureEv: 0,
      userContrast: 0,
      userHighlights: 0,
      userShadows: 0,
      userWhites: 0,
      userBlacks: 0,
      userTemperature: 0,
      userTint: 0,
      userSaturation: 0,
      userVibrance: 0,
      selectiveColor: NEUTRAL_SELECTIVE_COLOR,
    })
    expect(result.current.colorIntent).not.toHaveProperty('viewMode')
    expect(result.current.colorIntent).not.toHaveProperty('compareSplit')
    expect(result.current.detachedView).toEqual(DEFAULT_PREVIEW_VIEW)
  })

  it('hands updaters the stored intent alone and never stores view fields', () => {
    const { result } = renderHook(() => useRawDetachedWorkflowState())
    let seen: ColorGraphIntent | null = null

    act(() => {
      result.current.setDetachedView({ mode: 'original', compareSplit: 0.3 })
    })
    act(() => {
      result.current.setColorIntent((prev) => {
        seen = prev
        return { ...prev, intensity: 0.43, userContrast: 12 }
      })
    })

    expect(seen).not.toHaveProperty('viewMode')
    expect(seen).not.toHaveProperty('compareSplit')
    expect(result.current.colorIntent).toMatchObject({
      intensity: 0.43,
      userContrast: 12,
    })
    expect(result.current.detachedView).toEqual({
      mode: 'original',
      compareSplit: 0.3,
    })

    // A record that still carries view fields is copied down to its color.
    const mixed = {
      ...result.current.colorIntent,
      viewMode: 'processed',
      compareSplit: 0.9,
    } as ProcessingParams
    act(() => {
      result.current.setColorIntent(mixed as unknown as ColorGraphIntent)
    })

    expect(result.current.colorIntent).toMatchObject({
      intensity: 0.43,
      userContrast: 12,
    })
    expect(result.current.colorIntent).not.toHaveProperty('viewMode')
    expect(result.current.colorIntent).not.toHaveProperty('compareSplit')
    expect(result.current.detachedView).toEqual({
      mode: 'original',
      compareSplit: 0.3,
    })
  })

  it('stores a continuous strength exactly', () => {
    const { result } = renderHook(() => useRawDetachedWorkflowState())

    act(() => {
      result.current.setColorIntent((prev) => ({ ...prev, intensity: 0.37 }))
    })
    expect(getProcessingParams().intensity).toBe(0.37)

    act(() => {
      result.current.setColorIntent((prev) => ({ ...prev, intensity: 0.62 }))
    })
    expect(getProcessingParams().intensity).toBe(0.62)
  })

  it('keeps the stored intent when an updater returns its input', () => {
    const { result } = renderHook(() => useRawDetachedWorkflowState())
    const before = result.current.colorIntent

    act(() => {
      result.current.setColorIntent((prev) => prev)
    })

    expect(result.current.colorIntent).toBe(before)
    expect(getProcessingParams()).toBe(before)
  })

  it('keeps the color intent reference across view-only updates', () => {
    const { result } = renderHook(() => useRawDetachedWorkflowState())
    const before = result.current.colorIntent

    act(() => {
      result.current.setDetachedView({ mode: 'processed', compareSplit: 0.15 })
    })

    expect(result.current.detachedView).toEqual({
      mode: 'processed',
      compareSplit: 0.15,
    })
    expect(result.current.colorIntent).toBe(before)
  })

  it('resets the color intent and the sample view together', () => {
    const { result } = renderHook(() => useRawDetachedWorkflowState())

    act(() => {
      result.current.setDetachedView({ mode: 'original', compareSplit: 0.2 })
      result.current.setColorIntent((prev) => ({ ...prev, intensity: 0.33 }))
    })
    act(() => {
      resetToDefaults()
    })

    expect(getDetachedPreviewView()).toEqual(DEFAULT_PREVIEW_VIEW)
    expect(result.current.colorIntent.intensity).toBe(0.7)
  })
})
