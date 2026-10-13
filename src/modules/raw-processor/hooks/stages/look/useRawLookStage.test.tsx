import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import {
  COLOR_GRAPH_INTENT_KEYS,
  NEUTRAL_USER_COLOR_INTENT,
  pickColorGraphIntent,
} from '@lumaforge/luma-color-runtime'
import { createBlobOutputResult } from '@lumaforge/render-engine/export'
import { sourceContentIdFromBytes } from '@lumaforge/render-engine/manifest'
import { act, cleanup, renderHook } from '@testing-library/react'
import i18n from 'i18next'
import { atom, createStore } from 'jotai'
import type { ComponentType, PropsWithChildren, SetStateAction } from 'react'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest'

import { I18nProvider } from '~/lib/i18n'
import { jotaiStore } from '~/lib/jotai'
import type { ParsedLUT } from '~/lib/lut/cube-parser'
import { parseCubeLUT } from '~/lib/lut/cube-parser'
import { getStoredLUTContractSelection } from '~/lib/lut/profile-resolution'
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
  getLut as getStoredLut,
  getProcessingParams,
  setLut as setStoredLut,
  setProcessingParams,
} from '../../../state/workflow.atoms'
import { useRawToolAdjustments } from '../../useRawToolState'
import { useRawLookStage } from './useRawLookStage'

vi.mock('~/lib/profiles/fetch', () => ({
  createBrowserOnlineProfileCache: vi.fn(() => ({})),
  fetchVerifiedCubeAsset: vi.fn(),
  fetchCachedBytesWithLimit: vi.fn(),
}))

