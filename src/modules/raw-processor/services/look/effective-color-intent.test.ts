import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import {
  COLOR_GRAPH_INTENT_KEYS,
  generateIdentityLUT,
  NEUTRAL_USER_COLOR_INTENT,
  resolveExportColorGraph,
  resolveLUTProfile,
  toLUTData,
} from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import type { ImageSession, StyleAsset } from '../../model/session'
import { createTransformState } from '../../model/session-factory'
import {
  projectEffectiveColorIntent,
  projectSessionLookIntensity,
} from './effective-color-intent'
import { DEFAULT_LOOK_INTENSITY } from './style-system'

const IDENTITY_EXPOSURE = { ev: 0, multiplier: 1, source: 'identity' } as const

const storedIntent: ColorGraphIntent = Object.freeze({
  ...NEUTRAL_USER_COLOR_INTENT,
  userExposureEv: 0.5,
  styleKind: 'none',
  builtinPreset: null,
  intensity: 0.42,
})

function createSession(activeStyle: StyleAsset | null): ImageSession {
  return {
    id: 'effective-intent-session',
    createdAt: 1,
    sourceFile: {
      name: 'frame.ARW',
      extension: 'arw',
      sizeBytes: 12,
      supportLevel: 'experimental',
    },
    previewBundle: {
      embeddedPreview: { status: 'idle' },
      quickDecodePreview: { status: 'ready', width: 800, height: 600 },
      boundedHqPreview: { status: 'ready', width: 800, height: 600 },
      displaySource: 'bounded-hq',
      boundedHqRequiredForExport: false,
    },
    activeStyle,
    viewState: {
      mode: 'compare',
      compareSplit: 0.3,
      zoom: 2,
      panX: 10,
      panY: 20,
      fitMode: 'screen',
    },
    renderState: { status: 'ready' },
    exportState: {
      status: 'idle',
      fullResCapability: { status: 'supported', width: 4000, height: 3000 },
      retryRecommended: false,
    },
    transform: createTransformState('effective-intent-session'),
  }
}

function customLook(currentIntensity: number): StyleAsset {
  return {
    kind: 'custom',
    name: 'Client Look',
    defaultIntensity: DEFAULT_LOOK_INTENSITY,
    currentIntensity,
  }
}

describe('projectSessionLookIntensity', () => {
  it('projects the look strength a session owns, and the default without one', () => {
    expect(projectSessionLookIntensity(createSession(customLook(0.37)))).toBe(
      0.37,
    )
    expect(projectSessionLookIntensity(createSession(null))).toBe(
      DEFAULT_LOOK_INTENSITY,
    )
    expect(DEFAULT_LOOK_INTENSITY).toBe(0.7)
  })
})

describe('projectEffectiveColorIntent', () => {
  it('returns the stored intent itself while no session exists', () => {
    expect(projectEffectiveColorIntent(storedIntent, null)).toBe(storedIntent)
  })

  it('projects a look-less session to no look at the default strength', () => {
    const detachedLook: ColorGraphIntent = {
      ...storedIntent,
      styleKind: 'custom',
      intensity: 1,
    }

    expect(
      projectEffectiveColorIntent(detachedLook, createSession(null)),
    ).toEqual({
      ...storedIntent,
      styleKind: 'none',
      builtinPreset: null,
      intensity: 0.7,
    })
  })

  it('reuses the stored intent when a look-less session projects nothing new', () => {
    const neutral: ColorGraphIntent = { ...storedIntent, intensity: 0.7 }

    expect(projectEffectiveColorIntent(neutral, createSession(null))).toBe(
      neutral,
    )
  })

  it('projects a custom session look with its continuous strength', () => {
    const effective = projectEffectiveColorIntent(
      storedIntent,
      createSession(customLook(0.37)),
    )

    expect(effective).toEqual({
      ...storedIntent,
      styleKind: 'custom',
      builtinPreset: null,
      intensity: 0.37,
    })
    expect(Object.keys(effective).sort()).toEqual(
      [...COLOR_GRAPH_INTENT_KEYS].sort(),
    )
  })

  it('reuses the stored intent when it already carries the session look', () => {
    const carried: ColorGraphIntent = {
      ...storedIntent,
      styleKind: 'custom',
      intensity: 0.37,
    }

    expect(
      projectEffectiveColorIntent(carried, createSession(customLook(0.37))),
    ).toBe(carried)
  })

  it('keeps a built-in preset the stored intent selects under a built-in session look', () => {
    const preset: ColorGraphIntent = {
      ...storedIntent,
      styleKind: 'builtin',
      builtinPreset: 'film-soft',
    }
    const effective = projectEffectiveColorIntent(
      preset,
      createSession({
        kind: 'builtin',
        name: 'Film Soft',
        defaultIntensity: DEFAULT_LOOK_INTENSITY,
        currentIntensity: 0.5,
      }),
    )

    expect(effective).toEqual({ ...preset, intensity: 0.5 })
  })

  it('keeps a zero-strength custom look, so export keeps its LUT and contract checks', () => {
    const effective = projectEffectiveColorIntent(
      storedIntent,
      createSession(customLook(0)),
    )
    const confirmedLut = toLUTData(generateIdentityLUT(2))
    const unconfirmedLut = {
      ...confirmedLut,
      profileResolution: resolveLUTProfile({ title: 'Unknown', comments: [] }),
    }

    expect(effective.styleKind).toBe('custom')
    expect(effective.intensity).toBe(0)
    const graph = resolveExportColorGraph({
      ...effective,
      lut: confirmedLut,
      rawRenderExposure: IDENTITY_EXPOSURE,
    })
    expect(graph.supported).toBe(true)
    expect(graph.steps.map((step) => step.kind)).toContain('lut3d')
    expect(unconfirmedLut.profileResolution.kind).not.toBe('confirmed')
    expect(
      resolveExportColorGraph({
        ...effective,
        lut: unconfirmedLut,
        rawRenderExposure: IDENTITY_EXPOSURE,
      }).supported,
    ).toBe(false)
  })

  it('never carries session view state into the projected intent', () => {
    const effective = projectEffectiveColorIntent(
      storedIntent,
      createSession(customLook(0.5)),
    )

    expect(effective).not.toHaveProperty('viewMode')
    expect(effective).not.toHaveProperty('compareSplit')
    expect(effective).not.toHaveProperty('rawRenderExposure')
    expect(effective).not.toHaveProperty('lut')
  })
})
