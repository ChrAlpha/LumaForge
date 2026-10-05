import { describe, expect, it } from 'vitest'

import { createBlobOutputResult } from '~/lib/export/output-sink'
import type { ParsedLUT } from '~/lib/lut/cube-parser'

import { createExportResult } from '../../model/export-result'
import type { ImageSession, StyleAsset } from '../../model/session'
import {
  applyActiveLookToSession,
  applyLookIntensityToSession,
  clearActiveLookFromSession,
  preserveCustomLookIntensity,
  resolveActiveLook,
  resolveDetachedLookStyle,
} from './look-session-state'

function createStyle(overrides: Partial<StyleAsset> = {}): StyleAsset {
  return {
    kind: 'custom',
    name: 'Client LUT',
    defaultIntensity: 0.7,
    currentIntensity: 0.7,
    warning:
      'Choose the LUT input and output contract before preview or export.',
    lutAsset: {
      format: 'cube',
      dimension: 17,
      title: 'Client LUT',
      fingerprint: 'lut-fingerprint',
    },
    ...overrides,
  }
}

function createSession(overrides: Partial<ImageSession> = {}): ImageSession {
  return {
    id: 'session-look-state',
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
      boundedHqPreview: { status: 'ready', width: 1600, height: 1200 },
      displaySource: 'bounded-hq',
      boundedHqRequiredForExport: false,
    },
    activeStyle: null,
    viewState: {
      mode: 'compare',
      compareSplit: 0.5,
      zoom: 1,
      panX: 0,
      panY: 0,
      fitMode: 'screen',
    },
    renderState: { status: 'ready' },
    exportState: {
      status: 'idle',
      qualityPreset: 'high',
      fidelityLevel: 'balanced',
      fullResCapability: { status: 'supported', width: 1600, height: 1200 },
      recovery: { status: 'none' },
      checkpointDurable: false,
      retryRecommended: false,
    },
    ...overrides,
  }
}

function readyExportState(): ImageSession['exportState'] {
  return {
    status: 'ready',
    qualityPreset: 'high',
    fidelityLevel: 'balanced',
    fullResCapability: { status: 'supported', width: 1600, height: 1200 },
    recovery: { status: 'none' },
    checkpointDurable: false,
    retryRecommended: false,
    result: createExportResult({
      output: createBlobOutputResult({
        filename: 'frame_fullres.jpg',
        blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      }),
      filename: 'frame_fullres.jpg',
      width: 1600,
      height: 1200,
      copyCapability: {
        mode: 'full-resolution',
        label: 'Copy full-resolution image',
      },
    }),
    lastProgress: { completedStrips: 4, totalStrips: 4 },
  }
}

