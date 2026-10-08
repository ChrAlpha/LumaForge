import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { act, renderHook } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewBackendState } from '~/lib/preview/gpu-backend'
import type { PreviewView } from '~/lib/preview/preview-view'
import {
  cpuPreviewVariantForViewMode,
  DEFAULT_PREVIEW_VIEW,
  previewSurfaceOutputForViewMode,
} from '~/lib/preview/preview-view'
import type { DecodedImage } from '~/lib/raw/decoder'

import type { ImageSession } from '../../../model/session'
import { createImageSession } from '../../../model/session-factory'
import {
  getCurrentSession,
  setCurrentSession,
  useCurrentSession,
} from '../../../state/session.atoms'
import { useRawCompareStage } from './useRawCompareStage'

const GPU_BACKEND: PreviewBackendState = {
  status: 'ready',
  facts: { backend: 'webgpu', maxTextureSize: 16384, reason: null },
}
const CPU_BACKEND: PreviewBackendState = {
  status: 'ready',
  facts: { backend: 'cpu', maxTextureSize: 0, reason: 'gpu-preview-failed' },
}

const previewBackend = vi.hoisted(() => ({
  state: null as PreviewBackendState | null,
}))

vi.mock('~/lib/preview/gpu-backend', () => ({
  getPreviewBackendState: () => previewBackend.state ?? { status: 'pending' },
}))

previewBackend.state = GPU_BACKEND

const INTENT: ColorGraphIntent = {
  ...NEUTRAL_USER_COLOR_INTENT,
  styleKind: 'custom',
  builtinPreset: null,
  intensity: 0.43,
  userContrast: 18,
}

function useHarness(initial: {
  session?: ImageSession | null
  detachedView?: PreviewView
  decoded?: boolean
}) {
  const [colorIntent, setColorIntent] = useState<ColorGraphIntent>(INTENT)
  const [detachedView, setDetachedView] = useState<PreviewView>(
    initial.detachedView ?? DEFAULT_PREVIEW_VIEW,
  )
  const [session] = useCurrentSession()
  const decodedImageRef = useRef<DecodedImage | null>(
    initial.decoded === false ? null : ({} as DecodedImage),
  )

  const stage = useRawCompareStage({
    detachedView,
    setDetachedView,
    session,
    decodedImageRef,
  })

  return {
    stage,
    colorIntent,
    setColorIntent,
    detachedView,
    session,
    decodedImageRef,
  }
}

// The stage reads and writes the production store, so the harness seeds it
// before the first render and every test leaves it empty.
function renderHarness(initial: Parameters<typeof useHarness>[0]) {
  setCurrentSession(initial.session ?? null)
  return renderHook(() => useHarness(initial))
}

beforeEach(() => {
  setCurrentSession(null)
})

afterEach(() => {
  setCurrentSession(null)
})

function createSession(): ImageSession {
  return createImageSession(new File(['raw'], 'frame.ARW'))
}

