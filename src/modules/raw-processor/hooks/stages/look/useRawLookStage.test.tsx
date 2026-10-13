import type { ColorGraphIntent, ParsedLUT } from '@lumaforge/luma-color-runtime'
import {
  NEUTRAL_USER_COLOR_INTENT,
  parseCubeLUT,
} from '@lumaforge/luma-color-runtime'
import { act, cleanup, renderHook } from '@testing-library/react'
import i18n from 'i18next'
import type { ComponentType, PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '~/lib/i18n'
import { getStoredLUTContractSelection } from '~/lib/lut/profile-resolution'
import type { OnlineLUTEntry } from '~/lib/profiles/catalog'
import { fetchVerifiedCubeAsset } from '~/lib/profiles/fetch'

import type { ImageSession, StyleAsset } from '../../../model/session'
import type { LutLoadOutcome } from '../../../services/look/orchestrate-lut-load'
import {
  getCurrentSession,
  setCurrentSession,
} from '../../../state/session.atoms'
import {
  getEffectiveColorIntent,
  getLut,
  getProcessingParams,
  setColorIntent,
  setLut,
  setProcessingParams,
} from '../../../state/workflow.atoms'
import {
  createDeferredTestCubeFile,
  createTestCube,
  createTestCubeFile,
  createTestSession,
} from '../../../test-support/builders'
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

// The stage reads and writes the session, intent and LUT in the production
// store; a mounted hook would rerender on the reset, so it unmounts first.
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(fetchVerifiedCubeAsset).mockReset()
  setCurrentSession(null)
  setLut(null)
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  setCurrentSession(null)
  setLut(null)
})

const baseIntent: ColorGraphIntent = Object.freeze({
  ...NEUTRAL_USER_COLOR_INTENT,
  intensity: 0.7,
  styleKind: 'none',
  builtinPreset: null,
})
const detachedLook: ColorGraphIntent = { ...baseIntent, styleKind: 'custom' }

function clientLook(currentIntensity = 1): StyleAsset {
  return {
    kind: 'custom',
    name: 'Client Look',
    defaultIntensity: 0.7,
    currentIntensity,
  }
}

function createSession(activeStyle: StyleAsset | null = clientLook()) {
  return createTestSession({ activeStyle })
}

function createLut() {
  return parseCubeLUT(createTestCube('Client Look'), {
    sourceName: 'look.cube',
  })
}

/** jsdom's File cannot read text, so the file answers `text()` itself. */
function textFile(content: string, name: string) {
  return Object.assign(new File([content], name), {
    text: () => Promise.resolve(content),
  })
}

