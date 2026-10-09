import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import {
  COLOR_GRAPH_INTENT_KEYS,
  NEUTRAL_USER_COLOR_INTENT,
  pickColorGraphIntent,
} from '@lumaforge/luma-color-runtime'
import { createBlobOutputResult } from '@lumaforge/render-engine/export'
import { sourceContentIdFromBytes } from '@lumaforge/render-engine/manifest'
import { act, renderHook } from '@testing-library/react'
import { atom, createStore, useAtomValue } from 'jotai'
import type { SetStateAction } from 'react'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest'

import { jotaiStore } from '~/lib/jotai'
import type { ParsedLUT } from '~/lib/lut/cube-parser'
import { parseCubeLUT } from '~/lib/lut/cube-parser'
import type { OnlineLUTEntry } from '~/lib/profiles/catalog'
import { fetchVerifiedCubeAsset } from '~/lib/profiles/fetch'

import { createExportResult } from '../../../model/export-result'
import type { ImageSession } from '../../../model/session'
import { createTransformState } from '../../../model/session-factory'
import { captureExportResultIdentity } from '../../../services/export/export-result-identity'
import { clearExportResultState } from '../../../services/export/export-state'
import { projectEffectiveColorIntent } from '../../../services/look/effective-color-intent'
import type { LutLoadOutcome } from '../../../services/look/orchestrate-lut-load'
import {
  buildLUTContractSelectionState,
  LOOK_INTENSITY_PRESETS,
} from '../../../services/look/style-system'
import {
  currentSessionAtom,
  getCurrentSession,
  setCurrentSession,
} from '../../../state/session.atoms'
import {
  getEffectiveColorIntent,
  getProcessingParams,
  setProcessingParams,
  useProcessingParamsValue,
} from '../../../state/workflow.atoms'
import { useRawLookStage } from './useRawLookStage'

vi.mock('~/lib/profiles/fetch', () => ({
  createBrowserOnlineProfileCache: vi.fn(() => ({})),
  fetchVerifiedCubeAsset: vi.fn(),
  fetchCachedBytesWithLimit: vi.fn(),
}))

// The stage reads and writes the session in the production store, so every
// test seeds that store and leaves it empty.
beforeEach(() => {
  setCurrentSession(null)
})

afterEach(() => {
  setCurrentSession(null)
})

/** The stored color intent the hook renders from; it carries no view. */
const baseIntent: ColorGraphIntent = Object.freeze({
  ...NEUTRAL_USER_COLOR_INTENT,
  intensity: 0.7,
  styleKind: 'none',
  builtinPreset: null,
})
const baseParams: ColorGraphIntent = baseIntent

const SOURCE_FILE = new File(['raw-12-bytes'], 'frame.ARW', {
  lastModified: 1,
})

