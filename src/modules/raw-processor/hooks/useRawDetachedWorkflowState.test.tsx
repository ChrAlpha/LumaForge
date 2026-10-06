import type { ProcessingParams } from '@lumaforge/luma-color-runtime'
import { NEUTRAL_SELECTIVE_COLOR } from '@lumaforge/luma-color-runtime'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { parseCubeLUT } from '~/lib/lut/cube-parser'
import { DEFAULT_PREVIEW_VIEW } from '~/lib/preview/preview-view'

import { getDetachedPreviewView } from '../state/preview-view.atoms'
import { getProcessingParams, resetToDefaults } from '../state/workflow.atoms'
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
      result.current.setParams((prev) => ({
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

  it('shows combined-record updaters the detached view but stores only color', () => {
    const { result } = renderHook(() => useRawDetachedWorkflowState())
    let seen: ProcessingParams | null = null

    act(() => {
      result.current.setDetachedView({ mode: 'original', compareSplit: 0.3 })
    })
    act(() => {
      result.current.setParams((prev) => {
        seen = prev
        return {
          ...prev,
          viewMode: 'processed',
          compareSplit: 0.9,
          intensity: 0.43,
          userContrast: 12,
        }
      })
    })

    expect(seen).toMatchObject({ viewMode: 'original', compareSplit: 0.3 })
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

  it('keeps the stored intent when an updater returns its input', () => {
    const { result } = renderHook(() => useRawDetachedWorkflowState())
    const before = result.current.colorIntent

    act(() => {
      result.current.setParams((prev) => prev)
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
      result.current.setParams((prev) => ({ ...prev, intensity: 0.33 }))
    })
    act(() => {
      resetToDefaults()
    })

    expect(getDetachedPreviewView()).toEqual(DEFAULT_PREVIEW_VIEW)
    expect(result.current.colorIntent.intensity).toBe(0.7)
  })
})
