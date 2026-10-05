import type { ProcessingParams } from '@lumaforge/luma-color-runtime'
import { act, renderHook } from '@testing-library/react'
import { atom, createStore } from 'jotai'
import type { SetStateAction } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { createBlobOutputResult } from '~/lib/export/output-sink'
import type { ParsedLUT } from '~/lib/lut/cube-parser'
import { parseCubeLUT } from '~/lib/lut/cube-parser'

import { createExportResult } from '../../../model/export-result'
import type { ImageSession } from '../../../model/session'
import { clearExportResultState } from '../../../services/export/export-state'
import {
  buildLUTContractSelectionState,
  LOOK_INTENSITY_PRESETS,
} from '../../../services/look/style-system'
import { useRawLookStage } from './useRawLookStage'

const baseParams: ProcessingParams = {
  intensity: 0.7,
  viewMode: 'processed',
  compareSplit: 0.5,
  styleKind: 'none',
  builtinPreset: null,
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
}

function createSession(): ImageSession {
  return {
    id: 'look-stage-session',
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
    activeStyle: {
      kind: 'custom',
      name: 'Client Look',
      defaultIntensity: 0.7,
      currentIntensity: 1,
    },
    viewState: {
      mode: 'processed',
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
      fullResCapability: {
        status: 'supported',
        width: 4000,
        height: 3000,
      },
      recovery: { status: 'none' },
      checkpointDurable: false,
      retryRecommended: false,
    },
  }
}

function createSessionWithoutLook(): ImageSession {
  return {
    ...createSession(),
    activeStyle: null,
    lutProfileSelection: undefined,
  }
}

