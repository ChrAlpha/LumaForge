import type {
  ColorGraphIntent,
  HSLBandId,
  HSLBandShift,
} from '@lumaforge/luma-color-runtime'
import {
  makeNeutralBand,
  NEUTRAL_USER_COLOR_INTENT,
} from '@lumaforge/luma-color-runtime'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

import {
  getProcessingParams,
  resetToDefaults,
} from '../../../state/workflow.atoms'
import { useRawDetachedWorkflowState } from '../../useRawDetachedWorkflowState'
import { useRawAdjustmentActions } from './useRawAdjustmentActions'

const BAND_IDS: readonly HSLBandId[] = [
  'red',
  'orange',
  'yellow',
  'green',
  'aqua',
  'blue',
  'purple',
  'magenta',
]

function makeNeutralSelectiveColorFixture(): Record<HSLBandId, HSLBandShift> {
  return {
    red: makeNeutralBand(),
    orange: makeNeutralBand(),
    yellow: makeNeutralBand(),
    green: makeNeutralBand(),
    aqua: makeNeutralBand(),
    blue: makeNeutralBand(),
    purple: makeNeutralBand(),
    magenta: makeNeutralBand(),
  }
}

const baseParams: ColorGraphIntent = {
  ...NEUTRAL_USER_COLOR_INTENT,
  intensity: 0.7,
  styleKind: 'none',
  builtinPreset: null,
}

type ColorIntentUpdate =
  | ColorGraphIntent
  | ((prev: ColorGraphIntent) => ColorGraphIntent)

type MutableParamsRef = {
  current: ColorGraphIntent
}

function createParamsHarness(initial: ColorGraphIntent) {
  const ref: MutableParamsRef = { current: initial }
  const setColorIntent = vi.fn((value: ColorIntentUpdate) => {
    ref.current = typeof value === 'function' ? value(ref.current) : value
  })
  return { ref, setColorIntent }
}

type AdjustmentActions = ReturnType<typeof useRawAdjustmentActions>

