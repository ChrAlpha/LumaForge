import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import {
  getLUTColorProfile,
  parseCubeLUT,
  resolveExportColorGraph,
  toLUTData,
} from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import { DEFAULT_COLOR_INTENT } from '../../state/workflow.atoms'
import { createTestCube } from '../../test-support/builders'
import {
  cpuHdrPreviewView,
  hasHdrRendition,
  hdrPreviewChoices,
  resolveHdrPreviewChoice,
  resolvePreviewHdrOutput,
} from './hdr-preview-output'

describe('hdr preview choices', () => {
  it('opens on the HDR rendition only where the surface shows it', () => {
    expect(hdrPreviewChoices(true)).toEqual([
      'hdr',
      'sdr',
      'above-sdr',
      'stop-down',
    ])
    expect(hdrPreviewChoices(false)).toEqual(['sdr', 'above-sdr', 'stop-down'])
  })

  it('keeps a made choice only while the preview offers it', () => {
    const sdrSurface = hdrPreviewChoices(false)
    expect(resolveHdrPreviewChoice(null, sdrSurface)).toBe('sdr')
    expect(resolveHdrPreviewChoice('stop-down', sdrSurface)).toBe('stop-down')
    // A surface that lost its extended range falls back to its default.
    expect(resolveHdrPreviewChoice('hdr', sdrSurface)).toBe('sdr')
    expect(resolveHdrPreviewChoice('hdr', hdrPreviewChoices(true))).toBe('hdr')
  })
})

describe('hdr rendition', () => {
  it('follows the gain-map export: a look without a LUT has one, a LUT look none', () => {
    expect(hasHdrRendition(DEFAULT_COLOR_INTENT, null)).toBe(true)
    const lut = {
      ...toLUTData(parseCubeLUT(createTestCube('look', 2))),
      profileResolution: {
        kind: 'confirmed' as const,
        confidence: 'user' as const,
        profile: getLUTColorProfile('display-srgb')!,
      },
    }
    const look: ColorGraphIntent = {
      ...DEFAULT_COLOR_INTENT,
      styleKind: 'custom',
      intensity: 1,
    }
    // The SDR export takes the look; only the HDR rendition refuses it.
    expect(resolveExportColorGraph({ ...look, lut }).supported).toBe(true)
    expect(hasHdrRendition(look, lut)).toBe(false)
  })

  it('draws the rendition only while the gain map is on and the look has one', () => {
    const on = {
      hdrExport: true,
      hdrRendition: true,
      transformOverlayShown: false,
    }
    expect(resolvePreviewHdrOutput({ ...on, choice: 'hdr' })).toBe('extended')
    expect(resolvePreviewHdrOutput({ ...on, choice: 'above-sdr' })).toBe(
      'above-sdr',
    )
    expect(resolvePreviewHdrOutput({ ...on, choice: 'stop-down' })).toBe(
      'stop-down',
    )
    expect(resolvePreviewHdrOutput({ ...on, choice: 'sdr' })).toBeUndefined()
    expect(
      resolvePreviewHdrOutput({ ...on, hdrExport: false, choice: 'hdr' }),
    ).toBeUndefined()
    expect(
      resolvePreviewHdrOutput({ ...on, hdrRendition: false, choice: 'hdr' }),
    ).toBeUndefined()
    expect(
      resolvePreviewHdrOutput({
        ...on,
        transformOverlayShown: true,
        choice: 'above-sdr',
      }),
    ).toBeUndefined()
  })

  it('leaves the extended rendition to the WebGPU canvas', () => {
    expect(cpuHdrPreviewView('above-sdr')).toBe('above-sdr')
    expect(cpuHdrPreviewView('stop-down')).toBe('stop-down')
    expect(cpuHdrPreviewView('extended')).toBeUndefined()
    expect(cpuHdrPreviewView(undefined)).toBeUndefined()
  })
})