const toastMock = vi.hoisted(() => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

vi.mock('sonner', () => toastMock)

// The stage reads and writes the session, and reads the LUT, in the
// production store, so every test seeds that store and leaves it empty. A
// mounted hook would re-render on the reset, so it unmounts first.
beforeEach(() => {
  setCurrentSession(null)
  setStoredLut(null)
})

afterEach(() => {
  cleanup()
  setCurrentSession(null)
  setStoredLut(null)
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
  setStoredLut(lut)
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
  // The LUT lands in the production store, as the workflow's setter does.
  const setLut = vi.fn((next: ParsedLUT | null) => setStoredLut(next))
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
    setStoredLut(lut)
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

  it('applies a contract choice to the LUT loaded since the callback was made, with its own hash', async () => {
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
    localStorage.clear()
    onTestFinished(() => localStorage.clear())

    await act(async () => {
      await expect(
        harness.actions.loadLUT(createCubeFile('Second Look', 'second.cube')),
      ).resolves.toBe('loaded')
    })
    const lutB = getStoredLut()!
    expect(lutB.fingerprint).not.toBe(lutA.fingerprint)
    expect(lutB.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(lutB.sha256).not.toBe(sha256A)
    harness.actions.setIntensity(0.43)
    harness.setLut.mockClear()

    // The callback was made while LUT A was current; it applies to LUT B.
    harness.actions.selectLUTProfile('display-srgb')

    expect(harness.setLut).toHaveBeenCalledTimes(1)
    const selected = harness.setLut.mock.lastCall?.[0] as ParsedLUT
    expect(selected.fingerprint).toBe(lutB.fingerprint)
    expect(selected.data).toBe(lutB.data)
    expect(selected.sha256).toBe(lutB.sha256)
    expect(selected.profileResolution).toMatchObject({
      kind: 'confirmed',
      confidence: 'user',
    })
    expect(harness.readSession()?.activeStyle).toMatchObject({
      kind: 'custom',
      name: 'Second Look',
      currentIntensity: 0.43,
      lutAsset: { fingerprint: lutB.fingerprint, sha256: lutB.sha256 },
    })
    expect(harness.readSession()?.lutProfileSelection).toMatchObject({
      fingerprint: lutB.fingerprint,
    })
    expect(getStoredLUTContractSelection(lutB.fingerprint)).toBeDefined()
    expect(getStoredLUTContractSelection(lutA.fingerprint)).toBeUndefined()
  })

  it('refuses a contract choice made after the LUT was cleared, before a rerender', () => {
    const lut = createLut()
    const session = {
      ...createSession(),
      lutProfileSelection: buildLUTContractSelectionState(lut),
    }
    const harness = renderLookStageHarness({ session, lut })
    localStorage.clear()
    onTestFinished(() => localStorage.clear())

    harness.actions.clearLUT()
    const clearedSession = harness.readSession()
    const writes = {
      setLut: harness.setLut.mock.calls.length,
      session: harness.sessionNotifications.mock.calls.length,
      invalidations: harness.invalidateExportGraph.mock.calls.length,
      toasts: harness.scheduleToast.mock.calls.length,
    }
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    onTestFinished(() => setItem.mockRestore())

    harness.actions.selectLUTProfile('display-srgb')

    expect(getStoredLut()).toBeNull()
    expect(harness.setLut).toHaveBeenCalledTimes(writes.setLut)
    expect(harness.readSession()).toBe(clearedSession)
    expect(harness.sessionNotifications).toHaveBeenCalledTimes(writes.session)
    expect(harness.invalidateExportGraph).toHaveBeenCalledTimes(
      writes.invalidations,
    )
    expect(harness.setColorIntent).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(getStoredLUTContractSelection(lut.fingerprint)).toBeUndefined()
    expect(harness.scheduleToast).toHaveBeenCalledTimes(writes.toasts + 1)
  })

  it('refuses a detached contract choice once the store dropped the LUT', () => {
    const lut = createLut()
    const harness = renderLookStageHarness({
      session: null,
      params: { ...baseIntent, styleKind: 'custom', intensity: 0.37 },
      lut,
    })
    localStorage.clear()
    onTestFinished(() => localStorage.clear())
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    onTestFinished(() => setItem.mockRestore())

    // A reset drops the LUT in the store without this hook rerendering.
    setStoredLut(null)
    harness.actions.selectLUTProfile('display-srgb')

    expect(harness.setLut).not.toHaveBeenCalled()
    expect(harness.setColorIntent).not.toHaveBeenCalled()
    expect(harness.paramsNotifications).not.toHaveBeenCalled()
    expect(harness.readSession()).toBeNull()
    expect(harness.invalidateExportGraph).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(getStoredLUTContractSelection(lut.fingerprint)).toBeUndefined()
    expect(harness.scheduleToast).toHaveBeenCalledTimes(1)
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
    const strength = renderHook(() => useRawToolAdjustments())

    expect(harness.actions.params.intensity).toBe(0.37)
    // The strength the surfaces show is the tool slice's, resolved from the
    // same session; the stage hands out no second copy.
    expect(strength.result.current.activeIntensity).toBe(0.37)
    expect(harness.actions).not.toHaveProperty('activeIntensity')
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
})

describe('useRawLookStage notifications', () => {
  /**
   * Renders the stage over the production session store and keeps every
   * scheduled toast, so a test can tell what the stage decided to report
   * from when it is shown.
   */
  function renderNotificationHarness({
    session,
    lut = null,
    canApplyLoadedLut = () => true,
    wrapper,
  }: {
    session: ImageSession | null
    lut?: ParsedLUT | null
    canApplyLoadedLut?: () => boolean
    wrapper?: ComponentType<PropsWithChildren>
  }) {
    setCurrentSession(session)
    setStoredLut(lut)
    const scheduled: Array<() => void> = []
    const scheduleToast = vi.fn((show: () => void) => {
      scheduled.push(show)
    })
    const setLut = vi.fn((next: ParsedLUT | null) => setStoredLut(next))
    const { result } = renderHook(
      () =>
        useRawLookStage({
          baseParams,
          session,
          lut,
          setLut,
          setColorIntent: vi.fn(),
          lutDataRef: { current: lut },
          setLutDataRef: vi.fn(),
          scheduleToast,
          invalidateExportGraph: vi.fn(),
          canApplyLoadedLut,
        }),
      { wrapper },
    )
    return {
      actions: result.current,
      scheduleToast,
      setLut,
      runScheduled() {
        for (const show of scheduled.splice(0)) show()
      },
    }
  }

  function shownToasts() {
    return {
      error: toastMock.toast.error.mock.calls,
      success: toastMock.toast.success.mock.calls,
      info: toastMock.toast.info.mock.calls,
    }
  }

  beforeEach(() => {
    vi.mocked(fetchVerifiedCubeAsset).mockReset()
    toastMock.toast.error.mockReset()
    toastMock.toast.success.mockReset()
    toastMock.toast.info.mockReset()
  })

  it('reports a loaded local LUT by title and grid only when its scheduled task runs', async () => {
    const harness = renderNotificationHarness({
      session: createSessionWithoutLook(),
    })

    await act(async () => {
      await expect(
        harness.actions.loadLUT(createCubeFile('Client Look', 'look.cube')),
      ).resolves.toBe('loaded')
    })

    expect(harness.scheduleToast).toHaveBeenCalledTimes(1)
    expect(toastMock.toast.success).not.toHaveBeenCalled()
    harness.runScheduled()
    expect(shownToasts()).toEqual({
      error: [],
      success: [['Loaded LUT: Client Look', { description: '17³ grid' }]],
      info: [],
    })
  })

  it('reports a loaded online LUT by title and grid', async () => {
    vi.mocked(fetchVerifiedCubeAsset).mockResolvedValue({
      bytes: new TextEncoder().encode(createCubeContent('Online Look')),
      sha256: 'b'.repeat(64),
    })
    const harness = renderNotificationHarness({
      session: createSessionWithoutLook(),
    })

    await act(async () => {
      await expect(harness.actions.loadOnlineLUT(onlineEntry)).resolves.toBe(
        'loaded',
      )
    })

    harness.runScheduled()
    expect(shownToasts()).toEqual({
      error: [],
      success: [['Loaded LUT: Online Look', { description: '17³ grid' }]],
      info: [],
    })
  })

  it('reports an unsupported file format and records its code', async () => {
    const harness = renderNotificationHarness({
      session: createSessionWithoutLook(),
    })

    await act(async () => {
      await expect(
        harness.actions.loadLUT(
          Object.assign(new File(['not a lut'], 'look.txt'), {
            text: () => Promise.resolve('not a lut'),
          }),
        ),
      ).resolves.toBe('failed')
    })

    expect(getCurrentSession()?.renderState.lastErrorCode).toBe(
      'LUT_UNSUPPORTED_FORMAT',
    )
    harness.runScheduled()
    expect(shownToasts()).toEqual({
      error: [
        [
          'Unsupported LUT format',
          { description: 'Only .cube files are supported' },
        ],
      ],
      success: [],
      info: [],
    })
  })

  it('reports a parser failure with the parser detail', async () => {
    const harness = renderNotificationHarness({
      session: createSessionWithoutLook(),
    })
    const content = 'TITLE "Broken"\nLUT_3D_SIZE 2\n0 0 0\n'

    await act(async () => {
      await expect(
        harness.actions.loadLUT(
          Object.assign(new File([content], 'broken.cube'), {
            text: () => Promise.resolve(content),
          }),
        ),
      ).resolves.toBe('failed')
    })

    expect(harness.setLut).not.toHaveBeenCalled()
    expect(getCurrentSession()?.renderState.lastErrorCode).toBe(
      'LUT_PARSE_FAILED',
    )
    harness.runScheduled()
    expect(shownToasts()).toEqual({
      error: [
        [
          'Failed to load LUT',
          { description: 'Invalid .cube file: expected 8 entries, got 1' },
        ],
      ],
      success: [],
      info: [],
    })
  })

  it('reports an incomplete catalog contract as a failed load', async () => {
    vi.mocked(fetchVerifiedCubeAsset).mockResolvedValue({
      bytes: new TextEncoder().encode(createCubeContent('Online Look')),
      sha256: 'b'.repeat(64),
    })
    const harness = renderNotificationHarness({
      session: createSessionWithoutLook(),
    })

    await act(async () => {
      await expect(
        harness.actions.loadOnlineLUT({
          ...onlineEntry,
          trustedContract: {
            role: 'combined-look-output',
            inputProfile: 'panasonic-vgamut-vlog',
          },
        }),
      ).resolves.toBe('failed')
    })

    expect(getCurrentSession()?.renderState.lastErrorCode).toBe(
      'LUT_PARSE_FAILED',
    )
    harness.runScheduled()
    expect(shownToasts()).toEqual({
      error: [
        [
          'Failed to load LUT',
          { description: 'Unsupported LUT color contract.' },
        ],
      ],
      success: [],
      info: [],
    })
  })

  it('reports an incomplete contract choice by the profile it named', () => {
    const lut = createLut()
    const harness = renderNotificationHarness({ session: createSession(), lut })

    harness.actions.selectLUTProfile('not-a-profile')

    expect(harness.setLut).not.toHaveBeenCalled()
    harness.runScheduled()
    expect(shownToasts()).toEqual({
      error: [['Incomplete LUT contract', { description: 'not-a-profile' }]],
      success: [],
      info: [],
    })
  })

  it('reports a contract choice made with no LUT loaded', () => {
    const harness = renderNotificationHarness({ session: createSession() })

    harness.actions.selectLUTProfile('display-srgb')

    harness.runScheduled()
    expect(shownToasts()).toEqual({
      error: [['No LUT loaded']],
      success: [],
      info: [],
    })
  })

  it('reports nothing for a contract choice that applies', () => {
    const lut = createLut()
    const harness = renderNotificationHarness({ session: createSession(), lut })

    harness.actions.selectLUTProfile('display-srgb')

    expect(harness.setLut).toHaveBeenCalledTimes(1)
    expect(harness.scheduleToast).not.toHaveBeenCalled()
  })

  it('reports nothing for an aborted request, even one that also failed', async () => {
    const download = Promise.withResolvers<{
      bytes: Uint8Array
      sha256: string
    }>()
    vi.mocked(fetchVerifiedCubeAsset).mockReturnValue(download.promise)
    const harness = renderNotificationHarness({
      session: createSessionWithoutLook(),
    })
    const controller = new AbortController()
    let load!: Promise<LutLoadOutcome>
    act(() => {
      load = harness.actions.loadOnlineLUT(onlineEntry, {
        signal: controller.signal,
      })
    })
    controller.abort()

    await act(async () => {
      download.reject(new Error('network down'))
      await expect(load).resolves.toBe('aborted')
    })

    expect(harness.scheduleToast).not.toHaveBeenCalled()
    expect(getCurrentSession()?.renderState.lastErrorCode).toBeUndefined()
  })

  it('reports a cleared LUT', () => {
    const lut = createLut()
    const harness = renderNotificationHarness({ session: createSession(), lut })

    harness.actions.clearLUT()

    harness.runScheduled()
    expect(shownToasts()).toEqual({
      error: [],
      success: [],
      info: [['LUT cleared']],
    })
  })

  it('describes a load failure that carried no message of its own', async () => {
    vi.mocked(fetchVerifiedCubeAsset).mockRejectedValue('socket closed')
    const harness = renderNotificationHarness({
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
    harness.runScheduled()
    expect(shownToasts()).toEqual({
      error: [['Failed to load LUT', { description: 'Failed to parse LUT' }]],
      success: [],
      info: [],
    })
  })

  describe('in the current locale', () => {
    afterEach(async () => {
      localStorage.clear()
      await act(() => i18n.changeLanguage('en'))
    })

    it('uses the locale current when a download lands, not when it began', async () => {
      const download = Promise.withResolvers<{
        bytes: Uint8Array
        sha256: string
      }>()
      vi.mocked(fetchVerifiedCubeAsset).mockReturnValue(download.promise)
      await act(() => i18n.changeLanguage('en'))
      const harness = renderNotificationHarness({
        session: createSessionWithoutLook(),
        wrapper: I18nProvider,
      })
      let load!: Promise<LutLoadOutcome>
      act(() => {
        load = harness.actions.loadOnlineLUT(onlineEntry)
      })

      // The language menu switches while the LUT downloads.
      localStorage.setItem('lumaforge.locale', 'zh-CN')
      await act(() => i18n.changeLanguage('zh-CN'))
      await act(async () => {
        download.resolve({
          bytes: new TextEncoder().encode(createCubeContent('Online Look')),
          sha256: 'b'.repeat(64),
        })
        await expect(load).resolves.toBe('loaded')
      })

      harness.runScheduled()
      expect(shownToasts()).toEqual({
        error: [],
        success: [['已载入 LUT：Online Look', { description: '17³ 网格' }]],
        info: [],
      })
    })
  })
})

describe('useRawLookStage effective intent against the store', () => {
  afterEach(() => {
    cleanup()
    setProcessingParams({ ...baseIntent })
  })

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
})