describe('useRawAdjustmentActions', () => {
  it('patches the complete color intent', () => {
    expectTypeOf<
      Parameters<typeof useRawAdjustmentActions>[0]['params']
    >().toEqualTypeOf<ColorGraphIntent>()
    expectTypeOf<AdjustmentActions['setToneParams']>()
      .parameter(0)
      .toEqualTypeOf<
        Partial<
          Pick<
            ColorGraphIntent,
            | 'userExposureEv'
            | 'userContrast'
            | 'userHighlights'
            | 'userShadows'
            | 'userWhites'
            | 'userBlacks'
          >
        >
      >()
    expectTypeOf<AdjustmentActions['setColorParams']>()
      .parameter(0)
      .toEqualTypeOf<
        Partial<
          Pick<
            ColorGraphIntent,
            'userTemperature' | 'userTint' | 'userSaturation' | 'userVibrance'
          >
        >
      >()
  })

  it('writes a color patch to the color intent and invalidates a changed graph', () => {
    const { ref, setColorIntent } = createParamsHarness(baseParams)
    const invalidateExportGraph = vi.fn()
    const { result } = renderHook(() =>
      useRawAdjustmentActions({
        params: baseParams,
        setColorIntent,
        invalidateExportGraph,
      }),
    )

    act(() => {
      result.current.setParams({ userExposureEv: 1, intensity: 0.37 })
    })

    expect(setColorIntent).toHaveBeenCalledTimes(1)
    expect(ref.current).toEqual({
      ...baseParams,
      userExposureEv: 1,
      intensity: 0.37,
    })
    expect(invalidateExportGraph).toHaveBeenCalledTimes(1)
  })

  it('drops fields outside the color intent from a patch', () => {
    const { ref, setColorIntent } = createParamsHarness(baseParams)
    const invalidateExportGraph = vi.fn()
    const { result } = renderHook(() =>
      useRawAdjustmentActions({
        params: baseParams,
        setColorIntent,
        invalidateExportGraph,
      }),
    )
    // An untyped caller can still hand over a wider record.
    const widePatch = {
      userContrast: 20,
      rawRenderExposure: { ev: 1, multiplier: 2, source: 'auto' },
    } as unknown as Partial<ColorGraphIntent>

    act(() => {
      result.current.setParams(widePatch)
    })

    expect(ref.current).toEqual({ ...baseParams, userContrast: 20 })
    expect(ref.current).not.toHaveProperty('rawRenderExposure')
    expect(invalidateExportGraph).toHaveBeenCalledTimes(1)
  })

  it('leaves the color intent and the export alone for a patch without color fields', () => {
    const { ref, setColorIntent } = createParamsHarness(baseParams)
    const invalidateExportGraph = vi.fn()
    const { result } = renderHook(() =>
      useRawAdjustmentActions({
        params: baseParams,
        setColorIntent,
        invalidateExportGraph,
      }),
    )
    const foreignOnly = {
      compareSplit: 0.8,
    } as unknown as Partial<ColorGraphIntent>

    act(() => {
      result.current.setParams(foreignOnly)
    })

    expect(setColorIntent).not.toHaveBeenCalled()
    expect(ref.current).toBe(baseParams)
    expect(invalidateExportGraph).not.toHaveBeenCalled()
  })

  describe('over the stored intent', () => {
    beforeEach(() => {
      act(() => {
        resetToDefaults()
      })
    })

    function renderStoredActions(invalidateExportGraph: () => void) {
      return renderHook(() => {
        const { colorIntent, setColorIntent } = useRawDetachedWorkflowState()
        return useRawAdjustmentActions({
          params: colorIntent,
          setColorIntent,
          invalidateExportGraph,
        })
      })
    }

    it('stores neutral bands for an explicitly undefined selective color', () => {
      const invalidateExportGraph = vi.fn()
      const { result } = renderStoredActions(invalidateExportGraph)

      act(() => {
        result.current.setParams({ selectiveColor: undefined })
      })

      expect(getProcessingParams().selectiveColor).toEqual(
        makeNeutralSelectiveColorFixture(),
      )
      expect(invalidateExportGraph).not.toHaveBeenCalled()

      expect(() => {
        act(() => {
          result.current.setSelectiveColorBand('red', { hue: 12 })
        })
      }).not.toThrow()

      const stored = getProcessingParams().selectiveColor
      for (const id of BAND_IDS) {
        expect(stored[id]).toEqual(
          id === 'red'
            ? { hue: 12, saturation: 0, lightness: 0 }
            : { hue: 0, saturation: 0, lightness: 0 },
        )
      }
      expect(invalidateExportGraph).toHaveBeenCalledTimes(1)
    })

    it('stores partial selective color as complete normalized bands', () => {
      const invalidateExportGraph = vi.fn()
      const { result } = renderStoredActions(invalidateExportGraph)

      act(() => {
        result.current.setParams({
          selectiveColor: {
            blue: { hue: 140, saturation: 20 },
          } as unknown as ColorGraphIntent['selectiveColor'],
        })
      })

      const stored = getProcessingParams().selectiveColor
      for (const id of BAND_IDS) {
        expect(stored[id]).toEqual(
          id === 'blue'
            ? { hue: 100, saturation: 20, lightness: 0 }
            : { hue: 0, saturation: 0, lightness: 0 },
        )
      }
      expect(invalidateExportGraph).toHaveBeenCalledTimes(1)
    })
  })

  it('composes tone and color updates issued before a rerender', () => {
    const { ref, setColorIntent } = createParamsHarness(baseParams)
    const invalidateExportGraph = vi.fn()
    const { result } = renderHook(() =>
      useRawAdjustmentActions({
        params: baseParams,
        setColorIntent,
        invalidateExportGraph,
      }),
    )

    act(() => {
      result.current.setToneParams({ userContrast: 140 })
      result.current.setToneParams({ userShadows: 15 })
      result.current.setColorParams({ userTemperature: 30 })
      result.current.setSelectiveColorBand('red', { hue: 12 })
    })

    expect(ref.current).toMatchObject({
      userContrast: 100,
      userShadows: 15,
      userTemperature: 30,
      intensity: 0.7,
    })
    expect(ref.current.selectiveColor.red).toEqual({
      hue: 12,
      saturation: 0,
      lightness: 0,
    })
    expect(invalidateExportGraph).toHaveBeenCalledTimes(4)
  })

  describe('setSelectiveColorBand', () => {
    it('state safety at action layer leaves other bands untouched', () => {
      // Pre-populate non-target bands with sentinel values that must be preserved.
      const initial: ColorGraphIntent = {
        ...baseParams,
        selectiveColor: {
          red: { hue: 0, saturation: 0, lightness: 0 },
          orange: { hue: 1, saturation: 2, lightness: 3 },
          yellow: { hue: 4, saturation: 5, lightness: 6 },
          green: { hue: 7, saturation: 8, lightness: 9 },
          aqua: { hue: 10, saturation: 11, lightness: 12 },
          blue: { hue: 13, saturation: 14, lightness: 15 },
          purple: { hue: 16, saturation: 17, lightness: 18 },
          magenta: { hue: 19, saturation: 20, lightness: 21 },
        },
      }

      const { ref, setColorIntent } = createParamsHarness(initial)
      const invalidateExportGraph = vi.fn()
      const { result } = renderHook(() =>
        useRawAdjustmentActions({
          params: ref.current,
          setColorIntent,
          invalidateExportGraph,
        }),
      )

      act(() => {
        result.current.setSelectiveColorBand('red', { hue: 50 })
      })

      expect(ref.current.selectiveColor?.red).toEqual({
        hue: 50,
        saturation: 0,
        lightness: 0,
      })
      // Other bands must be byte-identical to the pre-call sentinel values.
      expect(ref.current.selectiveColor?.orange).toEqual({
        hue: 1,
        saturation: 2,
        lightness: 3,
      })
      expect(ref.current.selectiveColor?.yellow).toEqual({
        hue: 4,
        saturation: 5,
        lightness: 6,
      })
      expect(ref.current.selectiveColor?.green).toEqual({
        hue: 7,
        saturation: 8,
        lightness: 9,
      })
      expect(ref.current.selectiveColor?.aqua).toEqual({
        hue: 10,
        saturation: 11,
        lightness: 12,
      })
      expect(ref.current.selectiveColor?.blue).toEqual({
        hue: 13,
        saturation: 14,
        lightness: 15,
      })
      expect(ref.current.selectiveColor?.purple).toEqual({
        hue: 16,
        saturation: 17,
        lightness: 18,
      })
      expect(ref.current.selectiveColor?.magenta).toEqual({
        hue: 19,
        saturation: 20,
        lightness: 21,
      })
      expect(invalidateExportGraph).toHaveBeenCalled()
    })

    it('partial band update preserves other fields in the same band', () => {
      const initial: ColorGraphIntent = {
        ...baseParams,
        selectiveColor: {
          ...makeNeutralSelectiveColorFixture(),
          red: { hue: 10, saturation: 25, lightness: -12 },
        },
      }
      const { ref, setColorIntent } = createParamsHarness(initial)
      const invalidateExportGraph = vi.fn()
      const { result } = renderHook(() =>
        useRawAdjustmentActions({
          params: ref.current,
          setColorIntent,
          invalidateExportGraph,
        }),
      )

      act(() => {
        result.current.setSelectiveColorBand('red', { hue: 50 })
      })

      expect(ref.current.selectiveColor?.red).toEqual({
        hue: 50,
        saturation: 25,
        lightness: -12,
      })
    })

    it('keeps every other band neutral when shifting one band of a neutral record', () => {
      const initial: ColorGraphIntent = { ...baseParams }
      const { ref, setColorIntent } = createParamsHarness(initial)
      const invalidateExportGraph = vi.fn()
      const { result } = renderHook(() =>
        useRawAdjustmentActions({
          params: ref.current,
          setColorIntent,
          invalidateExportGraph,
        }),
      )

      act(() => {
        result.current.setSelectiveColorBand('blue', { saturation: 30 })
      })

      expect(ref.current.selectiveColor).toBeDefined()
      for (const id of BAND_IDS) {
        if (id === 'blue') {
          expect(ref.current.selectiveColor![id]).toEqual({
            hue: 0,
            saturation: 30,
            lightness: 0,
          })
        } else {
          expect(ref.current.selectiveColor![id]).toEqual({
            hue: 0,
            saturation: 0,
            lightness: 0,
          })
        }
      }
      expect(invalidateExportGraph).toHaveBeenCalled()
    })
  })

  describe('resetSelectiveColor', () => {
    it('reset scope isolation clears all 24 selective-color scalars but preserves tone and color balance', () => {
      const initial: ColorGraphIntent = {
        ...baseParams,
        userExposureEv: 1.5,
        userContrast: -20,
        userTemperature: 12,
        userTint: -8,
        selectiveColor: {
          red: { hue: 50, saturation: 30, lightness: -10 },
          orange: { hue: 5, saturation: 5, lightness: 5 },
          yellow: { hue: 5, saturation: 5, lightness: 5 },
          green: { hue: 5, saturation: 5, lightness: 5 },
          aqua: { hue: 5, saturation: 5, lightness: 5 },
          blue: { hue: 5, saturation: 5, lightness: 5 },
          purple: { hue: 5, saturation: 5, lightness: 5 },
          magenta: { hue: 5, saturation: 5, lightness: 5 },
        },
      }
      const { ref, setColorIntent } = createParamsHarness(initial)
      const invalidateExportGraph = vi.fn()
      const { result } = renderHook(() =>
        useRawAdjustmentActions({
          params: ref.current,
          setColorIntent,
          invalidateExportGraph,
        }),
      )

      act(() => {
        result.current.resetSelectiveColor()
      })

      // All 24 scalars across all 8 bands must be zero.
      for (const id of BAND_IDS) {
        expect(ref.current.selectiveColor![id]).toEqual({
          hue: 0,
          saturation: 0,
          lightness: 0,
        })
      }
      // Tone scalars preserved.
      expect(ref.current.userExposureEv).toBe(1.5)
      expect(ref.current.userContrast).toBe(-20)
      // Color balance scalars preserved.
      expect(ref.current.userTemperature).toBe(12)
      expect(ref.current.userTint).toBe(-8)
      expect(invalidateExportGraph).toHaveBeenCalled()
    })

    it('resetTone does not touch selective color', () => {
      const initial: ColorGraphIntent = {
        ...baseParams,
        userExposureEv: 1.0,
        selectiveColor: {
          ...makeNeutralSelectiveColorFixture(),
          red: { hue: 50, saturation: 0, lightness: 0 },
        },
      }
      const { ref, setColorIntent } = createParamsHarness(initial)
      const invalidateExportGraph = vi.fn()
      const { result } = renderHook(() =>
        useRawAdjustmentActions({
          params: ref.current,
          setColorIntent,
          invalidateExportGraph,
        }),
      )

      act(() => {
        result.current.resetTone()
      })

      expect(ref.current.userExposureEv).toBe(0)
      expect(ref.current.selectiveColor?.red).toEqual({
        hue: 50,
        saturation: 0,
        lightness: 0,
      })
    })

    it('resetColor does not touch selective color', () => {
      const initial: ColorGraphIntent = {
        ...baseParams,
        userTemperature: 18,
        userTint: -5,
        selectiveColor: {
          ...makeNeutralSelectiveColorFixture(),
          red: { hue: 50, saturation: 0, lightness: 0 },
        },
      }
      const { ref, setColorIntent } = createParamsHarness(initial)
      const invalidateExportGraph = vi.fn()
      const { result } = renderHook(() =>
        useRawAdjustmentActions({
          params: ref.current,
          setColorIntent,
          invalidateExportGraph,
        }),
      )

      act(() => {
        result.current.resetColor()
      })

      expect(ref.current.userTemperature).toBe(0)
      expect(ref.current.userTint).toBe(0)
      expect(ref.current.selectiveColor?.red).toEqual({
        hue: 50,
        saturation: 0,
        lightness: 0,
      })
    })

    it('does not invalidate the export graph when already neutral', () => {
      const initial: ColorGraphIntent = {
        ...baseParams,
        selectiveColor: makeNeutralSelectiveColorFixture(),
      }
      const { ref, setColorIntent } = createParamsHarness(initial)
      const invalidateExportGraph = vi.fn()
      const { result } = renderHook(() =>
        useRawAdjustmentActions({
          params: ref.current,
          setColorIntent,
          invalidateExportGraph,
        }),
      )

      act(() => {
        result.current.resetSelectiveColor()
      })

      expect(invalidateExportGraph).not.toHaveBeenCalled()
    })
  })
})
