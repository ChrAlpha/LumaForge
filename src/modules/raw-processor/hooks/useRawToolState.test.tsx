import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import {
  NEUTRAL_USER_COLOR_INTENT,
  parseCubeLUT,
} from '@lumaforge/luma-color-runtime'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ImageSession, StyleAsset } from '../model/session'
import { createImageSession } from '../model/session-factory'
import { DEFAULT_LOOK_INTENSITY } from '../services/look/style-system'
import { setCurrentSession } from '../state/session.atoms'
import {
  getEffectiveColorIntent,
  getProcessingParams,
  setLut,
  setProcessingParams,
  setProcessingStatus,
  setProgress,
} from '../state/workflow.atoms'
import { resetToDefaults } from '../test-support/workflow-store'
import {
  useRawToolAdjustments,
  useRawToolProgress,
  useRawToolStatus,
} from './useRawToolState'

// The slices read the production store, so every test starts from, and
// leaves, the defaults it holds before a source loads.
beforeEach(() => {
  setCurrentSession(null)
  resetToDefaults()
})
afterEach(() => {
  cleanup()
  setCurrentSession(null)
  resetToDefaults()
})

const CUBE = [
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
].join('\n')

const clientLook: StyleAsset = {
  kind: 'custom',
  name: 'Client Look',
  defaultIntensity: DEFAULT_LOOK_INTENSITY,
  currentIntensity: 0.35,
}

function loadSession(activeStyle: StyleAsset | null = null): ImageSession {
  const session = createImageSession(new File(['raw'], 'frame.NEF'), {
    activeStyle,
  })
  setCurrentSession(session)
  return session
}

function editStoredIntent(patch: Partial<ColorGraphIntent>) {
  setProcessingParams({ ...getProcessingParams(), ...patch })
}

/** A hook under test, with how many times it rendered. */
function renderCounted<Result>(hook: () => Result) {
  let renders = 0
  const rendered = renderHook(() => {
    renders++
    return hook()
  })
  return { ...rendered, renders: () => renders }
}

describe('raw tool status slices', () => {
  it('reads the workflow stage from its atom, without its progress', () => {
    const status = renderCounted(useRawToolStatus)
    const progress = renderCounted(useRawToolProgress)
    expect(status.result.current).toEqual({
      status: 'idle',
      isExporting: false,
    })
    expect(progress.result.current).toBe(0)

    act(() => setProcessingStatus('exporting'))
    expect(status.result.current).toEqual({
      status: 'exporting',
      isExporting: true,
    })
    const exporting = status.result.current
    const statusRenders = status.renders()

    // Progress moves: only its reader renders, and the stage keeps its
    // identity.
    act(() => setProgress(40))
    act(() => setProgress(80))
    expect(progress.result.current).toBe(80)
    expect(status.renders()).toBe(statusRenders)
    expect(status.result.current).toBe(exporting)

    act(() => setProcessingStatus('ready'))
    expect(status.result.current).toEqual({
      status: 'ready',
      isExporting: false,
    })
  })
})

describe('raw tool adjustment slice', () => {
  it('reads the stored intent before a source loads, the default strength without a look', () => {
    editStoredIntent({ userExposureEv: 1.5, userTint: 12, intensity: 0.2 })
    const { result } = renderHook(useRawToolAdjustments)
    expect(result.current.tone).toEqual({
      userExposureEv: 1.5,
      userContrast: NEUTRAL_USER_COLOR_INTENT.userContrast,
      userHighlights: NEUTRAL_USER_COLOR_INTENT.userHighlights,
      userShadows: NEUTRAL_USER_COLOR_INTENT.userShadows,
      userWhites: NEUTRAL_USER_COLOR_INTENT.userWhites,
      userBlacks: NEUTRAL_USER_COLOR_INTENT.userBlacks,
    })
    expect(result.current.color).toEqual({
      userTemperature: NEUTRAL_USER_COLOR_INTENT.userTemperature,
      userTint: 12,
      userSaturation: NEUTRAL_USER_COLOR_INTENT.userSaturation,
      userVibrance: NEUTRAL_USER_COLOR_INTENT.userVibrance,
    })
    expect(result.current.selectiveColor).toBe(
      getProcessingParams().selectiveColor,
    )
    // No look is active, so the stored amount waits for one.
    expect(result.current.activeIntensity).toBe(DEFAULT_LOOK_INTENSITY)

    // A LUT loaded before the RAW applies at the stored amount.
    act(() => setLut(parseCubeLUT(CUBE, { sourceName: 'look.cube' })))
    expect(result.current.activeIntensity).toBe(0.2)
  })

  it('projects the session look over the stored intent, as the photo renders it', () => {
    editStoredIntent({ userContrast: 20, intensity: 0.9 })
    const { result } = renderHook(useRawToolAdjustments)

    // A session that owns no look applies none, at the default strength.
    act(() => {
      loadSession()
    })
    expect(result.current.activeIntensity).toBe(DEFAULT_LOOK_INTENSITY)
    expect(result.current.activeIntensity).toBe(
      getEffectiveColorIntent().intensity,
    )

    // The session's look sets the strength; the user colour is the stored one.
    act(() => {
      loadSession(clientLook)
    })
    expect(result.current.activeIntensity).toBe(0.35)
    expect(result.current.activeIntensity).toBe(
      getEffectiveColorIntent().intensity,
    )
    expect(result.current.tone.userContrast).toBe(20)
    expect(result.current.tone.userContrast).toBe(
      getEffectiveColorIntent().userContrast,
    )
  })

  it('renders only when an adjustment moves, and keeps every unmoved part', () => {
    const session = loadSession(clientLook)
    const { result, renders } = renderCounted(useRawToolAdjustments)
    const initial = result.current
    const settled = renders()

    // Transform, export and view writes reach the session, not the
    // adjustments.
    act(() =>
      setCurrentSession({
        ...session,
        viewState: { ...session.viewState, mode: 'compare' },
        exportState: { ...session.exportState, status: 'exporting' },
      }),
    )
    act(() => setProcessingStatus('exporting'))
    act(() => setProgress(50))
    expect(renders()).toBe(settled)
    expect(result.current).toBe(initial)

    // An intent write that moves nothing renders nothing.
    act(() => editStoredIntent({}))
    expect(renders()).toBe(settled)

    // A tone edit moves the tone alone.
    act(() => editStoredIntent({ userExposureEv: 0.5 }))
    expect(result.current.tone.userExposureEv).toBe(0.5)
    expect(result.current.color).toBe(initial.color)
    expect(result.current.selectiveColor).toBe(initial.selectiveColor)
    expect(result.current.activeIntensity).toBe(initial.activeIntensity)

    // A strength change in the session moves the strength alone.
    const toned = result.current
    act(() =>
      setCurrentSession((prev) =>
        prev
          ? {
              ...prev,
              activeStyle: { ...clientLook, currentIntensity: 0.6 },
            }
          : prev,
      ),
    )
    expect(result.current.activeIntensity).toBe(0.6)
    expect(result.current.tone).toBe(toned.tone)
    expect(result.current.color).toBe(toned.color)
  })
})
