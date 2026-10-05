import type { ProcessingParams } from '@lumaforge/luma-color-runtime'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { parseCubeLUT } from '~/lib/lut/cube-parser'

import type { ImageSession } from '../../../model/session'
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
    const session = createSession()
    const setParams = vi.fn()
    const setLut = vi.fn()
    const setLutDataRef = vi.fn()
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
        lutDataRef: { current: lut },
        setLutDataRef,
        scheduleToast: vi.fn(),
        invalidateExportGraph: vi.fn(),
      }),
    )

    result.current.clearLUT()

    expect(setLut).toHaveBeenCalledWith(null)
    expect(setLutDataRef).toHaveBeenCalledWith(null)
    expect(setSession).toHaveBeenCalledTimes(1)
    expect(setParams).not.toHaveBeenCalled()
  })
})

describe('useRawLookStage setIntensity', () => {
  it('sets a continuous amount on the latest session, keeping changes made since this render', () => {
    const session = createSession()
    const setParams = vi.fn()
    const setSession = vi.fn()
    const invalidateExportGraph = vi.fn()
    const { result } = renderHook(() =>
      useRawLookStage({
        baseParams,
        session,
        sessionRef: { current: session },
        setSession,
        lut: null,
        setLut: vi.fn(),
        setParams,
        getProcessingParams: () => baseParams,
        lutDataRef: { current: null },
        setLutDataRef: vi.fn(),
        scheduleToast: vi.fn(),
        invalidateExportGraph,
      }),
    )

    act(() => {
      result.current.setIntensity(0.62)
    })

    expect(invalidateExportGraph).toHaveBeenCalledTimes(1)
    // The session owns the look, so params are derived, not written.
    expect(setParams).not.toHaveBeenCalled()
    const updater = setSession.mock.calls[0]?.[0] as (
      prev: ImageSession | null,
    ) => ImageSession | null
    expect(typeof updater).toBe('function')
    // A render-state change that landed mid-scrub survives the update.
    const latest: ImageSession = {
      ...session,
      renderState: { status: 'rendering' },
    }
    const next = updater(latest)
    expect(next?.activeStyle?.currentIntensity).toBe(0.62)
    expect(next?.renderState.status).toBe('rendering')
    expect(updater(null)).toBeNull()
  })
})
