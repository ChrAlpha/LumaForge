import type { ColorGraphIntent } from '@lumaforge/luma-color-runtime'
import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { act, renderHook } from '@testing-library/react'
import { useRef, useState } from 'react'
import { describe, expect, it } from 'vitest'

import type { PreviewView } from '~/lib/preview/preview-view'
import {
  cpuPreviewVariantForViewMode,
  DEFAULT_PREVIEW_VIEW,
  previewSurfaceOutputForViewMode,
} from '~/lib/preview/preview-view'

import type { ImageSession } from '../../../model/session'
import { createImageSession } from '../../../model/session-factory'
import {
  composeProcessingParams,
  useRawCompareStage,
} from './useRawCompareStage'

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
}) {
  const [colorIntent, setColorIntent] = useState<ColorGraphIntent>(INTENT)
  const [detachedView, setDetachedView] = useState<PreviewView>(
    initial.detachedView ?? DEFAULT_PREVIEW_VIEW,
  )
  const [session, setSession] = useState<ImageSession | null>(
    initial.session ?? null,
  )
  const sessionRef = useRef<ImageSession | null>(session)
  sessionRef.current = session

  const stage = useRawCompareStage({
    colorIntent,
    detachedView,
    setDetachedView,
    session,
    sessionRef,
    setSession,
  })

  return {
    stage,
    colorIntent,
    setColorIntent,
    detachedView,
    session,
    setSession,
    sessionRef,
  }
}

function createSession(): ImageSession {
  return createImageSession(new File(['raw'], 'frame.ARW'))
}

describe('composeProcessingParams', () => {
  it('lays the view over the intent without changing a color field', () => {
    expect(
      composeProcessingParams(INTENT, { mode: 'original', compareSplit: 0.2 }),
    ).toEqual({ ...INTENT, viewMode: 'original', compareSplit: 0.2 })
  })
})

describe('useRawCompareStage', () => {
  it('reads the detached sample view while no session exists', () => {
    const detachedView: PreviewView = { mode: 'processed', compareSplit: 0.35 }
    const { result } = renderHook(() => useHarness({ detachedView }))

    expect(result.current.stage.view).toBe(result.current.detachedView)
    expect(result.current.stage.viewMode).toBe('processed')
    expect(result.current.stage.compareSplit).toBe(0.35)
    expect(result.current.stage.params).toEqual({
      ...INTENT,
      viewMode: 'processed',
      compareSplit: 0.35,
    })
  })

  it('routes sample view writes to the detached view and leaves the intent alone', () => {
    const { result } = renderHook(() => useHarness({}))
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
    expect(result.current.stage.params).toMatchObject({
      intensity: 0.43,
      userContrast: 18,
      viewMode: 'original',
      compareSplit: 1,
    })
  })

  it('keeps the detached view reference when a write changes nothing', () => {
    const { result } = renderHook(() => useHarness({}))
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
    const { result } = renderHook(() => useHarness({ session, detachedView }))

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
    const { result } = renderHook(() => useHarness({}))
    const detachedBefore = result.current.detachedView
    const { setCompareSplit, setViewMode } = result.current.stage

    act(() => {
      const nextSession = createSession()
      result.current.sessionRef.current = nextSession
      result.current.setSession(nextSession)
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
    const { result } = renderHook(() =>
      useHarness({ session: createSession(), detachedView }),
    )

    act(() => {
      result.current.stage.setViewMode('processed')
    })
    act(() => {
      result.current.sessionRef.current = null
      result.current.setSession(null)
    })

    expect(result.current.stage.view).toBe(detachedView)
  })

  it('expresses the CPU original and the GPU compare split through one view', () => {
    const { result } = renderHook(() =>
      useHarness({ session: createSession() }),
    )

    act(() => {
      result.current.stage.setViewMode('original')
    })
    expect(cpuPreviewVariantForViewMode(result.current.stage.viewMode)).toBe(
      'neutral',
    )
    expect(previewSurfaceOutputForViewMode(result.current.stage.viewMode)).toBe(
      'technical-original',
    )
    expect(result.current.stage.params).toMatchObject({
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
    const { result } = renderHook(() =>
      useHarness({ session: createSession() }),
    )
    const viewBefore = result.current.stage.view

    act(() => {
      result.current.setColorIntent((prev) => ({ ...prev, intensity: 0.61 }))
    })

    expect(result.current.stage.view).toBe(viewBefore)
    expect(result.current.stage.params.intensity).toBe(0.61)
  })

  it('keeps the color intent reference across view-only changes', () => {
    const { result } = renderHook(() =>
      useHarness({ session: createSession() }),
    )
    const intentBefore = result.current.colorIntent

    act(() => {
      result.current.stage.setViewMode('processed')
      result.current.stage.setCompareSplit(0.12)
    })

    expect(result.current.colorIntent).toBe(intentBefore)
    expect(result.current.stage.params).toMatchObject({
      intensity: 0.43,
      viewMode: 'processed',
      compareSplit: 0.12,
    })
  })
})
