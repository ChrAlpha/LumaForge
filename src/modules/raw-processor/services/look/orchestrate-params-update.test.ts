import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import type { ImageSession } from '../../model/session'
import { createImageSession } from '../../model/session-factory'
import { projectSessionLookIntensity } from './effective-color-intent'
import {
  computeColorParams,
  computeDetachedClearLUT,
  computeDetachedIntensityChange,
  computeSessionClearLUT,
  computeSessionIntensityChange,
  computeToneParams,
} from './orchestrate-params-update'
import { DEFAULT_LOOK_INTENSITY, LOOK_INTENSITY_PRESETS } from './style-system'

const NEUTRAL_INTENT: ColorGraphIntent = Object.freeze({
  ...NEUTRAL_USER_COLOR_INTENT,
  styleKind: 'none',
  builtinPreset: null,
  intensity: DEFAULT_LOOK_INTENSITY,
})

function createIntent(
  overrides: Partial<ColorGraphIntent> = {},
): ColorGraphIntent {
  return { ...NEUTRAL_INTENT, ...overrides }
}

function createSessionWithLook(currentIntensity: number): ImageSession {
  const session = createImageSession(new File(['raw'], 'frame.ARW'))
  return {
    ...session,
    activeStyle: {
      kind: 'custom',
      name: 'Client Look',
      defaultIntensity: DEFAULT_LOOK_INTENSITY,
      currentIntensity,
    },
    viewState: {
      ...session.viewState,
      mode: 'original',
      compareSplit: 0.62,
    },
  }
}

function expectNoViewFields(value: object) {
  expect(value).not.toHaveProperty('viewMode')
  expect(value).not.toHaveProperty('compareSplit')
}

describe('look strength stays continuous', () => {
  it.each([0.37, 0.62, 0.05, 0.999])(
    'stores the detached strength %s as given, not snapped to a detent',
    (value) => {
      const change = computeDetachedIntensityChange(createIntent(), value)

      expect(change.params.intensity).toBe(value)
      expect(change.shouldInvalidateExportGraph).toBe(true)
      expectNoViewFields(change.params)
    },
  )

  it.each([0.37, 0.62])(
    'stores the session strength %s as given on the session look',
    (value) => {
      const session = createSessionWithLook(LOOK_INTENSITY_PRESETS.strong)
      const change = computeSessionIntensityChange(session, value)

      expect(change.session.activeStyle?.currentIntensity).toBe(value)
      expect(projectSessionLookIntensity(change.session)).toBe(value)
      expect(change.shouldInvalidateExportGraph).toBe(true)
      expect(change.session.viewState).toBe(session.viewState)
    },
  )

  it('clamps out-of-range strengths to 0..1 and a non-number to the default', () => {
    const intent = createIntent({ intensity: 0.37 })

    expect(computeDetachedIntensityChange(intent, -0.2).params.intensity).toBe(
      0,
    )
    expect(computeDetachedIntensityChange(intent, 1.4).params.intensity).toBe(1)
    expect(
      computeDetachedIntensityChange(intent, Number.NaN).params.intensity,
    ).toBe(DEFAULT_LOOK_INTENSITY)
    expect(
      computeDetachedIntensityChange(intent, Number.POSITIVE_INFINITY).params
        .intensity,
    ).toBe(DEFAULT_LOOK_INTENSITY)

    const session = createSessionWithLook(0.37)
    expect(
      computeSessionIntensityChange(session, Number.NaN).session.activeStyle
        ?.currentIntensity,
    ).toBe(DEFAULT_LOOK_INTENSITY)
  })

  it('returns the same intent and session when the strength is unchanged', () => {
    const intent = createIntent({ intensity: 0.62 })
    const detached = computeDetachedIntensityChange(intent, 0.62)
    expect(detached.params).toBe(intent)
    expect(detached.shouldInvalidateExportGraph).toBe(false)

    const session = createSessionWithLook(0.62)
    const attached = computeSessionIntensityChange(session, 0.62)
    expect(attached.session).toBe(session)
    expect(attached.shouldInvalidateExportGraph).toBe(false)
  })

  it('projects the default strength for a session that owns no look', () => {
    const session = {
      ...createSessionWithLook(0.37),
      activeStyle: null,
    }

    expect(projectSessionLookIntensity(session)).toBe(DEFAULT_LOOK_INTENSITY)
  })
})

describe('clearing the look', () => {
  it('drops a detached style but keeps the continuous strength', () => {
    const intent = createIntent({ styleKind: 'custom', intensity: 0.37 })
    const change = computeDetachedClearLUT(intent, true)

    expect(change.params).toEqual({
      ...intent,
      styleKind: 'none',
      builtinPreset: null,
    })
    expect(change.params.intensity).toBe(0.37)
    expect(change.shouldInvalidateExportGraph).toBe(true)
    expectNoViewFields(change.params)
  })

  it('returns a style-less intent itself and invalidates only for a loaded LUT', () => {
    const intent = createIntent({ intensity: 0.62 })

    expect(computeDetachedClearLUT(intent, false)).toEqual({
      params: intent,
      shouldInvalidateExportGraph: false,
    })
    expect(computeDetachedClearLUT(intent, false).params).toBe(intent)
    expect(
      computeDetachedClearLUT(intent, true).shouldInvalidateExportGraph,
    ).toBe(true)
  })

  it('clears the session look without touching its view', () => {
    const session = createSessionWithLook(0.37)
    const change = computeSessionClearLUT(session, false)

    expect(change.session.activeStyle).toBeNull()
    expect(change.session.viewState).toBe(session.viewState)
    expect(change.shouldInvalidateExportGraph).toBe(true)
  })
})

describe('user tone and color updates', () => {
  it('merges a tone patch into the color intent and clamps it', () => {
    const intent = createIntent({ intensity: 0.37, userTemperature: 12 })
    const change = computeToneParams(intent, {
      userContrast: 140,
      userExposureEv: 1,
    })

    expect(change.params).toEqual({
      ...intent,
      userContrast: 100,
      userExposureEv: 1,
    })
    expect(change.shouldClearExportResult).toBe(true)
    expectNoViewFields(change.params)
  })

  it('reads a non-finite tone field as neutral', () => {
    const intent = createIntent({ userContrast: 30 })
    const change = computeToneParams(intent, { userContrast: Number.NaN })

    expect(change.params.userContrast).toBe(0)
    expect(change.shouldClearExportResult).toBe(true)
  })

  it('merges a color patch into the color intent and keeps the strength', () => {
    const intent = createIntent({ intensity: 0.62 })
    const change = computeColorParams(intent, {
      userTemperature: 25,
      userVibrance: -10,
    })

    expect(change.params).toEqual({
      ...intent,
      userTemperature: 25,
      userVibrance: -10,
    })
    expect(change.params.intensity).toBe(0.62)
    expect(change.shouldClearExportResult).toBe(true)
    expectNoViewFields(change.params)
  })

  it('does not ask for an export clear when the patch changes nothing', () => {
    const intent = createIntent({ userTint: 4 })

    expect(computeColorParams(intent, { userTint: 4 })).toEqual({
      params: intent,
      shouldClearExportResult: false,
    })
    expect(computeToneParams(intent, {}).shouldClearExportResult).toBe(false)
  })
})
