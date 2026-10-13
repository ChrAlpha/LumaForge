import type { ParsedLUT } from '@lumaforge/luma-color-runtime'
import {
  NEUTRAL_USER_COLOR_INTENT,
  parseCubeLUT,
} from '@lumaforge/luma-color-runtime'
import { createBlobOutputResult } from '@lumaforge/render-engine/export'
import { describe, expect, it } from 'vitest'

import { createExportResult } from '../../model/export-result'
import type { ImageSession, StyleAsset } from '../../model/session'
import type { TestSessionOverrides } from '../../test-support/builders'
import { createLoadedTestSession } from '../../test-support/builders'
import { captureExportResultIdentity } from '../export/export-result-identity'
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
    lutAsset: {
      format: 'cube',
      dimension: 17,
      title: 'Client LUT',
      fingerprint: 'lut-fingerprint',
    },
    ...overrides,
  }
}

function createSession(overrides: TestSessionOverrides = {}): ImageSession {
  return createLoadedTestSession({ id: 'session-look-state', ...overrides })
}

function readyExportState(): ImageSession['exportState'] {
  return {
    status: 'ready',
    fullResCapability: { status: 'supported', width: 1600, height: 1200 },
    result: createExportResult({
      kind: 'full-resolution',
      output: createBlobOutputResult({
        filename: 'frame_fullres.jpg',
        blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      }),
      filename: 'frame_fullres.jpg',
      width: 1600,
      height: 1200,
      copyCapability: {
        mode: 'full-resolution',
      },
      identity: captureExportResultIdentity({
        resultKind: 'full-resolution',
        attemptId: 'attempt-look-state',
        sessionId: 'session-look-state',
        sourceFile: new File(['raw'], 'frame.ARW'),
        intent: {
          styleKind: 'none',
          builtinPreset: null,
          intensity: 0,
          ...NEUTRAL_USER_COLOR_INTENT,
        },
        lut: null,
        rawRenderExposure: { ev: 0, multiplier: 1, source: 'identity' },
        geometry: null,
      }),
    }),
    lastProgress: { completedStrips: 4, totalStrips: 4 },
  }
}

describe('look session state transitions', () => {
  it('applies a custom look and LUT profile selection and clears a ready export', () => {
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

  it('updates active style intensity and clears a ready export', () => {
    const session = createSession({
      activeStyle: createStyle({ currentIntensity: 0.7 }),
      exportState: readyExportState(),
    })

    const next = applyLookIntensityToSession(session, 0.62)

    // Continuous: the amount lands exactly, not snapped to a preset.
    expect(next.activeStyle).toMatchObject({ currentIntensity: 0.62 })
    expect(next.exportState.status).toBe('idle')
    expect(next.exportState.result).toBeUndefined()

    // Out-of-range amounts clamp to 0..1; a non-number is the default.
    expect(applyLookIntensityToSession(next, 1.4).activeStyle).toMatchObject({
      currentIntensity: 1,
    })
    expect(
      applyLookIntensityToSession(next, Number.NaN).activeStyle,
    ).toMatchObject({ currentIntensity: 0.7 })
  })

  it('clears the active look, its LUT profile selection, and a ready export', () => {
    const session = createSession({
      activeStyle: createStyle(),
      lutProfileSelection: {
        status: 'unknown',
        fingerprint: 'lut-fingerprint',
        title: 'Client LUT',
      },
      exportState: readyExportState(),
    })

    const next = clearActiveLookFromSession(session)

    expect(next.activeStyle).toBeNull()
    expect(next.lutProfileSelection).toBeUndefined()
    expect(next.exportState.status).toBe('idle')
    expect(next.exportState.result).toBeUndefined()
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
  const cube = `TITLE "Detached Look"\nLUT_3D_SIZE 2\n${'0 0 0\n'.repeat(8)}`
  return {
    ...parseCubeLUT(cube, { sourceName: 'detached-look.cube' }),
    fingerprint: 'detached-fingerprint',
    profileResolution: { kind: 'unknown' },
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
