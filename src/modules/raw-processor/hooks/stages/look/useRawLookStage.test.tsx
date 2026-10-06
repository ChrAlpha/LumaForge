import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import {
  COLOR_GRAPH_INTENT_KEYS,
  NEUTRAL_USER_COLOR_INTENT,
  pickColorGraphIntent,
} from '@lumaforge/luma-color-runtime'
import { createBlobOutputResult } from '@lumaforge/render-engine/export'
import { act, renderHook } from '@testing-library/react'
import { atom, createStore } from 'jotai'
import type { SetStateAction } from 'react'
import { describe, expect, it, vi } from 'vitest'

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

/** The stored color intent the hook renders from; it carries no view. */
const baseIntent: ColorGraphIntent = Object.freeze({
  ...NEUTRAL_USER_COLOR_INTENT,
  intensity: 0.7,
  styleKind: 'none',
  builtinPreset: null,
})
const baseParams: ColorGraphIntent = baseIntent

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

type SetColorIntentUpdate =
  | ColorGraphIntent
  | ((prev: ColorGraphIntent) => ColorGraphIntent)

/**
 * Backs the hook with a real store, so updaters run against whatever is
 * current when an action fires. The hook renders once and never rerenders:
 * `actions` keep the initial render's snapshot, like a callback captured
 * before React commits concurrent updates.
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
  const store = createStore()
  const sessionAtom = atom<ImageSession | null>(session)
  const paramsAtom = atom<ColorGraphIntent>(params)
  const sessionNotifications = vi.fn()
  const paramsNotifications = vi.fn()
  store.sub(sessionAtom, sessionNotifications)
  store.sub(paramsAtom, paramsNotifications)

  const sessionRef = { current: session }
  const setSession = vi.fn((update: SetStateAction<ImageSession | null>) =>
    store.set(sessionAtom, update),
  )
  const setColorIntent = vi.fn((update: SetColorIntentUpdate) =>
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
    sessionRef,
    setSession,
    setColorIntent,
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
        sessionRef: { current: session },
        setSession: vi.fn(),
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
        sessionRef: { current: session },
        setSession: vi.fn(),
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
        sessionRef: { current: session },
        setSession: vi.fn(),
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
    const session = createSession()
    const setColorIntent = vi.fn()
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
    expect(setSession).toHaveBeenCalledTimes(1)
    expect(setColorIntent).not.toHaveBeenCalled()
  })

  it('selects LUT profiles in the active session without writing the detached intent', () => {
    const session = createSession()
    const setColorIntent = vi.fn()
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
    expect(setSession).toHaveBeenCalledTimes(1)
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
    expect(harness.setSession).toHaveBeenCalledTimes(1)
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
      const detachedParams: ColorGraphIntent = {
        ...baseIntent,
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