function createCubeContent(title: string) {
  const size = 17
  const step = 1 / (size - 1)
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`]

  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        lines.push(`${r * step} ${g * step} ${b * step}`)
      }
    }
  }

  return lines.join('\n')
}

function createCubeFile(title: string, name: string) {
  const content = createCubeContent(title)

  return Object.assign(new File([content], name), {
    text: () => Promise.resolve(content),
  })
}

function createLut() {
  return parseCubeLUT(createCubeContent('Client Look'), {
    sourceName: 'look.cube',
  })
}

function withReadyExport(session: ImageSession): ImageSession {
  return {
    ...session,
    exportState: {
      ...session.exportState,
      status: 'ready',
      result: createExportResult({
        output: createBlobOutputResult({
          filename: 'frame_fullres.jpg',
          blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
        }),
        width: 4000,
        height: 3000,
        now: () => 1,
        copyCapability: {
          mode: 'full-resolution',
          label: 'Copy full-resolution image',
        },
      }),
    },
  }
}

const publishedBoundedHq = {
  status: 'ready',
  width: 1600,
  height: 1200,
} as const
const publishedCapability = {
  status: 'supported',
  width: 6000,
  height: 4000,
} as const

function publishPreviewAndCapability(
  prev: ImageSession | null,
): ImageSession | null {
  if (!prev) return prev

  return {
    ...prev,
    previewBundle: {
      ...prev.previewBundle,
      boundedHqPreview: publishedBoundedHq,
      displaySource: 'bounded-hq',
    },
    exportState: {
      ...prev.exportState,
      fullResCapability: publishedCapability,
    },
  }
}

type SetParamsUpdate =
  | ProcessingParams
  | ((prev: ProcessingParams) => ProcessingParams)

/**
 * Backs the hook with a real store, so updaters run against whatever is
 * current when an action fires. The hook renders once and never rerenders:
 * `actions` keep the initial render's snapshot, like a callback captured
 * before React commits concurrent updates.
 */
function renderLookStageHarness({
  session,
  params = baseParams,
  renderedParams = params,
  lut = null,
}: {
  session: ImageSession | null
  /** Detached params held by the store. */
  params?: ProcessingParams
  /** Params the hook renders with (compare-projected in the workflow). */
  renderedParams?: ProcessingParams
  lut?: ParsedLUT | null
}) {
  const store = createStore()
  const sessionAtom = atom<ImageSession | null>(session)
  const paramsAtom = atom<ProcessingParams>(params)
  const sessionNotifications = vi.fn()
  const paramsNotifications = vi.fn()
  store.sub(sessionAtom, sessionNotifications)
  store.sub(paramsAtom, paramsNotifications)

  const sessionRef = { current: session }
  const setSession = vi.fn((update: SetStateAction<ImageSession | null>) =>
    store.set(sessionAtom, update),
  )
  const setParams = vi.fn((update: SetParamsUpdate) =>
    store.set(paramsAtom, update),
  )
  const invalidateExportGraph = vi.fn(() =>
    store.set(sessionAtom, clearExportResultState),
  )
  const setLut = vi.fn()
  const setLutDataRef = vi.fn()
  const scheduleToast = vi.fn()

  const { result } = renderHook(() =>
    useRawLookStage({
      baseParams: renderedParams,
      session,
      sessionRef,
      setSession,
      lut,
      setLut,
      setParams,
      getProcessingParams: () => renderedParams,
      lutDataRef: { current: lut },
      setLutDataRef,
      scheduleToast,
      invalidateExportGraph,
    }),
  )

  return {
    actions: result.current,
    sessionRef,
    setSession,
    setParams,
    invalidateExportGraph,
    setLut,
    setLutDataRef,
    scheduleToast,
    sessionNotifications,
    paramsNotifications,
    readSession: () => store.get(sessionAtom),
    readParams: () => store.get(paramsAtom),
    publishSession: (update: SetStateAction<ImageSession | null>) =>
      store.set(sessionAtom, update),
    publishParams: (update: SetParamsUpdate) => store.set(paramsAtom, update),
  }
}

describe('useRawLookStage', () => {
  it('projects session style intensity into processing params', () => {
    const session = createSession()
    const { result } = renderHook(() =>
      useRawLookStage({
        baseParams,
        session,
        sessionRef: { current: session },
        setSession: vi.fn(),
        lut: null,
        setLut: vi.fn(),
        setParams: vi.fn(),
        getProcessingParams: () => baseParams,
        lutDataRef: { current: null },
        setLutDataRef: vi.fn(),
        scheduleToast: vi.fn(),
        invalidateExportGraph: vi.fn(),
      }),
    )

    expect(result.current.params.intensity).toBe(1)
    expect(result.current.params.styleKind).toBe('custom')
    expect(result.current.params.builtinPreset).toBeNull()
    expect(result.current.activeIntensity).toBe(1)
    expect(result.current.currentLutName).toBe('Client Look')
  })

  it('projects a style-less session into neutral look params', () => {
    const session = createSessionWithoutLook()
    const staleParams: ProcessingParams = {
      ...baseParams,
      intensity: 1,
      styleKind: 'custom',
    }
    const { result } = renderHook(() =>
      useRawLookStage({
        baseParams: staleParams,
        session,
        sessionRef: { current: session },
        setSession: vi.fn(),
        lut: null,
        setLut: vi.fn(),
        setParams: vi.fn(),
        getProcessingParams: () => staleParams,
        lutDataRef: { current: null },
        setLutDataRef: vi.fn(),
        scheduleToast: vi.fn(),
        invalidateExportGraph: vi.fn(),
      }),
    )

    expect(result.current.params.intensity).toBe(0.7)
    expect(result.current.params.styleKind).toBe('none')
    expect(result.current.params.builtinPreset).toBeNull()
    expect(result.current.activeIntensity).toBe(0.7)
  })

  it('normalizes tone params and invalidates export when the render graph changes', () => {
    const setParams = vi.fn(
      (
        value:
          | ProcessingParams
          | ((prev: ProcessingParams) => ProcessingParams),
      ) => (typeof value === 'function' ? value(baseParams) : value),
    )
    const invalidateExportGraph = vi.fn()
    const session = createSession()
    const { result } = renderHook(() =>
      useRawLookStage({
        baseParams,
        session,
        sessionRef: { current: session },
        setSession: vi.fn(),
        lut: null,
        setLut: vi.fn(),
        setParams,
        getProcessingParams: () => baseParams,
        lutDataRef: { current: null },
        setLutDataRef: vi.fn(),
        scheduleToast: vi.fn(),
        invalidateExportGraph,
        setViewMode: vi.fn(),
        setCompareSplit: vi.fn(),
      }),
    )

    result.current.setToneParams({ userContrast: 120 })

    expect(setParams).toHaveBeenCalledTimes(1)
    const updater = setParams.mock.calls[0]?.[0]
    expect(typeof updater).toBe('function')
    expect(
      (updater as (prev: ProcessingParams) => ProcessingParams)(baseParams),
    ).toMatchObject({ userContrast: 100 })
    expect(invalidateExportGraph).toHaveBeenCalledTimes(1)
  })

  it('loads custom LUTs into the active session without writing legacy params', async () => {
    const session = createSession()
    const setParams = vi.fn()
    const setLut = vi.fn()
    const setSession = vi.fn()
    const { result } = renderHook(() =>
      useRawLookStage({
        baseParams,
        session,
        sessionRef: { current: session },
        setSession,
        lut: null,
        setLut,
        setParams,
        getProcessingParams: () => baseParams,
        lutDataRef: { current: null },
        setLutDataRef: vi.fn(),
        scheduleToast: vi.fn(),
        invalidateExportGraph: vi.fn(),
      }),
    )

    await act(async () => {
      await result.current.loadLUT(createCubeFile('Client Look', 'look.cube'))
    })

    expect(setLut).toHaveBeenCalledTimes(1)
    expect(setSession).toHaveBeenCalledTimes(1)
    expect(setParams).not.toHaveBeenCalled()
  })

  it('selects LUT profiles in the active session without writing legacy params', () => {
    const session = createSession()
    const setParams = vi.fn()
    const setLut = vi.fn()
    const setSession = vi.fn()
    const lut = parseCubeLUT(createCubeContent('Client Look'), {
      sourceName: 'look.cube',
    })
    const { result } = renderHook(() =>
      useRawLookStage({
        baseParams,
        session,
        sessionRef: { current: session },
        setSession,
        lut,
        setLut,
        setParams,
        getProcessingParams: () => baseParams,
        lutDataRef: { current: null },
        setLutDataRef: vi.fn(),
        scheduleToast: vi.fn(),
        invalidateExportGraph: vi.fn(),
      }),
    )

    result.current.selectLUTProfile('display-srgb')

    expect(setLut).toHaveBeenCalledTimes(1)
    expect(setSession).toHaveBeenCalledTimes(1)
    expect(setParams).not.toHaveBeenCalled()
  })

  it('clears session LUTs without writing legacy params', () => {
    const lut = createLut()
    const session = {
      ...createSession(),
      lutProfileSelection: buildLUTContractSelectionState(lut),
    }
    const harness = renderLookStageHarness({ session, lut })

    harness.actions.clearLUT()

    expect(harness.setLut).toHaveBeenCalledWith(null)
    expect(harness.setLutDataRef).toHaveBeenCalledWith(null)
    expect(harness.setSession).toHaveBeenCalledTimes(1)
    expect(harness.readSession()).toMatchObject({
      activeStyle: null,
      lutProfileSelection: undefined,
    })
    expect(harness.setParams).not.toHaveBeenCalled()
    expect(harness.readParams()).toBe(baseParams)
    expect(harness.invalidateExportGraph).toHaveBeenCalledTimes(1)
    expect(harness.scheduleToast).toHaveBeenCalledTimes(1)
  })

  describe('look actions run against the current state', () => {
    it('keeps preview and capability updates published after render when selecting intensity', () => {
      const session = withReadyExport(createSession())
      const harness = renderLookStageHarness({ session })

      harness.publishSession(publishPreviewAndCapability)
      harness.actions.setIntensity(LOOK_INTENSITY_PRESETS.light)

      const current = harness.readSession()
      expect(current?.previewBundle.boundedHqPreview).toEqual(
        publishedBoundedHq,
      )
      expect(current?.exportState.fullResCapability).toEqual(
        publishedCapability,
      )
      expect(current?.activeStyle?.currentIntensity).toBe(
        LOOK_INTENSITY_PRESETS.light,
      )
      expect(current?.exportState).toMatchObject({
        status: 'idle',
        result: undefined,
      })
      expect(current?.viewState).toBe(session.viewState)
      expect(harness.invalidateExportGraph).toHaveBeenCalledTimes(1)
      expect(harness.paramsNotifications).not.toHaveBeenCalled()
    })

    it('keeps preview and capability updates published after render when clearing the LUT', () => {
      const lut = createLut()
      const session = withReadyExport({
        ...createSession(),
        lutProfileSelection: buildLUTContractSelectionState(lut),
      })
      const harness = renderLookStageHarness({ session, lut })

      harness.publishSession(publishPreviewAndCapability)
      harness.actions.clearLUT()

      const current = harness.readSession()
      expect(current?.previewBundle.boundedHqPreview).toEqual(
        publishedBoundedHq,
      )
      expect(current?.exportState.fullResCapability).toEqual(
        publishedCapability,
      )
      expect(current).toMatchObject({
        activeStyle: null,
        lutProfileSelection: undefined,
        exportState: { status: 'idle', result: undefined },
      })
      expect(current?.viewState).toBe(session.viewState)
      expect(harness.setLut).toHaveBeenCalledWith(null)
      expect(harness.setLutDataRef).toHaveBeenCalledWith(null)
      expect(harness.scheduleToast).toHaveBeenCalledTimes(1)
      expect(harness.invalidateExportGraph).toHaveBeenCalledTimes(1)
      expect(harness.paramsNotifications).not.toHaveBeenCalled()
    })

    it('applies look actions to a session created after a session-less render', () => {
      const lut = createLut()
      const detachedParams: ProcessingParams = {
        ...baseParams,
        styleKind: 'custom',
      }
      const harness = renderLookStageHarness({
        session: null,
        params: detachedParams,
        lut,
      })
      const createdSession = createSession()

      // Ingest publishes the new session and its ref before React rerenders.
      harness.sessionRef.current = createdSession
      harness.publishSession(createdSession)
      harness.actions.setIntensity(LOOK_INTENSITY_PRESETS.light)

      expect(harness.readSession()).toMatchObject({
        id: createdSession.id,
        activeStyle: { currentIntensity: LOOK_INTENSITY_PRESETS.light },
      })
      expect(harness.readParams()).toBe(detachedParams)

      harness.actions.clearLUT()

      expect(harness.readSession()).toMatchObject({
        id: createdSession.id,
        activeStyle: null,
      })
      expect(harness.readParams()).toBe(detachedParams)
      expect(harness.invalidateExportGraph).toHaveBeenCalledTimes(2)
    })

    it('does not resurrect a session reset after render', () => {
      const lut = createLut()
      const detachedParams: ProcessingParams = {
        ...baseParams,
        styleKind: 'custom',
      }
      const harness = renderLookStageHarness({
        session: createSession(),
        params: detachedParams,
        lut,
      })

      harness.sessionRef.current = null
      harness.publishSession(null)
      harness.actions.setIntensity(LOOK_INTENSITY_PRESETS.light)

      expect(harness.readSession()).toBeNull()
      expect(harness.readParams()).toEqual({
        ...detachedParams,
        intensity: 0.4,
      })

      harness.actions.clearLUT()

      expect(harness.readSession()).toBeNull()
      expect(harness.readParams()).toEqual({
        ...detachedParams,
        intensity: 0.4,
        styleKind: 'none',
        builtinPreset: null,
      })
      expect(harness.invalidateExportGraph).toHaveBeenCalledTimes(2)
    })

    it('composes consecutive intensity selections issued before a rerender', () => {
      const session = withReadyExport(createSession())
      const harness = renderLookStageHarness({ session })

      harness.actions.setIntensity(LOOK_INTENSITY_PRESETS.light)
      harness.actions.setIntensity(LOOK_INTENSITY_PRESETS.strong)

      expect(harness.readSession()?.activeStyle?.currentIntensity).toBe(
        LOOK_INTENSITY_PRESETS.strong,
      )
      expect(harness.readSession()?.exportState).toMatchObject({
        status: 'idle',
        result: undefined,
      })
      expect(harness.invalidateExportGraph).toHaveBeenCalledTimes(2)
      expect(harness.paramsNotifications).not.toHaveBeenCalled()
    })

    it('keeps a cleared look cleared when a later action fires before a rerender', () => {
      const lut = createLut()
      const session = withReadyExport(createSession())
      const harness = renderLookStageHarness({ session, lut })

      harness.actions.clearLUT()
      harness.actions.setIntensity(LOOK_INTENSITY_PRESETS.light)

      expect(harness.readSession()).toMatchObject({
        activeStyle: null,
        exportState: { status: 'idle', result: undefined },
      })
      expect(harness.readSession()?.viewState).toBe(session.viewState)
      expect(harness.readParams()).toEqual({ ...baseParams, intensity: 0.4 })
    })

    it('leaves both stores untouched when the session look already has the selected intensity', () => {
      const session = withReadyExport(createSession())
      const harness = renderLookStageHarness({ session })

      harness.actions.setIntensity(LOOK_INTENSITY_PRESETS.strong)

      expect(harness.readSession()).toBe(session)
      expect(harness.readParams()).toBe(baseParams)
      expect(harness.sessionNotifications).not.toHaveBeenCalled()
      expect(harness.paramsNotifications).not.toHaveBeenCalled()
      expect(harness.invalidateExportGraph).not.toHaveBeenCalled()
    })

    it('leaves detached params untouched when they already carry the selected intensity', () => {
      const lut = createLut()
      const detachedParams: ProcessingParams = {
        ...baseParams,
        styleKind: 'custom',
      }
      const harness = renderLookStageHarness({
        session: null,
        params: detachedParams,
        lut,
      })

      harness.actions.setIntensity(LOOK_INTENSITY_PRESETS.standard)

      expect(harness.readParams()).toBe(detachedParams)
      expect(harness.readSession()).toBeNull()
      expect(harness.paramsNotifications).not.toHaveBeenCalled()
      expect(harness.sessionNotifications).not.toHaveBeenCalled()
      expect(harness.invalidateExportGraph).not.toHaveBeenCalled()
    })

    it('keeps detached view changes published after a session-less render', () => {
      const lut = createLut()
      const detachedParams: ProcessingParams = {
        ...baseParams,
        viewMode: 'compare',
        compareSplit: 0.5,
        styleKind: 'custom',
      }
      const harness = renderLookStageHarness({
        session: null,
        params: detachedParams,
        lut,
      })

      harness.publishParams((prev) => ({
        ...prev,
        viewMode: 'original',
        compareSplit: 0.25,
      }))
      harness.actions.setIntensity(LOOK_INTENSITY_PRESETS.strong)

      expect(harness.readParams()).toEqual({
        ...detachedParams,
        viewMode: 'original',
        compareSplit: 0.25,
        intensity: 1,
      })

      harness.actions.clearLUT()

      expect(harness.readParams()).toEqual({
        ...detachedParams,
        viewMode: 'original',
        compareSplit: 0.25,
        intensity: 1,
        styleKind: 'none',
        builtinPreset: null,
      })
      expect(harness.readSession()).toBeNull()
      expect(harness.invalidateExportGraph).toHaveBeenCalledTimes(2)
    })

    it('carries a look-less session intensity in detached params without copying session view state', () => {
      const session: ImageSession = {
        ...createSessionWithoutLook(),
        viewState: {
          ...createSession().viewState,
          mode: 'original',
          compareSplit: 0.3,
        },
      }
      const detachedParams: ProcessingParams = {
        ...baseParams,
        viewMode: 'compare',
        compareSplit: 0.5,
      }
      const harness = renderLookStageHarness({
        session,
        params: detachedParams,
        renderedParams: {
          ...detachedParams,
          viewMode: 'original',
          compareSplit: 0.3,
        },
      })

      harness.actions.setIntensity(LOOK_INTENSITY_PRESETS.strong)

      expect(harness.readParams()).toEqual({ ...detachedParams, intensity: 1 })
      expect(harness.readSession()?.viewState).toBe(session.viewState)
      expect(harness.readSession()?.activeStyle).toBeNull()
    })
  })
})

describe('useRawLookStage setIntensity', () => {
  it('sets a continuous amount on the latest session, keeping changes made since this render', () => {
    const session = createSession()
    const harness = renderLookStageHarness({ session })

    // A render-state change that landed mid-scrub survives the update.
    harness.publishSession((prev) =>
      prev ? { ...prev, renderState: { status: 'rendering' } } : prev,
    )
    act(() => {
      harness.actions.setIntensity(0.62)
    })

    expect(harness.invalidateExportGraph).toHaveBeenCalledTimes(1)
    // The session owns the look, so params are derived, not written.
    expect(harness.setParams).not.toHaveBeenCalled()
    expect(harness.readSession()?.activeStyle?.currentIntensity).toBe(0.62)
    expect(harness.readSession()?.renderState.status).toBe('rendering')
  })
})