describe('useRawCompareStage', () => {
  it('reads the detached sample view while no session exists', () => {
    const detachedView: PreviewView = { mode: 'processed', compareSplit: 0.35 }
    const { result } = renderHarness({ detachedView })

    expect(result.current.stage.view).toBe(result.current.detachedView)
    expect(result.current.stage.viewMode).toBe('processed')
    expect(result.current.stage.compareSplit).toBe(0.35)
    expect(result.current.stage).not.toHaveProperty('params')
  })

  it('routes sample view writes to the detached view and leaves the intent alone', () => {
    const { result } = renderHarness({})
    const intentBefore = result.current.colorIntent

    act(() => {
      result.current.stage.setViewMode('original')
      result.current.stage.setCompareSplit(1.4)
    })

    expect(result.current.detachedView).toEqual({
      mode: 'original',
      compareSplit: 1,
    })
    expect(result.current.colorIntent).toBe(intentBefore)
    expect(result.current.stage.view).toEqual({
      mode: 'original',
      compareSplit: 1,
    })
  })

  it('keeps the detached view reference when a write changes nothing', () => {
    const { result } = renderHarness({})
    const viewBefore = result.current.detachedView

    act(() => {
      result.current.stage.setViewMode(DEFAULT_PREVIEW_VIEW.mode)
      result.current.stage.setCompareSplit(DEFAULT_PREVIEW_VIEW.compareSplit)
    })

    expect(result.current.detachedView).toBe(viewBefore)
  })

  it('reads and writes the session view once a session exists', () => {
    const session = createSession()
    const detachedView: PreviewView = { mode: 'processed', compareSplit: 0.9 }
    const { result } = renderHarness({ session, detachedView })

    expect(result.current.stage.view).toEqual({
      mode: 'compare',
      compareSplit: 0.5,
    })

    act(() => {
      result.current.stage.setCompareSplit(0.3)
    })

    expect(result.current.session?.viewState.compareSplit).toBe(0.3)
    expect(result.current.stage.compareSplit).toBe(0.3)
    expect(result.current.detachedView).toBe(detachedView)
  })

  it('routes a write made in the tick a session appears to that session', () => {
    const { result } = renderHarness({})
    const detachedBefore = result.current.detachedView
    const { setCompareSplit, setViewMode } = result.current.stage

    act(() => {
      setCurrentSession(createSession())
      setCompareSplit(0.27)
      setViewMode('original')
    })

    expect(result.current.session?.viewState).toMatchObject({
      mode: 'original',
      compareSplit: 0.27,
    })
    expect(result.current.detachedView).toBe(detachedBefore)
    expect(result.current.stage.view).toEqual({
      mode: 'original',
      compareSplit: 0.27,
    })
  })

  it('falls back to the detached view when the session is dropped', () => {
    const detachedView: PreviewView = { mode: 'compare', compareSplit: 0.8 }
    const { result } = renderHarness({ session: createSession(), detachedView })

    act(() => {
      result.current.stage.setViewMode('processed')
    })
    act(() => {
      setCurrentSession(null)
    })

    expect(result.current.stage.view).toBe(detachedView)
  })

  it('expresses the CPU original and the GPU compare split through one view', () => {
    const { result } = renderHarness({ session: createSession() })

    act(() => {
      result.current.stage.setViewMode('original')
    })
    expect(cpuPreviewVariantForViewMode(result.current.stage.viewMode)).toBe(
      'neutral',
    )
    expect(previewSurfaceOutputForViewMode(result.current.stage.viewMode)).toBe(
      'technical-original',
    )
    expect(result.current.colorIntent).toMatchObject({
      intensity: 0.43,
      userContrast: 18,
    })

    act(() => {
      result.current.stage.setViewMode('compare')
      result.current.stage.setCompareSplit(0.3)
    })
    expect(result.current.stage.view).toEqual({
      mode: 'compare',
      compareSplit: 0.3,
    })
    expect(previewSurfaceOutputForViewMode(result.current.stage.viewMode)).toBe(
      'processed',
    )
  })

  it('keeps the view reference across color-only changes', () => {
    const { result } = renderHarness({ session: createSession() })
    const viewBefore = result.current.stage.view

    act(() => {
      result.current.setColorIntent((prev) => ({ ...prev, intensity: 0.61 }))
    })

    expect(result.current.stage.view).toBe(viewBefore)
    expect(result.current.colorIntent.intensity).toBe(0.61)
  })

  it('keeps the color intent reference across view-only changes', () => {
    const { result } = renderHarness({ session: createSession() })
    const intentBefore = result.current.colorIntent

    act(() => {
      result.current.stage.setViewMode('processed')
      result.current.stage.setCompareSplit(0.12)
    })

    expect(result.current.colorIntent).toBe(intentBefore)
    expect(result.current.stage.view).toEqual({
      mode: 'processed',
      compareSplit: 0.12,
    })
  })
})

const TRANSFORM_GEOMETRY = {
  version: 1,
} as unknown as NonNullable<ImageSession['exportGeometry']>

function withView(
  session: ImageSession,
  viewState: Partial<ImageSession['viewState']>,
): ImageSession {
  return { ...session, viewState: { ...session.viewState, ...viewState } }
}

function zoomedSession(overrides: Partial<ImageSession> = {}): ImageSession {
  return {
    ...withView(createSession(), {
      mode: 'processed',
      compareSplit: 0.2,
      zoom: 3,
      panX: 40,
      panY: -12,
      fitMode: 'custom',
    }),
    ...overrides,
  }
}

