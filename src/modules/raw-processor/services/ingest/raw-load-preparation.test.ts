import { parseCubeLUT } from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import type { PreviewView } from '~/lib/preview/preview-view'

import type { StyleAsset } from '../../model/session'
import { prepareRawLoadState } from './raw-load-preparation'

function createView(overrides: Partial<PreviewView> = {}): PreviewView {
  return { mode: 'processed', compareSplit: 0.5, ...overrides }
}

function makeCube(title: string) {
  return [
    `TITLE "${title}"`,
    'LUT_3D_SIZE 2',
    '0 0 0',
    '1 0 0',
    '0 1 0',
    '1 1 0',
    '0 0 1',
    '1 0 1',
    '0 1 1',
    '1 1 1',
  ].join('\n')
}

function createActiveStyle(overrides: Partial<StyleAsset> = {}): StyleAsset {
  return {
    kind: 'custom',
    name: 'Previous LUT',
    defaultIntensity: 0.7,
    currentIntensity: 1,
    lutAsset: {
      format: 'cube',
      dimension: 17,
      title: 'Previous LUT',
    },
    ...overrides,
  }
}

describe('raw load preparation', () => {
  it.each([0.37, 0.62])(
    'carries the split %s of the view in effect into the next session',
    (split) => {
      const prepared = prepareRawLoadState({
        view: createView({ mode: 'original', compareSplit: split }),
        lut: null,
        activeStyle: null,
      })

      expect(prepared.compareSplit).toBe(split)
    },
  )

  it('reads a non-finite split as the centre', () => {
    const prepared = prepareRawLoadState({
      view: createView({ compareSplit: Number.NaN }),
      lut: null,
      activeStyle: null,
    })

    expect(prepared.compareSplit).toBe(0.5)
  })

  it('keeps a continuous custom strength when the next source retains the LUT', () => {
    const lut = parseCubeLUT(makeCube('Client LUT'))

    const prepared = prepareRawLoadState({
      view: createView(),
      lut,
      activeStyle: createActiveStyle({ currentIntensity: 0.37 }),
    })

    expect(prepared.retainedSessionState.activeStyle?.currentIntensity).toBe(
      0.37,
    )
    expect(prepared.lookSelectionPatch).toEqual({})
  })

  it('prepares neutral load state while leaving view state canonical in the session', () => {
    const prepared = prepareRawLoadState({
      view: createView({ compareSplit: 2 }),
      lut: null,
      activeStyle: createActiveStyle(),
    })

    expect(prepared.compareSplit).toBe(1)
    expect(prepared.retainedSessionState).toEqual({
      activeStyle: null,
      lutProfileSelection: undefined,
    })
    expect(prepared.lookSelectionPatch).toEqual({
      intensity: 0.7,
      styleKind: 'none',
      builtinPreset: null,
    })
    expect(prepared.lookSelectionPatch).not.toHaveProperty('viewMode')
    expect(prepared.lookSelectionPatch).not.toHaveProperty('compareSplit')
    expect(prepared.lookSelectionPatch).not.toHaveProperty('userExposureEv')
    expect(prepared.lookSelectionPatch).not.toHaveProperty('userContrast')
    expect(prepared.lookSelectionPatch).not.toHaveProperty('userHighlights')
    expect(prepared.lookSelectionPatch).not.toHaveProperty('userShadows')
    expect(prepared.lookSelectionPatch).not.toHaveProperty('userWhites')
    expect(prepared.lookSelectionPatch).not.toHaveProperty('userBlacks')
  })

  it('carries detached LUT state into a new RAW session with default custom intensity', () => {
    const lut = parseCubeLUT(makeCube('Client LUT'), {
      sourceName: 'client.cube',
    })

    const prepared = prepareRawLoadState({
      view: createView({ compareSplit: 0.8 }),
      lut,
      activeStyle: null,
    })

    expect(prepared.compareSplit).toBe(0.8)
    expect(prepared.retainedSessionState.activeStyle).toMatchObject({
      kind: 'custom',
      name: 'Client LUT',
      currentIntensity: 0.7,
    })
    expect(prepared.retainedSessionState.lutProfileSelection).toEqual({
      status: 'unknown',
      fingerprint: lut.fingerprint,
      title: 'Client LUT',
      sourceName: 'client.cube',
    })
    expect(prepared.lookSelectionPatch).toEqual({})
    expect(prepared.lookSelectionPatch).not.toHaveProperty('intensity')
    expect(prepared.lookSelectionPatch).not.toHaveProperty('styleKind')
    expect(prepared.lookSelectionPatch).not.toHaveProperty('builtinPreset')
    expect(prepared.lookSelectionPatch).not.toHaveProperty('viewMode')
    expect(prepared.lookSelectionPatch).not.toHaveProperty('compareSplit')
  })

  it('preserves active custom intensity when replacing a RAW with a custom LUT loaded', () => {
    const lut = parseCubeLUT(makeCube('Client LUT'))

    const prepared = prepareRawLoadState({
      view: createView(),
      lut,
      activeStyle: createActiveStyle({ currentIntensity: 1 }),
    })

    expect(prepared.retainedSessionState.activeStyle).toMatchObject({
      kind: 'custom',
      currentIntensity: 1,
    })
    expect(prepared.lookSelectionPatch).toEqual({})
    expect(prepared.lookSelectionPatch).not.toHaveProperty('intensity')
  })

  it('does not preserve builtin intensity as custom LUT intensity', () => {
    const lut = parseCubeLUT(makeCube('Client LUT'))

    const prepared = prepareRawLoadState({
      view: createView(),
      lut,
      activeStyle: createActiveStyle({
        kind: 'builtin',
        currentIntensity: 0.4,
        lutAsset: undefined,
      }),
    })

    expect(prepared.retainedSessionState.activeStyle).toMatchObject({
      kind: 'custom',
      currentIntensity: 0.7,
    })
    expect(prepared.lookSelectionPatch).toEqual({})
    expect(prepared.lookSelectionPatch).not.toHaveProperty('intensity')
  })
})