function cubeDownload(title = 'Online Look') {
  return {
    bytes: new TextEncoder().encode(createTestCube(title)),
    sha256: 'b'.repeat(64),
  }
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
 * Seeds the production store and renders the stage once, never again:
 * `actions` keep that render's callbacks, like ones captured before React
 * commits concurrent updates. Each export invalidation records the look the
 * store held when it ran; scheduled toasts wait for `runScheduled`.
 */
function renderLookStage({
  session,
  params = baseIntent,
  lut = null,
  wrapper,
}: {
  session: ImageSession | null
  params?: ColorGraphIntent
  lut?: ParsedLUT | null
  wrapper?: ComponentType<PropsWithChildren>
}) {
  setCurrentSession(session)
  setLut(lut)
  setProcessingParams(params)
  const invalidations: Array<{
    styleKind: ColorGraphIntent['styleKind']
    intensity: number
    lut: string | null
  }> = []
  const invalidateExportGraph = vi.fn(() => {
    const { styleKind, intensity } = getEffectiveColorIntent()
    invalidations.push({ styleKind, intensity, lut: getLut()?.title ?? null })
  })
  const scheduled: Array<() => void> = []
  const scheduleToast = vi.fn((show: () => void) => {
    scheduled.push(show)
  })

  const { result, unmount } = renderHook(
    () =>
      useRawLookStage({
        baseParams: params,
        session,
        lut,
        scheduleToast,
        invalidateExportGraph,
        canApplyLoadedLut: () => true,
      }),
    { wrapper },
  )

  return {
    actions: result.current,
    unmount,
    invalidations,
    scheduleToast,
    runScheduled() {
      for (const show of scheduled.splice(0)) show()
    },
  }
}

type LookStageHarness = ReturnType<typeof renderLookStage>
type LookStage = LookStageHarness['actions']

describe('useRawLookStage', () => {
  it('renders the stored intent with the session look projected over it', () => {
    const { actions } = renderLookStage({
      session: createSession(clientLook(0.37)),
    })

    expect(actions.params).toEqual({
      ...baseIntent,
      styleKind: 'custom',
      intensity: 0.37,
    })
    expect(actions.currentLutName).toBe('Client Look')
  })

  describe('look actions read the store when they fire', () => {
    it('applies Strength and clear to a session published after a session-less render', () => {
      const harness = renderLookStage({
        session: null,
        params: detachedLook,
        lut: createLut(),
      })

      // Ingest publishes the new session before React rerenders.
      setCurrentSession(createSession())
      harness.actions.setIntensity(0.4)
      expect(getCurrentSession()?.activeStyle?.currentIntensity).toBe(0.4)

      harness.actions.clearLUT()
      expect(getCurrentSession()?.activeStyle).toBeNull()
      expect(getProcessingParams()).toBe(detachedLook)
    })

    it('writes the detached intent the store holds once the rendered session is reset', () => {
      const harness = renderLookStage({
        session: createSession(),
        params: detachedLook,
        lut: createLut(),
      })

      setCurrentSession(null)
      setColorIntent((prev) => ({ ...prev, userContrast: 25 }))
      harness.actions.setIntensity(0.4)
      harness.actions.clearLUT()

      expect(getCurrentSession()).toBeNull()
      expect(getProcessingParams()).toEqual({
        ...baseIntent,
        userContrast: 25,
        intensity: 0.4,
      })
    })

    it('keeps the Strength on a session look, and on the detached intent once the session has none', () => {
      const harness = renderLookStage({
        session: createSession(),
        lut: createLut(),
      })

      harness.actions.setIntensity(0.37)
      harness.actions.setIntensity(0.62)
      expect(getCurrentSession()?.activeStyle?.currentIntensity).toBe(0.62)
      expect(getProcessingParams()).toBe(baseIntent)

      harness.actions.clearLUT()
      harness.actions.setIntensity(0.4)
      expect(getCurrentSession()?.activeStyle).toBeNull()
      expect(getProcessingParams()).toEqual({ ...baseIntent, intensity: 0.4 })
    })

    it('invalidates the export graph only once the store holds the change', () => {
      const harness = renderLookStage({
        session: createSession(),
        lut: createLut(),
      })

      harness.actions.setIntensity(0.62)
      harness.actions.clearLUT()
      setCurrentSession(null)
      harness.actions.setIntensity(0.4)

      expect(harness.invalidations).toEqual([
        { styleKind: 'custom', intensity: 0.62, lut: 'Client Look' },
        { styleKind: 'none', intensity: 0.7, lut: null },
        { styleKind: 'none', intensity: 0.4, lut: null },
      ])
    })

    it.each([
      ['the session look', () => createSession(), baseIntent, 1],
      ['the detached intent', () => null, detachedLook, 0.7],
    ])(
      'leaves the export alone when %s already holds the Strength',
      (_, createRendered, params, value) => {
        const session = createRendered()
        const harness = renderLookStage({ session, params, lut: createLut() })

        harness.actions.setIntensity(value)

        expect(getCurrentSession()).toBe(session)
        expect(getProcessingParams()).toBe(params)
        expect(harness.invalidations).toEqual([])
      },
    )

    it('keeps view and geometry published after render, and a same-tick Strength, through a contract change and a clear', () => {
      const lut = createLut()
      const harness = renderLookStage({ session: createSession(), lut })
      const viewState: ImageSession['viewState'] = {
        ...createSession().viewState,
        mode: 'compare',
        compareSplit: 0.62,
      }
      const exportGeometry = {
        matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        constrainCrop: true,
      }
      setCurrentSession(
        (prev) => prev && { ...prev, viewState, exportGeometry },
      )

      harness.actions.setIntensity(0.43)
      harness.actions.selectLUTProfile('display-srgb')
      expect(getCurrentSession()).toMatchObject({
        activeStyle: { kind: 'custom', currentIntensity: 0.43 },
        lutProfileSelection: { fingerprint: lut.fingerprint },
      })

      harness.actions.clearLUT()
      expect(getCurrentSession()).toMatchObject({ activeStyle: null })
      expect(getCurrentSession()?.viewState).toBe(viewState)
      expect(getCurrentSession()?.exportGeometry).toBe(exportGeometry)
    })

    it('carries a detached Strength through a contract change and starts a LUT loaded after a clear at the default', async () => {
      const harness = renderLookStage({
        session: null,
        params: detachedLook,
        lut: createLut(),
      })

      harness.actions.setIntensity(0.43)
      harness.actions.selectLUTProfile('display-srgb')
      expect(getProcessingParams()).toEqual({
        ...detachedLook,
        intensity: 0.43,
      })

      harness.actions.clearLUT()
      await act(async () => {
        await harness.actions.loadLUT(
          createTestCubeFile('Second Look', 'second.cube'),
        )
      })
      expect(getProcessingParams()).toEqual(detachedLook)
    })

    it('refuses a contract choice made after the LUT was cleared, before a rerender', () => {
      const lut = createLut()
      const harness = renderLookStage({ session: createSession(), lut })

      harness.actions.clearLUT()
      const cleared = getCurrentSession()
      harness.actions.selectLUTProfile('display-srgb')

      expect(getLut()).toBeNull()
      expect(getCurrentSession()).toBe(cleared)
      expect(getStoredLUTContractSelection(lut.fingerprint)).toBeUndefined()
      expect(harness.invalidations).toHaveLength(1)
    })

    it('keeps the hash the session look holds only for the same LUT when the contract changes', () => {
      const lut = createLut()
      const harness = renderLookStage({ session: createSession(), lut })
      const sha256 = 'c'.repeat(64)
      const choose = (fingerprint: string) => {
        setCurrentSession((prev) =>
          prev?.activeStyle
            ? {
                ...prev,
                activeStyle: {
                  ...prev.activeStyle,
                  lutAsset: {
                    format: 'cube',
                    dimension: 17,
                    fingerprint,
                    sha256,
                  },
                },
              }
            : prev,
        )
        harness.actions.selectLUTProfile('display-srgb')
        return getCurrentSession()?.activeStyle?.lutAsset
      }

      expect(choose(lut.fingerprint)?.sha256).toBe(sha256)
      const other = choose('lut-other')
      expect(other?.fingerprint).toBe(lut.fingerprint)
      expect(other?.sha256).toBeUndefined()
    })
  })

  describe('local picks', () => {
    it('applies only the newest of two overlapping picks', async () => {
      const harness = renderLookStage({ session: createSession(null) })
      const slow = createDeferredTestCubeFile('Slow Look', 'slow.cube')
      let slowLoad!: Promise<LutLoadOutcome>
      act(() => {
        slowLoad = harness.actions.loadLUT(slow.file)
      })

      await act(async () => {
        await expect(
          harness.actions.loadLUT(
            createTestCubeFile('Quick Look', 'quick.cube'),
          ),
        ).resolves.toBe('loaded')
      })
      await act(async () => {
        slow.finishRead()
        await expect(slowLoad).resolves.toBe('aborted')
      })

      expect(getLut()?.title).toBe('Quick Look')
      expect(getCurrentSession()?.activeStyle?.name).toBe('Quick Look')
    })

    it.each<[string, (harness: LookStageHarness) => void]>([
      [
        'the stage cancels it',
        (harness) => harness.actions.cancelLUTFileLoad(),
      ],
      // The store keeps a loaded session for a return to /raw.
      ['the stage unmounts', (harness) => harness.unmount()],
    ])('drops a pick still reading when %s', async (_, drop) => {
      const session = createSession(null)
      const harness = renderLookStage({ session })
      const pick = createDeferredTestCubeFile('Dropped Look', 'dropped.cube')
      let load!: Promise<LutLoadOutcome>
      act(() => {
        load = harness.actions.loadLUT(pick.file)
      })

      drop(harness)
      await act(async () => {
        pick.finishRead()
        await expect(load).resolves.toBe('aborted')
      })

      expect(getCurrentSession()).toBe(session)
      expect(getLut()).toBeNull()
      expect(harness.invalidations).toEqual([])
      expect(harness.scheduleToast).not.toHaveBeenCalled()
    })

    it('keeps session changes published while a pick was reading', async () => {
      const harness = renderLookStage({ session: createSession(null) })
      const pick = createDeferredTestCubeFile('Client Look', 'client.cube')
      let load!: Promise<LutLoadOutcome>
      act(() => {
        load = harness.actions.loadLUT(pick.file)
      })
      setCurrentSession(
        (prev) =>
          prev && {
            ...prev,
            viewState: { ...prev.viewState, compareSplit: 0.31 },
          },
      )

      await act(async () => {
        pick.finishRead()
        await expect(load).resolves.toBe('loaded')
      })

      expect(getCurrentSession()).toMatchObject({
        viewState: { compareSplit: 0.31 },
        activeStyle: { name: 'Client Look' },
      })
    })
  })

  describe('notifications', () => {
    function shownToasts() {
      return (['success', 'error', 'info'] as const).flatMap((kind) =>
        toastMock.toast[kind].mock.calls.map((args) => [kind, ...args]),
      )
    }

    it.each<{
      name: string
      lut?: boolean
      run: (stage: LookStage) => unknown
      shown: unknown[]
    }>([
      {
        name: 'a loaded LUT by title and grid',
        run: (stage) =>
          stage.loadLUT(createTestCubeFile('Client Look', 'look.cube')),
        shown: [
          'success',
          'Loaded LUT: Client Look',
          { description: '17³ grid' },
        ],
      },
      {
        name: 'an unsupported file format',
        run: (stage) => stage.loadLUT(textFile('not a lut', 'look.txt')),
        shown: [
          'error',
          'Unsupported LUT format',
          { description: 'Only .cube files are supported' },
        ],
      },
      {
        name: 'a parser failure with its detail',
        run: (stage) =>
          stage.loadLUT(
            textFile('TITLE "Broken"\nLUT_3D_SIZE 2\n0 0 0\n', 'broken.cube'),
          ),
        shown: [
          'error',
          'Failed to load LUT',
          { description: 'Invalid .cube file: expected 8 entries, got 1' },
        ],
      },
      {
        name: 'a failure that carried no message of its own',
        run: (stage) => {
          vi.mocked(fetchVerifiedCubeAsset).mockRejectedValue('socket closed')
          return stage.loadOnlineLUT(onlineEntry)
        },
        shown: [
          'error',
          'Failed to load LUT',
          { description: 'Failed to parse LUT' },
        ],
      },
      {
        name: 'a catalog contract that does not apply',
        run: (stage) => {
          vi.mocked(fetchVerifiedCubeAsset).mockResolvedValue(cubeDownload())
          return stage.loadOnlineLUT({
            ...onlineEntry,
            trustedContract: {
              role: 'combined-look-output',
              inputProfile: 'panasonic-vgamut-vlog',
            },
          })
        },
        shown: [
          'error',
          'Failed to load LUT',
          { description: 'Unsupported LUT color contract.' },
        ],
      },
      {
        name: 'an incomplete contract choice by the profile it named',
        lut: true,
        run: (stage) => stage.selectLUTProfile('not-a-profile'),
        shown: [
          'error',
          'Incomplete LUT contract',
          { description: 'not-a-profile' },
        ],
      },
      {
        name: 'a contract choice made with no LUT loaded',
        run: (stage) => stage.selectLUTProfile('display-srgb'),
        shown: ['error', 'No LUT loaded'],
      },
      {
        name: 'a cleared LUT',
        lut: true,
        run: (stage) => stage.clearLUT(),
        shown: ['info', 'LUT cleared'],
      },
    ])(
      'reports $name only when its scheduled task runs',
      async ({ lut, run, shown }) => {
        const harness = renderLookStage({
          session: createSession(null),
          lut: lut ? createLut() : null,
        })

        await act(async () => {
          await run(harness.actions)
        })

        expect(harness.scheduleToast).toHaveBeenCalledTimes(1)
        expect(shownToasts()).toEqual([])
        harness.runScheduled()
        expect(shownToasts()).toEqual([shown])
      },
    )

    it.each<[string, (controller: AbortController) => void]>([
      ['its request was aborted', (controller) => controller.abort()],
      [
        'its photo was replaced',
        () => setCurrentSession(createTestSession({ id: 'replacement' })),
      ],
    ])(
      'reports nothing when an online LUT fails after %s',
      async (_, interrupt) => {
        const download =
          Promise.withResolvers<ReturnType<typeof cubeDownload>>()
        vi.mocked(fetchVerifiedCubeAsset).mockReturnValue(download.promise)
        const harness = renderLookStage({ session: createSession(null) })
        const controller = new AbortController()
        let load!: Promise<LutLoadOutcome>
        act(() => {
          load = harness.actions.loadOnlineLUT(onlineEntry, {
            signal: controller.signal,
          })
        })

        interrupt(controller)
        await act(async () => {
          download.reject(new Error('network down'))
          await expect(load).resolves.toBe('aborted')
        })

        expect(harness.scheduleToast).not.toHaveBeenCalled()
      },
    )

    describe('in the current locale', () => {
      afterEach(async () => {
        localStorage.clear()
        await act(() => i18n.changeLanguage('en'))
      })

      it('uses the locale current when a download lands, not when it began', async () => {
        const download =
          Promise.withResolvers<ReturnType<typeof cubeDownload>>()
        vi.mocked(fetchVerifiedCubeAsset).mockReturnValue(download.promise)
        await act(() => i18n.changeLanguage('en'))
        const harness = renderLookStage({
          session: createSession(null),
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
          download.resolve(cubeDownload())
          await expect(load).resolves.toBe('loaded')
        })

        harness.runScheduled()
        expect(shownToasts()).toEqual([
          ['success', '已载入 LUT：Online Look', { description: '17³ 网格' }],
        ])
      })
    })
  })
})