function releasedSession(): ImageSession {
  const session = zoomedSession()
  return {
    ...session,
    exportState: {
      ...session.exportState,
      status: 'ready',
      activePlan: {} as NonNullable<ImageSession['exportState']['activePlan']>,
      result: {} as NonNullable<ImageSession['exportState']['result']>,
    },
  }
}

describe('useRawCompareStage command guards', () => {
  afterEach(() => {
    previewBackend.state = GPU_BACKEND
  })

  it('lets the CPU preview show the original and the processed photo', () => {
    previewBackend.state = CPU_BACKEND
    const { result } = renderHarness({ session: zoomedSession() })
    const intentBefore = result.current.colorIntent

    act(() => result.current.stage.setViewMode('original'))
    expect(result.current.session?.viewState.mode).toBe('original')

    act(() => result.current.stage.setViewMode('processed'))
    expect(result.current.session?.viewState.mode).toBe('processed')
    expect(result.current.colorIntent).toBe(intentBefore)
  })

  it('refuses the split, its handle and its reset on the CPU preview', () => {
    previewBackend.state = CPU_BACKEND
    const { result } = renderHarness({ session: zoomedSession() })
    const sessionBefore = result.current.session

    act(() => {
      result.current.stage.setViewMode('compare')
      result.current.stage.setCompareSplit(0.8)
      result.current.stage.resetCompareView()
    })

    expect(result.current.session).toBe(sessionBefore)
    expect(result.current.stage.previewViewport).toMatchObject({
      zoom: 3,
      fitMode: 'custom',
    })
  })

  it('refuses a split while the preview backend is still being resolved', () => {
    previewBackend.state = { status: 'pending' }
    const { result } = renderHarness({ session: zoomedSession() })
    const sessionBefore = result.current.session

    act(() => {
      result.current.stage.setViewMode('compare')
      result.current.stage.setCompareSplit(0.8)
    })
    expect(result.current.session).toBe(sessionBefore)

    act(() => result.current.stage.setViewMode('original'))
    expect(result.current.session?.viewState.mode).toBe('original')
  })

  it('reads the backend when a command runs, not when its callback was made', () => {
    const { result } = renderHarness({ session: zoomedSession() })
    const { setCompareSplit, setViewMode, resetCompareView } =
      result.current.stage

    act(() => setCompareSplit(0.7))
    expect(result.current.session?.viewState.compareSplit).toBe(0.7)

    // The GPU preview fails without a render in between.
    previewBackend.state = CPU_BACKEND
    const sessionBefore = result.current.session
    act(() => {
      setCompareSplit(0.3)
      setViewMode('compare')
      resetCompareView()
    })
    expect(result.current.session).toBe(sessionBefore)

    act(() => setViewMode('original'))
    expect(result.current.session?.viewState.mode).toBe('original')
  })

  it('keeps a committed Transform on the processed photo alone', () => {
    const { result } = renderHarness({
      session: withView(zoomedSession({ exportGeometry: TRANSFORM_GEOMETRY }), {
        mode: 'original',
      }),
    })
    const sessionBefore = result.current.session

    act(() => {
      result.current.stage.setViewMode('original')
      result.current.stage.setViewMode('compare')
      result.current.stage.setCompareSplit(0.8)
      result.current.stage.resetCompareView()
    })
    expect(result.current.session).toBe(sessionBefore)

    // Leaving for the processed photo is always open.
    act(() => result.current.stage.setViewMode('processed'))
    expect(result.current.session?.viewState.mode).toBe('processed')
  })

  it('refuses a callback from before a Transform commit in the same tick', () => {
    const { result } = renderHarness({ session: zoomedSession() })
    const { setViewMode, setCompareSplit } = result.current.stage

    act(() => {
      setCurrentSession((prev) =>
        prev ? { ...prev, exportGeometry: TRANSFORM_GEOMETRY } : prev,
      )
      setViewMode('original')
      setCompareSplit(0.9)
    })

    expect(result.current.session?.exportGeometry).toBe(TRANSFORM_GEOMETRY)
    expect(result.current.session?.viewState).toMatchObject({
      mode: 'processed',
      compareSplit: 0.2,
    })
  })

  it('refuses the original and the split while export holds the preview released', () => {
    const { result } = renderHarness({
      session: releasedSession(),
      decoded: false,
    })
    const sessionBefore = result.current.session

    act(() => {
      result.current.stage.setViewMode('original')
      result.current.stage.setViewMode('compare')
      result.current.stage.setCompareSplit(0.8)
      result.current.stage.resetCompareView()
    })
    expect(result.current.session).toBe(sessionBefore)
    expect(result.current.session?.exportState.result).toBeDefined()
    expect(result.current.stage.previewViewport).toMatchObject({ zoom: 3 })

    // Once the decoded preview is back, the view is the user's again.
    act(() => {
      result.current.decodedImageRef.current = {} as DecodedImage
      result.current.stage.setViewMode('original')
    })
    expect(result.current.session?.viewState.mode).toBe('original')
  })

  it('refuses the original and the split while a full-resolution export runs', () => {
    const exporting = releasedSession()
    const { result } = renderHarness({
      session: {
        ...exporting,
        exportState: {
          ...exporting.exportState,
          status: 'exporting',
          result: undefined,
        },
      },
    })
    const sessionBefore = result.current.session

    act(() => {
      result.current.stage.setViewMode('original')
      result.current.stage.setCompareSplit(0.8)
    })
    expect(result.current.session).toBe(sessionBefore)

    act(() => result.current.stage.setViewMode('processed'))
    expect(result.current.session?.viewState.mode).toBe('processed')
  })

  it('guards a write against the source that replaced the one it was made for', () => {
    const { result } = renderHarness({
      session: zoomedSession({ exportGeometry: TRANSFORM_GEOMETRY }),
    })
    const { setCompareSplit, setViewMode } = result.current.stage

    act(() => {
      setCurrentSession(createSession())
      setViewMode('original')
      setCompareSplit(0.3)
    })

    expect(result.current.session?.exportGeometry).toBeUndefined()
    expect(result.current.session?.viewState).toMatchObject({
      mode: 'original',
      compareSplit: 0.3,
    })
  })

  it('guards and lands a write on the replacement, never on the source it replaced', () => {
    const first = zoomedSession()
    const { result } = renderHarness({ session: first })
    const replacement = createSession()
    const { setCompareSplit } = result.current.stage

    act(() => {
      setCurrentSession(replacement)
      setCompareSplit(0.9)
    })

    expect(first.viewState.compareSplit).toBe(0.2)
    expect(result.current.session).toMatchObject({
      id: replacement.id,
      viewState: { compareSplit: 0.9 },
    })
  })

  it('publishes a write to the store before the next render', () => {
    const { result } = renderHarness({ session: zoomedSession() })
    const { setCompareSplit, setViewMode, setPreviewViewport } =
      result.current.stage

    act(() => {
      setViewMode('compare')
      setCompareSplit(0.4)
      // Each command read what the previous one wrote, not this render.
      expect(getCurrentSession()?.viewState).toMatchObject({
        mode: 'compare',
        compareSplit: 0.4,
      })
      setPreviewViewport({ zoom: 2, panX: 0, panY: 0, fitMode: 'custom' })
      expect(getCurrentSession()?.viewState).toMatchObject({
        mode: 'compare',
        compareSplit: 0.4,
        zoom: 2,
      })
    })

    expect(result.current.session).toBe(getCurrentSession())
    expect(result.current.stage.view).toEqual({
      mode: 'compare',
      compareSplit: 0.4,
    })
  })

  it('resets mode, split and viewport in one guarded transaction', () => {
    const { result } = renderHarness({ session: zoomedSession() })
    const intentBefore = result.current.colorIntent
    const sessionBefore = result.current.session!

    act(() => result.current.stage.resetCompareView())

    expect(result.current.session).toMatchObject({
      id: sessionBefore.id,
      exportState: sessionBefore.exportState,
      viewState: {
        mode: 'compare',
        compareSplit: 0.5,
        zoom: 1,
        panX: 0,
        panY: 0,
        fitMode: 'screen',
      },
    })
    expect(result.current.colorIntent).toBe(intentBefore)
  })

  it('keeps the sample compare open before a source on any backend', () => {
    previewBackend.state = CPU_BACKEND
    const { result } = renderHarness({})

    act(() => {
      result.current.stage.setViewMode('processed')
      result.current.stage.setCompareSplit(0.3)
    })
    act(() => result.current.stage.resetCompareView())

    expect(result.current.detachedView).toEqual({
      mode: 'compare',
      compareSplit: 0.5,
    })
  })
})
