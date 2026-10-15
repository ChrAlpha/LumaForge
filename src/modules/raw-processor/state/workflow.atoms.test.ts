import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import { NEUTRAL_SELECTIVE_COLOR } from '@lumaforge/luma-color-runtime'
import { beforeEach, describe, expect, it } from 'vitest'

import { resetToDefaults } from '../test-support/workflow-store'
import { getProcessingParams, setColorIntent } from './workflow.atoms'

describe('the stored color intent', () => {
  beforeEach(() => {
    resetToDefaults()
  })

  it('starts strict and neutral, with the app look strength', () => {
    expect(getProcessingParams()).toEqual({
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
  })

  it('hands updaters the intent alone and copies a write down to its color', () => {
    let seen: ColorGraphIntent | null = null
    setColorIntent((prev) => {
      seen = prev
      return { ...prev, intensity: 0.37, userContrast: 12 }
    })
    expect(seen).not.toHaveProperty('viewMode')
    expect(seen).not.toHaveProperty('compareSplit')
    expect(getProcessingParams()).toMatchObject({
      intensity: 0.37,
      userContrast: 12,
    })

    const mixed = {
      ...getProcessingParams(),
      viewMode: 'processed',
      compareSplit: 0.9,
    }
    setColorIntent(mixed)

    expect(getProcessingParams()).toMatchObject({
      intensity: 0.37,
      userContrast: 12,
    })
    expect(getProcessingParams()).not.toHaveProperty('viewMode')
    expect(getProcessingParams()).not.toHaveProperty('compareSplit')
  })

  it('keeps the stored intent when an updater returns its input', () => {
    const before = getProcessingParams()
    setColorIntent((prev) => prev)
    expect(getProcessingParams()).toBe(before)
  })
})