function createSession(): ImageSession {
  return {
    id: 'look-stage-session',
    createdAt: 1,
    sourceFile: {
      file: SOURCE_FILE,
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
      fullResCapability: {
        status: 'supported',
        width: 4000,
        height: 3000,
      },
      retryRecommended: false,
    },
    exportGeometry: null,
    transform: createTransformState('look-stage-session'),
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
        kind: 'full-resolution',
        output: createBlobOutputResult({
          filename: 'frame_fullres.jpg',
          blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
        }),
        width: 4000,
        height: 3000,
        now: () => 1,
        copyCapability: {
          mode: 'full-resolution',
        },
        identity: captureExportResultIdentity({
          resultKind: 'full-resolution',
          attemptId: 'attempt-1',
          sessionId: session.id,
          sourceFile: SOURCE_FILE,
          intent: projectEffectiveColorIntent(baseIntent, session),
          lut: null,
          rawRenderExposure: null,
          geometry: null,
        }),
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

type SetColorIntentUpdate =
  | ColorGraphIntent
  | ((prev: ColorGraphIntent) => ColorGraphIntent)

/**
 * Backs the hook with the production session store and a real intent store,
 * so updaters run against whatever is current when an action fires. The hook
 * renders once and never rerenders: `actions` keep the initial render's
 * snapshot, like a callback captured before React commits concurrent updates.
 */
function renderLookStageHarness({
  session,
  params = baseIntent,
  renderedParams = { ...baseParams, ...params },
  lut = null,
}: {
  session: ImageSession | null
  /** Detached color intent held by the store. */
  params?: ColorGraphIntent
  /** Color intent the hook renders with. */
  renderedParams?: ColorGraphIntent
  lut?: ParsedLUT | null
}) {
  setCurrentSession(session)
  const store = createStore()
  const paramsAtom = atom<ColorGraphIntent>(params)
  const sessionNotifications = vi.fn()
  const paramsNotifications = vi.fn()
  const unsubscribeSession = jotaiStore.sub(
    currentSessionAtom,
    sessionNotifications,
  )
  onTestFinished(unsubscribeSession)
  store.sub(paramsAtom, paramsNotifications)

  const setColorIntent = vi.fn((update: SetColorIntentUpdate) =>
    store.set(paramsAtom, update),
  )
  const invalidateExportGraph = vi.fn(() =>
    setCurrentSession(clearExportResultState),
  )
  const setLut = vi.fn()
  const setLutDataRef = vi.fn()
  const scheduleToast = vi.fn()

  const { result } = renderHook(() =>
    useRawLookStage({
      baseParams: renderedParams,
      session,
      lut,
      setLut,
      setColorIntent,
      lutDataRef: { current: lut },
      setLutDataRef,
      scheduleToast,
      invalidateExportGraph,
      canApplyLoadedLut: () => true,
    }),
  )

  return {
    actions: result.current,
    setColorIntent,
    invalidateExportGraph,
    setLut,
    setLutDataRef,
    scheduleToast,
    sessionNotifications,
    paramsNotifications,
    readSession: getCurrentSession,
    readParams: () => store.get(paramsAtom),
    publishSession: (update: SetStateAction<ImageSession | null>) =>
      setCurrentSession(update),
    publishParams: (update: SetColorIntentUpdate) =>
      store.set(paramsAtom, update),
  }
}

describe('useRawLookStage', () => {
  it('projects session style intensity into processing params', () => {
    const session = createSession()
    const { result } = renderHook(() =>
      useRawLookStage({
        baseParams,
        session,
        lut: null,
        setLut: vi.fn(),
        setColorIntent: vi.fn(),
        lutDataRef: { current: null },
        setLutDataRef: vi.fn(),
        scheduleToast: vi.fn(),
        invalidateExportGraph: vi.fn(),
        canApplyLoadedLut: () => true,
      }),
    )

    expect(result.current.params.intensity).toBe(1)
    expect(result.current.params.styleKind).toBe('custom')
    expect(result.current.params.builtinPreset).toBeNull()
    expect(Object.keys(result.current.params).sort()).toEqual(
      [...COLOR_GRAPH_INTENT_KEYS].sort(),
    )
    expect(result.current.activeIntensity).toBe(1)
    expect(result.current.currentLutName).toBe('Client Look')
  })

  it('projects a style-less session into neutral look params', () => {
    const session = createSessionWithoutLook()
    const staleParams: ColorGraphIntent = {
      ...baseParams,
      intensity: 1,
      styleKind: 'custom',
    }
    const { result } = renderHook(() =>
      useRawLookStage({
        baseParams: staleParams,
        session,
        lut: null,
        setLut: vi.fn(),
        setColorIntent: vi.fn(),
        lutDataRef: { current: null },
        setLutDataRef: vi.fn(),
        scheduleToast: vi.fn(),
        invalidateExportGraph: vi.fn(),
        canApplyLoadedLut: () => true,
      }),
    )

    expect(result.current.params.intensity).toBe(0.7)
    expect(result.current.params.styleKind).toBe('none')
    expect(result.current.params.builtinPreset).toBeNull()
    expect(result.current.activeIntensity).toBe(0.7)
  })

  it('normalizes tone params and invalidates export when the render graph changes', () => {
    const setColorIntent = vi.fn(
      (
        value:
          | ColorGraphIntent
          | ((prev: ColorGraphIntent) => ColorGraphIntent),
      ) => (typeof value === 'function' ? value(baseIntent) : value),
    )
    const invalidateExportGraph = vi.fn()
    const session = createSession()
    const { result } = renderHook(() =>
      useRawLookStage({
        baseParams,
        session,
        lut: null,
        setLut: vi.fn(),
        setColorIntent,
        lutDataRef: { current: null },
        setLutDataRef: vi.fn(),
        scheduleToast: vi.fn(),
        invalidateExportGraph,
        canApplyLoadedLut: () => true,
      }),
    )

    result.current.setToneParams({ userContrast: 120 })

    expect(setColorIntent).toHaveBeenCalledTimes(1)
    const updater = setColorIntent.mock.calls[0]?.[0]
    expect(typeof updater).toBe('function')
    const written = (updater as (prev: ColorGraphIntent) => ColorGraphIntent)(
      baseIntent,
    )
    expect(written).toEqual({ ...baseIntent, userContrast: 100 })
    expect(written).not.toHaveProperty('viewMode')
    expect(invalidateExportGraph).toHaveBeenCalledTimes(1)
  })

  it('loads custom LUTs into the active session without writing the detached intent', async () => {
    const session = createSessionWithoutLook()
    setCurrentSession(session)
    const setColorIntent = vi.fn()
    const setLut = vi.fn()
    const { result } = renderHook(() =>
      useRawLookStage({
        baseParams,
        session,
        lut: null,
        setLut,
        setColorIntent,
        lutDataRef: { current: null },
        setLutDataRef: vi.fn(),
        scheduleToast: vi.fn(),
        invalidateExportGraph: vi.fn(),
        canApplyLoadedLut: () => true,
      }),
    )

    await act(async () => {
      await result.current.loadLUT(createCubeFile('Client Look', 'look.cube'))
    })

    expect(setLut).toHaveBeenCalledTimes(1)
    expect(getCurrentSession()).toMatchObject({
      id: session.id,
      activeStyle: { kind: 'custom', name: 'Client Look' },
    })
    expect(setColorIntent).not.toHaveBeenCalled()
  })

  it('selects LUT profiles in the active session without writing the detached intent', () => {
    const session = createSession()
    setCurrentSession(session)
    const setColorIntent = vi.fn()
    const setLut = vi.fn()
    const lut = parseCubeLUT(createCubeContent('Client Look'), {
      sourceName: 'look.cube',
    })
    const { result } = renderHook(() =>
      useRawLookStage({
        baseParams,
        session,
        lut,
        setLut,
        setColorIntent,
        lutDataRef: { current: null },
        setLutDataRef: vi.fn(),
        scheduleToast: vi.fn(),
        invalidateExportGraph: vi.fn(),
        canApplyLoadedLut: () => true,
      }),
    )

    result.current.selectLUTProfile('display-srgb')

    expect(setLut).toHaveBeenCalledTimes(1)
    expect(getCurrentSession()).not.toBe(session)
    expect(getCurrentSession()?.lutProfileSelection).toMatchObject({
      fingerprint: lut.fingerprint,
    })
    expect(setColorIntent).not.toHaveBeenCalled()
  })

  it('clears session LUTs without writing the detached intent', () => {
    const lut = createLut()
    const session = {
      ...createSession(),
      lutProfileSelection: buildLUTContractSelectionState(lut),
    }
    const harness = renderLookStageHarness({ session, lut })

    harness.actions.clearLUT()

    expect(harness.setLut).toHaveBeenCalledWith(null)
    expect(harness.setLutDataRef).toHaveBeenCalledWith(null)
    expect(harness.sessionNotifications).toHaveBeenCalledTimes(1)
    expect(harness.readSession()).toMatchObject({
      activeStyle: null,
      lutProfileSelection: undefined,
    })
    expect(harness.setColorIntent).not.toHaveBeenCalled()
    expect(harness.readParams()).toBe(baseIntent)
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
      const detachedParams: ColorGraphIntent = {
        ...baseIntent,
        styleKind: 'custom',
      }
      const harness = renderLookStageHarness({
        session: null,
        params: detachedParams,
        lut,
      })
      const createdSession = createSession()

      // Ingest publishes the new session to the store before React rerenders.
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
      const detachedParams: ColorGraphIntent = {
        ...baseIntent,
        styleKind: 'custom',
      }
      const harness = renderLookStageHarness({
        session: createSession(),
        params: detachedParams,
        lut,
      })

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
      expect(harness.readParams()).toEqual({ ...baseIntent, intensity: 0.4 })
    })

    it('leaves both stores untouched when the session look already has the selected intensity', () => {
      const session = withReadyExport(createSession())
      const harness = renderLookStageHarness({ session })

      harness.actions.setIntensity(LOOK_INTENSITY_PRESETS.strong)

      expect(harness.readSession()).toBe(session)
      expect(harness.readParams()).toBe(baseIntent)
      expect(harness.sessionNotifications).not.toHaveBeenCalled()
      expect(harness.paramsNotifications).not.toHaveBeenCalled()
      expect(harness.invalidateExportGraph).not.toHaveBeenCalled()
    })

    it('leaves detached params untouched when they already carry the selected intensity', () => {
      const lut = createLut()
      const detachedParams: ColorGraphIntent = {
        ...baseIntent,
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

    it('keeps detached color changes published after a session-less render', () => {
      const lut = createLut()
      const detachedParams: ColorGraphIntent = {
        ...baseIntent,
        styleKind: 'custom',
      }
      const harness = renderLookStageHarness({
        session: null,
        params: detachedParams,
        lut,
      })

      harness.publishParams((prev) => ({ ...prev, userContrast: 25 }))
      harness.actions.setIntensity(LOOK_INTENSITY_PRESETS.strong)

      expect(harness.readParams()).toEqual({
        ...detachedParams,
        userContrast: 25,
        intensity: 1,
      })

      harness.actions.clearLUT()

      expect(harness.readParams()).toEqual({
        ...detachedParams,
        userContrast: 25,
        intensity: 1,
        styleKind: 'none',
        builtinPreset: null,
      })
      expect(harness.readParams()).not.toHaveProperty('viewMode')
      expect(harness.readParams()).not.toHaveProperty('compareSplit')
      expect(harness.readSession()).toBeNull()
      expect(harness.invalidateExportGraph).toHaveBeenCalledTimes(2)
    })

    it('carries a look-less session intensity in the detached intent without copying session view state', () => {
      const session: ImageSession = {
        ...createSessionWithoutLook(),
        viewState: {
          ...createSession().viewState,
          mode: 'original',
          compareSplit: 0.3,
        },
      }
      const harness = renderLookStageHarness({
        session,
        params: baseIntent,
        renderedParams: baseParams,
      })

      harness.actions.setIntensity(LOOK_INTENSITY_PRESETS.strong)

      expect(harness.readParams()).toEqual({ ...baseIntent, intensity: 1 })
      expect(harness.readParams()).not.toHaveProperty('viewMode')
      expect(harness.readParams()).not.toHaveProperty('compareSplit')
      expect(harness.readSession()?.viewState).toBe(session.viewState)
      expect(harness.readSession()?.activeStyle).toBeNull()
    })

    it('keeps view and geometry published after render through every look action', () => {
      const lut = createLut()
      const session = withReadyExport({
        ...createSession(),
        lutProfileSelection: buildLUTContractSelectionState(lut),
      })
      const harness = renderLookStageHarness({ session, lut })
      const publishedViewState: ImageSession['viewState'] = {
        ...session.viewState,
        mode: 'compare',
        compareSplit: 0.62,
      }
      const publishedGeometry = {
        matrix: [0.999, -0.035, 0.018, 0.035, 0.999, -0.017, 0, 0, 1],
        constrainCrop: true,
      }
      harness.publishSession((prev) =>
        prev
          ? {
              ...prev,
              viewState: publishedViewState,
              exportGeometry: publishedGeometry,
            }
          : prev,
      )

      harness.actions.setIntensity(0.37)
      expect(harness.readSession()?.activeStyle?.currentIntensity).toBe(0.37)
      harness.actions.setToneParams({ userShadows: 20 })
      harness.actions.setParams({ userTint: 6 })
      harness.actions.clearLUT()

      const current = harness.readSession()
      expect(current?.viewState).toBe(publishedViewState)
      expect(current?.exportGeometry).toBe(publishedGeometry)
      expect(current?.activeStyle).toBeNull()
      expect(harness.readParams()).toEqual({
        ...baseIntent,
        userShadows: 20,
        userTint: 6,
      })
    })
  })
})

describe('useRawLookStage continuous strength', () => {
  it.each([0.37, 0.62])(
    'stores the detached strength %s as given and leaves the view out',
    (value) => {
      const lut = createLut()
      const harness = renderLookStageHarness({
        session: null,
        params: { ...baseIntent, styleKind: 'custom' },
        lut,
      })

      harness.actions.setIntensity(value)

      expect(harness.readParams().intensity).toBe(value)
      expect(harness.readParams()).not.toHaveProperty('viewMode')
      expect(harness.readParams()).not.toHaveProperty('compareSplit')
      expect(harness.invalidateExportGraph).toHaveBeenCalledTimes(1)
    },
  )

  it('clamps a non-number strength to the default on both owners', () => {
    const lut = createLut()
    const detached = renderLookStageHarness({
      session: null,
      params: { ...baseIntent, styleKind: 'custom', intensity: 0.37 },
      lut,
    })
    detached.actions.setIntensity(Number.NaN)
    expect(detached.readParams().intensity).toBe(0.7)

    const attached = renderLookStageHarness({ session: createSession() })
    attached.actions.setIntensity(Number.NaN)
    expect(attached.readSession()?.activeStyle?.currentIntensity).toBe(0.7)
    attached.actions.setIntensity(1.6)
    expect(attached.readSession()?.activeStyle?.currentIntensity).toBe(1)
  })

  it('keeps a continuous detached strength when the LUT contract changes', () => {
    const lut = createLut()
    const harness = renderLookStageHarness({
      session: null,
      params: { ...baseIntent, styleKind: 'custom', intensity: 0.37 },
      lut,
    })

    harness.actions.selectLUTProfile('display-srgb')

    expect(harness.readParams()).toEqual({
      ...baseIntent,
      styleKind: 'custom',
      builtinPreset: null,
      intensity: 0.37,
    })
  })

  it('keeps a session Strength set before a rerender when the LUT contract changes', () => {
    const lut = createLut()
    const session = createSession()
    const harness = renderLookStageHarness({ session, lut })

    harness.actions.setIntensity(0.43)
    harness.actions.selectLUTProfile('display-srgb')

    expect(harness.readSession()?.activeStyle).toMatchObject({
      kind: 'custom',
      currentIntensity: 0.43,
    })
    expect(harness.readSession()?.lutProfileSelection).toMatchObject({
      fingerprint: lut.fingerprint,
    })
    expect(harness.setColorIntent).not.toHaveBeenCalled()
  })

  it('gives a contract choice the hash of the LUT it applies to, not the one loaded since', async () => {
    const contentA = createCubeContent('Client Look')
    const { sha256: sha256A } = await sourceContentIdFromBytes(
      new TextEncoder().encode(contentA),
    )
    const lutA: ParsedLUT = {
      ...parseCubeLUT(contentA, { sourceName: 'look.cube' }),
      sha256: sha256A,
    }
    const harness = renderLookStageHarness({
      session: createSession(),
      lut: lutA,
    })

    await act(async () => {
      await expect(
        harness.actions.loadLUT(createCubeFile('Second Look', 'second.cube')),
      ).resolves.toBe('loaded')
    })
    const lutAssetB = harness.readSession()?.activeStyle?.lutAsset
    expect(lutAssetB?.fingerprint).not.toBe(lutA.fingerprint)
    expect(lutAssetB?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(lutAssetB?.sha256).not.toBe(sha256A)

    // A callback captured while LUT A was current still applies to LUT A.
    harness.actions.selectLUTProfile('display-srgb')

    const selected = harness.setLut.mock.lastCall?.[0] as ParsedLUT
    expect(selected.fingerprint).toBe(lutA.fingerprint)
    expect(selected.data).toBe(lutA.data)
    expect(selected.sha256).toBe(sha256A)
    expect(harness.readSession()?.activeStyle?.lutAsset).toMatchObject({
      fingerprint: lutA.fingerprint,
      sha256: sha256A,
    })
    expect(harness.readSession()?.lutProfileSelection).toMatchObject({
      fingerprint: lutA.fingerprint,
    })
  })

  it('keeps the hash the session holds for the same LUT when the LUT contract changes', () => {
    const lut = createLut()
    const harness = renderLookStageHarness({ session: createSession(), lut })
    const currentSha256 = 'c'.repeat(64)
    const withAsset = (fingerprint: string) =>
      harness.publishSession((prev) =>
        prev?.activeStyle
          ? {
              ...prev,
              activeStyle: {
                ...prev.activeStyle,
                lutAsset: {
                  format: 'cube',
                  dimension: 17,
                  fingerprint,
                  sha256: currentSha256,
                },
              },
            }
          : prev,
      )

    withAsset(lut.fingerprint)
    harness.actions.selectLUTProfile('display-srgb')
    expect(harness.readSession()?.activeStyle?.lutAsset?.sha256).toBe(
      currentSha256,
    )

    // A hash recorded for another LUT never transfers to this one.
    withAsset('lut-other')
    harness.actions.selectLUTProfile('display-srgb')
    expect(harness.readSession()?.activeStyle?.lutAsset).toMatchObject({
      fingerprint: lut.fingerprint,
    })
    expect(harness.readSession()?.activeStyle?.lutAsset?.sha256).toBeUndefined()
  })

  it('keeps a detached Strength set before a rerender when the LUT contract changes', () => {
    const lut = createLut()
    const harness = renderLookStageHarness({
      session: null,
      params: { ...baseIntent, styleKind: 'custom' },
      lut,
    })

    harness.actions.setIntensity(0.43)
    harness.actions.selectLUTProfile('display-srgb')

    expect(harness.readParams()).toEqual({
      ...baseIntent,
      styleKind: 'custom',
      builtinPreset: null,
      intensity: 0.43,
    })
    expect(harness.readSession()).toBeNull()
  })

  it('starts a LUT loaded after a clear at the default strength', async () => {
    const lut = createLut()
    const harness = renderLookStageHarness({
      session: null,
      params: { ...baseIntent, styleKind: 'custom', intensity: 0.62 },
      lut,
    })

    harness.actions.clearLUT()
    expect(harness.readParams()).toEqual({
      ...baseIntent,
      styleKind: 'none',
      builtinPreset: null,
      intensity: 0.62,
    })

    await act(async () => {
      await harness.actions.loadLUT(
        createCubeFile('Second Look', 'second.cube'),
      )
    })

    expect(harness.readParams()).toEqual({
      ...baseIntent,
      styleKind: 'custom',
      builtinPreset: null,
      intensity: 0.7,
    })
  })

  it('keeps a continuous session strength on the session look and off the detached intent', () => {
    const harness = renderLookStageHarness({ session: createSession() })

    harness.actions.setIntensity(0.37)
    harness.actions.setIntensity(0.62)

    expect(harness.readSession()?.activeStyle?.currentIntensity).toBe(0.62)
    expect(harness.readParams()).toBe(baseIntent)
    expect(harness.setColorIntent).not.toHaveBeenCalled()
  })

  it('projects a continuous session strength into the rendered params', () => {
    const session: ImageSession = {
      ...createSession(),
      activeStyle: {
        ...createSession().activeStyle!,
        currentIntensity: 0.37,
      },
    }
    const harness = renderLookStageHarness({ session })

    expect(harness.actions.params.intensity).toBe(0.37)
    expect(harness.actions.activeIntensity).toBe(0.37)
    expect(pickColorGraphIntent(harness.actions.params)).toEqual({
      ...baseIntent,
      styleKind: 'custom',
      intensity: 0.37,
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
    expect(harness.setColorIntent).not.toHaveBeenCalled()
    expect(harness.readSession()?.activeStyle?.currentIntensity).toBe(0.62)
    expect(harness.readSession()?.renderState.status).toBe('rendering')
  })
})

/** A .cube whose bytes arrive only when the test finishes the read. */
function createDeferredCubeFile(title: string, name: string) {
  const bytes = new TextEncoder().encode(createCubeContent(title))
  let finishRead!: () => void
  const read = new Promise<ArrayBuffer>((resolve) => {
    finishRead = () => resolve(bytes.buffer)
  })
  const file = new File([bytes], name)
  Object.defineProperty(file, 'arrayBuffer', { value: () => read })
  return { file, finishRead }
}

const onlineEntry: OnlineLUTEntry = {
  id: 'online-look',
  title: 'Online Look',
  sourceUrl: 'https://example.com/online-look.json',
  sourceType: 'catalog-entry',
  cube: {
    url: 'https://example.com/online-look.cube',
    sha256: 'a'.repeat(64),
    bytes: 64,
  },
  tags: [],
}

/**
 * Renders the stage once over the production session store. Its callbacks
 * keep that render's snapshot, so every later session change reaches them
 * only through the store, as a load or reset does before React rerenders.
 */
function renderLutLoadHarness({
  session,
  canApplyLoadedLut = () => true,
}: {
  session: ImageSession | null
  canApplyLoadedLut?: () => boolean
}) {
  setCurrentSession(session)
  const setColorIntent = vi.fn()
  const setLut = vi.fn()
  const invalidateExportGraph = vi.fn()
  const scheduleToast = vi.fn()
  const { result, unmount } = renderHook(() =>
    useRawLookStage({
      baseParams,
      session,
      lut: null,
      setLut,
      setColorIntent,
      lutDataRef: { current: null },
      setLutDataRef: vi.fn(),
      scheduleToast,
      invalidateExportGraph,
      canApplyLoadedLut,
    }),
  )
  return {
    actions: result.current,
    unmount,
    setColorIntent,
    setLut,
    invalidateExportGraph,
    scheduleToast,
    loadedTitles: () =>
      setLut.mock.calls.map(([lut]) => (lut as ParsedLUT | null)?.title),
  }
}

describe('useRawLookStage LUT loads against the current session', () => {
  beforeEach(() => {
    vi.mocked(fetchVerifiedCubeAsset).mockReset()
  })

  it('applies only the newest of two overlapping local picks', async () => {
    const session = createSessionWithoutLook()
    const harness = renderLutLoadHarness({ session })
    const slow = createDeferredCubeFile('Slow Look', 'slow.cube')
    let slowLoad!: Promise<LutLoadOutcome>
    act(() => {
      slowLoad = harness.actions.loadLUT(slow.file)
    })

    await act(async () => {
      await expect(
        harness.actions.loadLUT(createCubeFile('Quick Look', 'quick.cube')),
      ).resolves.toBe('loaded')
    })
    await act(async () => {
      slow.finishRead()
      await expect(slowLoad).resolves.toBe('aborted')
    })

    expect(harness.loadedTitles()).toEqual(['Quick Look'])
    expect(getCurrentSession()?.activeStyle).toMatchObject({
      name: 'Quick Look',
    })
  })

  it('drops a local pick once the stage cancels it', async () => {
    const harness = renderLutLoadHarness({ session: createSession() })
    const pick = createDeferredCubeFile('Cancelled Look', 'cancelled.cube')
    let load!: Promise<LutLoadOutcome>
    act(() => {
      load = harness.actions.loadLUT(pick.file)
    })

    harness.actions.cancelLUTFileLoad()
    await act(async () => {
      pick.finishRead()
      await expect(load).resolves.toBe('aborted')
    })

    expect(harness.setLut).not.toHaveBeenCalled()
    expect(harness.invalidateExportGraph).not.toHaveBeenCalled()
  })

  it('drops a local pick still loading when the stage unmounts', async () => {
    const session = createSessionWithoutLook()
    const harness = renderLutLoadHarness({ session })
    const pick = createDeferredCubeFile('Departed Look', 'departed.cube')
    let load!: Promise<LutLoadOutcome>
    act(() => {
      load = harness.actions.loadLUT(pick.file)
    })

    // The store keeps a loaded session for a return to /raw.
    harness.unmount()
    pick.finishRead()
    await expect(load).resolves.toBe('aborted')

    expect(getCurrentSession()).toBe(session)
    expect(harness.setLut).not.toHaveBeenCalled()
    expect(harness.setColorIntent).not.toHaveBeenCalled()
    expect(harness.invalidateExportGraph).not.toHaveBeenCalled()
    expect(harness.scheduleToast).not.toHaveBeenCalled()
  })

  it('drops a local pick whose source the store replaced before a rerender', async () => {
    const session = createSessionWithoutLook()
    const harness = renderLutLoadHarness({ session })
    const pick = createDeferredCubeFile('Late Look', 'late.cube')
    let load!: Promise<LutLoadOutcome>
    act(() => {
      load = harness.actions.loadLUT(pick.file)
    })
    const replacement = { ...createSessionWithoutLook(), id: 'replacement' }
    setCurrentSession(replacement)

    await act(async () => {
      pick.finishRead()
      await expect(load).resolves.toBe('aborted')
    })

    expect(getCurrentSession()).toBe(replacement)
    expect(harness.setLut).not.toHaveBeenCalled()
    expect(harness.setColorIntent).not.toHaveBeenCalled()
    expect(harness.invalidateExportGraph).not.toHaveBeenCalled()
    expect(harness.scheduleToast).not.toHaveBeenCalled()
  })

  it('drops a local pick whose source the store reset before a rerender', async () => {
    const harness = renderLutLoadHarness({
      session: createSessionWithoutLook(),
    })
    const pick = createDeferredCubeFile('Late Look', 'late.cube')
    let load!: Promise<LutLoadOutcome>
    act(() => {
      load = harness.actions.loadLUT(pick.file)
    })
    setCurrentSession(null)

    await act(async () => {
      pick.finishRead()
      await expect(load).resolves.toBe('aborted')
    })

    expect(getCurrentSession()).toBeNull()
    expect(harness.setLut).not.toHaveBeenCalled()
    expect(harness.setColorIntent).not.toHaveBeenCalled()
  })

  it('gives a pick made after the store took a replacement to that replacement', async () => {
    const harness = renderLutLoadHarness({
      session: createSessionWithoutLook(),
    })
    const replacement = { ...createSessionWithoutLook(), id: 'replacement' }
    setCurrentSession(replacement)

    await act(async () => {
      await expect(
        harness.actions.loadLUT(createCubeFile('Second Look', 'second.cube')),
      ).resolves.toBe('loaded')
    })

    expect(getCurrentSession()).toMatchObject({
      id: 'replacement',
      activeStyle: { kind: 'custom', name: 'Second Look' },
    })
    expect(harness.setColorIntent).not.toHaveBeenCalled()
  })

  it('seeds the detached intent with a pick made after the store was reset', async () => {
    const harness = renderLutLoadHarness({ session: createSession() })
    setCurrentSession(null)

    await act(async () => {
      await expect(
        harness.actions.loadLUT(createCubeFile('Reset Look', 'reset.cube')),
      ).resolves.toBe('loaded')
    })

    expect(getCurrentSession()).toBeNull()
    expect(harness.setColorIntent).toHaveBeenCalledTimes(1)
    const update = harness.setColorIntent.mock.calls[0]![0] as (
      prev: ColorGraphIntent,
    ) => ColorGraphIntent
    expect(update({ ...baseIntent, intensity: 0.4 })).toEqual({
      ...baseIntent,
      styleKind: 'custom',
      builtinPreset: null,
      intensity: 0.7,
    })
  })

  it('lands a pick made before any RAW on the source that arrives meanwhile', async () => {
    const harness = renderLutLoadHarness({ session: null })
    const pick = createDeferredCubeFile('Early Look', 'early.cube')
    let load!: Promise<LutLoadOutcome>
    act(() => {
      load = harness.actions.loadLUT(pick.file)
    })
    const arrived = createSessionWithoutLook()
    setCurrentSession(arrived)

    await act(async () => {
      pick.finishRead()
      await expect(load).resolves.toBe('loaded')
    })

    expect(getCurrentSession()).toMatchObject({
      id: arrived.id,
      activeStyle: { kind: 'custom', name: 'Early Look' },
    })
    expect(harness.setColorIntent).not.toHaveBeenCalled()
  })

  it('keeps session changes published while a pick was loading', async () => {
    const session = createSessionWithoutLook()
    const harness = renderLutLoadHarness({ session })
    const pick = createDeferredCubeFile('Client Look', 'client.cube')
    let load!: Promise<LutLoadOutcome>
    act(() => {
      load = harness.actions.loadLUT(pick.file)
    })
    setCurrentSession(publishPreviewAndCapability)

    await act(async () => {
      pick.finishRead()
      await expect(load).resolves.toBe('loaded')
    })

    expect(getCurrentSession()).toMatchObject({
      id: session.id,
      previewBundle: { boundedHqPreview: publishedBoundedHq },
      exportState: { fullResCapability: publishedCapability },
      activeStyle: { name: 'Client Look' },
    })
  })

  it('refuses a local pick that lands while the workflow refuses LUTs', async () => {
    let canApply = true
    const session = withReadyExport(createSessionWithoutLook())
    const harness = renderLutLoadHarness({
      session,
      canApplyLoadedLut: () => canApply,
    })
    const pick = createDeferredCubeFile('Late Look', 'late.cube')
    let load!: Promise<LutLoadOutcome>
    act(() => {
      load = harness.actions.loadLUT(pick.file)
    })
    canApply = false

    await act(async () => {
      pick.finishRead()
      await expect(load).resolves.toBe('aborted')
    })

    expect(getCurrentSession()).toBe(session)
    expect(harness.setLut).not.toHaveBeenCalled()
    expect(harness.invalidateExportGraph).not.toHaveBeenCalled()
  })

  it('lands an online LUT on the session in the store when it arrives', async () => {
    const download = Promise.withResolvers<{
      bytes: Uint8Array
      sha256: string
    }>()
    vi.mocked(fetchVerifiedCubeAsset).mockReturnValue(download.promise)
    const harness = renderLutLoadHarness({ session: null })
    let load!: Promise<LutLoadOutcome>
    act(() => {
      load = harness.actions.loadOnlineLUT(onlineEntry)
    })
    const arrived = createSessionWithoutLook()
    setCurrentSession(arrived)

    await act(async () => {
      download.resolve({
        bytes: new TextEncoder().encode(createCubeContent('Online Look')),
        sha256: 'b'.repeat(64),
      })
      await expect(load).resolves.toBe('loaded')
    })

    expect(getCurrentSession()).toMatchObject({
      id: arrived.id,
      activeStyle: { kind: 'custom', name: 'Online Look' },
    })
    expect(harness.setColorIntent).not.toHaveBeenCalled()
  })

  it('drops an online LUT that arrives after its photo was replaced', async () => {
    const download = Promise.withResolvers<{
      bytes: Uint8Array
      sha256: string
    }>()
    vi.mocked(fetchVerifiedCubeAsset).mockReturnValue(download.promise)
    const harness = renderLutLoadHarness({
      session: withReadyExport(createSessionWithoutLook()),
    })
    let load!: Promise<LutLoadOutcome>
    act(() => {
      load = harness.actions.loadOnlineLUT(onlineEntry)
    })
    const replacement = withReadyExport({
      ...createSessionWithoutLook(),
      id: 'replacement',
    })
    setCurrentSession(replacement)

    await act(async () => {
      download.resolve({
        bytes: new TextEncoder().encode(createCubeContent('Online Look')),
        sha256: 'b'.repeat(64),
      })
      await expect(load).resolves.toBe('aborted')
    })

    expect(getCurrentSession()).toBe(replacement)
    expect(harness.setLut).not.toHaveBeenCalled()
    expect(harness.setColorIntent).not.toHaveBeenCalled()
    expect(harness.invalidateExportGraph).not.toHaveBeenCalled()
    expect(harness.scheduleToast).not.toHaveBeenCalled()
  })

  it('drops an online LUT that arrives after its photo was reset', async () => {
    const download = Promise.withResolvers<{
      bytes: Uint8Array
      sha256: string
    }>()
    vi.mocked(fetchVerifiedCubeAsset).mockReturnValue(download.promise)
    const harness = renderLutLoadHarness({
      session: createSessionWithoutLook(),
    })
    let load!: Promise<LutLoadOutcome>
    act(() => {
      load = harness.actions.loadOnlineLUT(onlineEntry)
    })
    setCurrentSession(null)

    await act(async () => {
      download.resolve({
        bytes: new TextEncoder().encode(createCubeContent('Online Look')),
        sha256: 'b'.repeat(64),
      })
      await expect(load).resolves.toBe('aborted')
    })

    expect(getCurrentSession()).toBeNull()
    expect(harness.setLut).not.toHaveBeenCalled()
    expect(harness.setColorIntent).not.toHaveBeenCalled()
    expect(harness.scheduleToast).not.toHaveBeenCalled()
  })

  it('reports nothing on the replacement when an online LUT fails after its photo was replaced', async () => {
    const download = Promise.withResolvers<{
      bytes: Uint8Array
      sha256: string
    }>()
    vi.mocked(fetchVerifiedCubeAsset).mockReturnValue(download.promise)
    const harness = renderLutLoadHarness({
      session: createSessionWithoutLook(),
    })
    let load!: Promise<LutLoadOutcome>
    act(() => {
      load = harness.actions.loadOnlineLUT(onlineEntry)
    })
    const replacement = { ...createSessionWithoutLook(), id: 'replacement' }
    setCurrentSession(replacement)

    await act(async () => {
      download.reject(new Error('network down'))
      await expect(load).resolves.toBe('aborted')
    })

    expect(getCurrentSession()).toBe(replacement)
    expect(harness.scheduleToast).not.toHaveBeenCalled()
  })

  it('still reports an online LUT failure on the photo it was started on', async () => {
    vi.mocked(fetchVerifiedCubeAsset).mockRejectedValue(
      new Error('network down'),
    )
    const harness = renderLutLoadHarness({
      session: createSessionWithoutLook(),
    })

    await act(async () => {
      await expect(harness.actions.loadOnlineLUT(onlineEntry)).resolves.toBe(
        'failed',
      )
    })

    expect(getCurrentSession()?.renderState.lastErrorCode).toBe(
      'LUT_PARSE_FAILED',
    )
    expect(harness.scheduleToast).toHaveBeenCalledTimes(1)
  })

  it('drops an online LUT whose request signal aborted', async () => {
    const download = Promise.withResolvers<{
      bytes: Uint8Array
      sha256: string
    }>()
    vi.mocked(fetchVerifiedCubeAsset).mockReturnValue(download.promise)
    const session = createSessionWithoutLook()
    const harness = renderLutLoadHarness({ session })
    const controller = new AbortController()
    let load!: Promise<LutLoadOutcome>
    act(() => {
      load = harness.actions.loadOnlineLUT(onlineEntry, {
        signal: controller.signal,
      })
    })
    controller.abort()

    await act(async () => {
      download.resolve({
        bytes: new TextEncoder().encode(createCubeContent('Online Look')),
        sha256: 'b'.repeat(64),
      })
      await expect(load).resolves.toBe('aborted')
    })

    expect(getCurrentSession()).toBe(session)
    expect(harness.setLut).not.toHaveBeenCalled()
  })
})

describe('useRawLookStage effective intent against the store', () => {
  afterEach(() => {
    setProcessingParams({ ...baseIntent })
  })

  /**
   * Renders the stage from the production stores, as the workflow does, so
   * the rendered params and `getEffectiveColorIntent` read the same stored
   * intent and session.
   */
  function renderFromStore({
    session,
    params = baseIntent,
  }: {
    session: ImageSession | null
    params?: ColorGraphIntent
  }) {
    setCurrentSession(session)
    setProcessingParams(params)
    const lut = createLut()

    return renderHook(() =>
      useRawLookStage({
        baseParams: useProcessingParamsValue(),
        session: useAtomValue(currentSessionAtom, { store: jotaiStore }),
        lut,
        setLut: vi.fn(),
        setColorIntent: vi.fn(),
        lutDataRef: { current: lut },
        setLutDataRef: vi.fn(),
        scheduleToast: vi.fn(),
        invalidateExportGraph: vi.fn(),
        canApplyLoadedLut: () => true,
      }),
    )
  }

  function withLookIntensity(intensity: number) {
    return (prev: ImageSession | null): ImageSession | null =>
      prev?.activeStyle
        ? {
            ...prev,
            activeStyle: { ...prev.activeStyle, currentIntensity: intensity },
          }
        : prev
  }

  it('reads the stored intent and session without any render', () => {
    setCurrentSession(null)
    setProcessingParams({ ...baseIntent, userContrast: 0.2 })

    expect(getEffectiveColorIntent()).toBe(getProcessingParams())

    setCurrentSession({
      ...createSession(),
      activeStyle: {
        kind: 'custom',
        name: 'Client Look',
        defaultIntensity: 0.7,
        currentIntensity: 0.37,
      },
    })

    expect(getEffectiveColorIntent()).toEqual({
      ...baseIntent,
      userContrast: 0.2,
      styleKind: 'custom',
      intensity: 0.37,
    })
  })

  it('agrees with the rendered params after a detached tone change in the same tick', () => {
    const { result } = renderFromStore({ session: null })
    const toned = { ...baseIntent, userExposureEv: 1.25 }

    act(() => {
      setProcessingParams(toned)
      expect(getEffectiveColorIntent()).toBe(toned)
      expect(result.current.params).toBe(baseIntent)
    })

    expect(result.current.params).toBe(toned)
    expect(getEffectiveColorIntent()).toBe(result.current.params)
  })

  it('agrees with the rendered params after a tone and a Strength change in the same tick', () => {
    const { result } = renderFromStore({ session: createSession() })
    expect(getEffectiveColorIntent()).toEqual(result.current.params)

    act(() => {
      setProcessingParams({ ...baseIntent, userShadows: 0.3 })
      setCurrentSession(withLookIntensity(0.25))
      expect(getEffectiveColorIntent()).toEqual({
        ...baseIntent,
        userShadows: 0.3,
        styleKind: 'custom',
        intensity: 0.25,
      })
    })

    expect(result.current.params).toEqual(getEffectiveColorIntent())
  })

  it('projects a zero Strength as the custom look, not as no look', () => {
    const { result } = renderFromStore({ session: createSession() })

    act(() => {
      setCurrentSession(withLookIntensity(0))
      expect(getEffectiveColorIntent()).toMatchObject({
        styleKind: 'custom',
        intensity: 0,
      })
    })

    expect(result.current.params).toEqual(getEffectiveColorIntent())
  })

  it('agrees with the rendered params after the session look is cleared in the same tick', () => {
    const detachedLook: ColorGraphIntent = {
      ...baseIntent,
      styleKind: 'custom',
      intensity: 1,
    }
    const { result } = renderFromStore({
      session: createSession(),
      params: detachedLook,
    })
    expect(result.current.params).toBe(detachedLook)
    expect(getEffectiveColorIntent()).toBe(detachedLook)

    act(() => {
      setCurrentSession((prev) =>
        prev ? { ...prev, activeStyle: null } : prev,
      )
      expect(getEffectiveColorIntent()).toEqual({
        ...detachedLook,
        styleKind: 'none',
        builtinPreset: null,
        intensity: 0.7,
      })
    })

    expect(result.current.params).toEqual(getEffectiveColorIntent())
  })

  it('reuses the stored intent for a look-less session that projects nothing new', () => {
    const { result } = renderFromStore({ session: createSessionWithoutLook() })

    expect(result.current.params).toBe(baseIntent)
    expect(getEffectiveColorIntent()).toBe(baseIntent)
  })

  it('leaves the effective intent alone when only the LUT contract changes', () => {
    const carried: ColorGraphIntent = {
      ...baseIntent,
      styleKind: 'custom',
      intensity: 1,
    }
    const { result } = renderFromStore({
      session: createSession(),
      params: carried,
    })

    act(() => {
      setCurrentSession((prev) =>
        prev
          ? {
              ...prev,
              lutProfileSelection: buildLUTContractSelectionState(createLut()),
            }
          : prev,
      )
      expect(getEffectiveColorIntent()).toBe(carried)
    })

    expect(result.current.params).toBe(carried)
  })

  it('keeps view state, LUT bytes and RAW exposure out of the effective intent', () => {
    renderFromStore({
      session: {
        ...createSession(),
        viewState: { ...createSession().viewState, mode: 'compare' },
      },
    })

    expect(Object.keys(getEffectiveColorIntent()).sort()).toEqual(
      [...COLOR_GRAPH_INTENT_KEYS].sort(),
    )
    expect(Object.keys(getProcessingParams()).sort()).toEqual(
      [...COLOR_GRAPH_INTENT_KEYS].sort(),
    )
  })
})