describe('look session state transitions', () => {
  it('applies a custom look and LUT profile selection while clearing a ready export when requested', () => {
    const selection = {
      status: 'unknown' as const,
      fingerprint: 'lut-fingerprint',
      title: 'Client LUT',
    }
    const session = createSession({ exportState: readyExportState() })
    const style = createStyle()

    const next = applyActiveLookToSession(session, {
      style,
      lutProfileSelection: selection,
      clearExportResult: true,
    })

    expect(next).not.toBe(session)
    expect(next.activeStyle).toBe(style)
    expect(next.lutProfileSelection).toBe(selection)
    expect(next.exportState.status).toBe('idle')
    expect(next.exportState.result).toBeUndefined()
    expect(next.exportState.lastProgress).toEqual({
      completedStrips: 4,
      totalStrips: 4,
    })
  })

  it('applies a builtin look and clears LUT profile selection without clearing export results when not requested', () => {
    const session = createSession({
      activeStyle: createStyle(),
      lutProfileSelection: {
        status: 'unknown',
        fingerprint: 'previous',
        title: 'Previous LUT',
      },
      exportState: readyExportState(),
    })
    const builtin = createStyle({
      kind: 'builtin',
      name: 'Neutral',
      lutAsset: undefined,
      inputPrepProfile: undefined,
    })

    const next = applyActiveLookToSession(session, {
      style: builtin,
      lutProfileSelection: undefined,
      clearExportResult: false,
    })

    expect(next).not.toBe(session)
    expect(next.activeStyle).toBe(builtin)
    expect(next.lutProfileSelection).toBeUndefined()
    expect(next.exportState.status).toBe('ready')
    expect(next.exportState.result).toBeDefined()
  })

  it('updates active style intensity and clears a ready export only when requested', () => {
    const session = createSession({
      activeStyle: createStyle({ currentIntensity: 0.7 }),
      exportState: readyExportState(),
    })

    const next = applyLookIntensityToSession(session, {
      intensity: 0.62,
      clearExportResult: true,
    })

    // Continuous: the amount lands exactly, not snapped to a preset.
    expect(next.activeStyle).toMatchObject({ currentIntensity: 0.62 })
    expect(next.exportState.status).toBe('idle')
    expect(next.exportState.result).toBeUndefined()

    const repeated = applyLookIntensityToSession(next, {
      intensity: 0.62,
      clearExportResult: false,
    })

    expect(repeated).not.toBe(next)
    expect(repeated.activeStyle).toMatchObject({
      currentIntensity: 0.62,
    })

    // Out-of-range amounts clamp to 0..1.
    expect(
      applyLookIntensityToSession(next, {
        intensity: 1.4,
        clearExportResult: false,
      }).activeStyle,
    ).toMatchObject({ currentIntensity: 1 })
    expect(repeated.exportState.status).toBe('idle')
  })

  it('leaves a style-less session unchanged by reference when intensity repeats without export invalidation', () => {
    const session = createSession()

    expect(
      applyLookIntensityToSession(session, {
        intensity: 0.7,
        clearExportResult: false,
      }),
    ).toBe(session)
  })

  it('clears active look and LUT profile selection while preserving ready export results when not requested', () => {
    const session = createSession({
      activeStyle: createStyle(),
      lutProfileSelection: {
        status: 'unknown',
        fingerprint: 'lut-fingerprint',
        title: 'Client LUT',
      },
      exportState: readyExportState(),
    })

    const next = clearActiveLookFromSession(session, {
      clearExportResult: false,
    })

    expect(next).not.toBe(session)
    expect(next.activeStyle).toBeNull()
    expect(next.lutProfileSelection).toBeUndefined()
    expect(next.exportState.status).toBe('ready')
    expect(next.exportState.result).toBeDefined()
  })

  it('preserves current custom intensity only across custom look replacements', () => {
    const style = createStyle({ currentIntensity: 0.7 })

    expect(
      preserveCustomLookIntensity(style, createStyle({ currentIntensity: 1 })),
    ).toMatchObject({ currentIntensity: 1 })

    expect(
      preserveCustomLookIntensity(
        style,
        createStyle({ kind: 'builtin', currentIntensity: 0.4 }),
      ),
    ).toBe(style)
  })
})

function createParsedLut(overrides: Partial<ParsedLUT> = {}): ParsedLUT {
  return {
    title: 'Detached Look',
    sourceName: 'detached-look.cube',
    comments: [],
    size: 2,
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    data: new Float32Array(2 * 2 * 2 * 3),
    fingerprint: 'detached-fingerprint',
    profileResolution: { kind: 'unknown' },
    inputProfile: 'display-srgb',
    ...overrides,
  }
}

describe('resolveActiveLook', () => {
  it('resolves the session style once a session exists, ignoring the detached LUT', () => {
    const sessionStyle = createStyle({ currentIntensity: 0.4 })
    const session = createSession({ activeStyle: sessionStyle })

    expect(
      resolveActiveLook({ session, lut: createParsedLut(), intensity: 1 }),
    ).toBe(sessionStyle)
    expect(
      resolveActiveLook({ session: createSession(), lut: null, intensity: 1 }),
    ).toBeNull()
  })

  it('synthesizes the detached look from the LUT with the canonical params intensity', () => {
    const detached = resolveActiveLook({
      session: null,
      lut: createParsedLut(),
      intensity: 1,
    })

    expect(detached).toMatchObject({
      kind: 'custom',
      name: 'Detached Look',
      currentIntensity: 1,
    })
  })

  it('returns no look when neither session nor detached LUT exists', () => {
    expect(
      resolveActiveLook({ session: null, lut: null, intensity: 0.7 }),
    ).toBeNull()
    expect(resolveDetachedLookStyle(null, 0.7)).toBeNull()
  })

  it('carries every detached intensity value through exactly', () => {
    const lut = createParsedLut()

    expect(resolveDetachedLookStyle(lut, 0.62)).toMatchObject({
      currentIntensity: 0.62,
    })
    expect(resolveDetachedLookStyle(lut, 0)).toMatchObject({
      currentIntensity: 0,
    })
    expect(resolveDetachedLookStyle(lut, 0.4)).toMatchObject({
      currentIntensity: 0.4,
    })
    expect(resolveDetachedLookStyle(lut, 0.7)).toMatchObject({
      currentIntensity: 0.7,
    })
    expect(resolveDetachedLookStyle(lut, 1)).toMatchObject({
      currentIntensity: 1,
    })
  })
})
