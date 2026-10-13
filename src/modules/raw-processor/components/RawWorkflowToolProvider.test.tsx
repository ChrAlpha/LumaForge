import type { LUTColorProfile } from '@lumaforge/luma-color-runtime'
import type { ExportGeometry } from '@lumaforge/render-engine/export'
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from '@testing-library/react'
import { Provider as JotaiProvider } from 'jotai'
import { RESET } from 'jotai/utils'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest'

import { viewportWidthAtom } from '~/atoms/viewport'
import { jotaiStore } from '~/lib/jotai'
import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'
import { identityMatrix } from '~/lib/transform/geometry/matrix'
import type { UprightAnalysis } from '~/lib/transform/geometry/types'
import { NEUTRAL_TRANSFORM } from '~/lib/transform/transform-types'
import type {
  TransformWorkerRequest,
  TransformWorkerResponse,
} from '~/lib/transform/worker-protocol'

import { useTransformSessionFixture } from '../hooks/transform-session.fixture'
import { useOnlineLutEntryLoader } from '../hooks/useOnlineLutEntryLoader'
import type { UseOnlineLutSourcesResult } from '../hooks/useOnlineLutSources'
import { useRawTransformFeature } from '../hooks/useRawTransformFeature'
import type { UseRawWorkflowReturn } from '../hooks/useRawWorkflow.types'
import type { ExportResult } from '../model/export-result'
import type { LutLoadOutcome } from '../services/look/orchestrate-lut-load'
import { captureTransformSource } from '../services/preview/capture-transform-source'
import { previewHistogramStateAtom } from '../state/histogram.atoms'
import { setCurrentSession } from '../state/session.atoms'
import { toolCardOpenAtom } from '../state/tool-card.atoms'
import {
  getProcessingParams,
  resetToDefaults,
  setPipelineStats,
  setProcessingParams,
  setProcessingStatus,
  setProgress,
} from '../state/workflow.atoms'
import { COLOR_NEUTRAL } from './color-fields'
import { RawToolSurface } from './RawToolSurface'
import type { RawToolCommands } from './RawWorkflowContext'
import {
  useRawPreviewHistogram,
  useRawPreviewStats,
  useRawToolCommands,
  useRawWorkflowContext,
} from './RawWorkflowContext'
import { RawWorkflowToolProvider } from './RawWorkflowToolProvider'
import type { TransformPreviewState } from './shared/transform-feature.fixture'
import {
  transformFeatureFixture,
  transformPreviewOf,
  withTransformPreview,
} from './shared/transform-feature.fixture'
import { TONE_NEUTRAL } from './tone-fields'
import { resetTransformGroup } from './transform-fields'

vi.mock(
  '../services/preview/capture-transform-source',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../services/preview/capture-transform-source')
    >()),
    captureTransformSource: vi.fn(),
  }),
)

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function workflowFixture() {
  return {
    params: { ...TONE_NEUTRAL, ...COLOR_NEUTRAL },
    hasImage: true,
    sourceFileName: 'current.nef',
    status: 'ready',
    decodedImageRef: { current: null },
    loadedImage: { file: null, metadata: null },
    previewFacts: null,
    viewMode: 'compare',
    compareSplit: 0.7,
    setViewMode: vi.fn(),
    setCompareSplit: vi.fn(),
    canExport: true,
    canPreviewExport: true,
    exportPreviewImage: vi.fn(),
  } as unknown as UseRawWorkflowReturn
}

function ProviderWith({
  workflow,
  transform,
  onExport = vi.fn(),
  children,
}: {
  workflow: UseRawWorkflowReturn
  transform?: ReturnType<typeof transformFeatureFixture>
  onExport?: () => void
  children: ReactNode
}) {
  return (
    <RawWorkflowToolProvider
      workflow={workflow}
      transform={transform}
      onlineLutSources={{} as UseOnlineLutSourcesResult}
      isCpuMode={false}
      isProcessing={false}
      runtimeReadinessState="ready"
      previewFrameEl={null}
      onReplaceFile={vi.fn()}
      onResetSession={vi.fn()}
      onCompareReset={vi.fn()}
      onLutDrop={vi.fn()}
      onExport={onExport}
      onPrepareRuntime={vi.fn()}
    >
      {children}
    </RawWorkflowToolProvider>
  )
}

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: MessageEvent<TransformWorkerResponse>) => void) | null =
    null
  onerror: (() => void) | null = null
  messages: TransformWorkerRequest[] = []
  constructor() {
    FakeWorker.instances.push(this)
  }
  postMessage(message: TransformWorkerRequest) {
    this.messages.push(message)
  }
  terminate() {}
  emit(data: TransformWorkerResponse) {
    act(() =>
      this.onmessage?.({ data } as MessageEvent<TransformWorkerResponse>),
    )
  }
  lastRender() {
    const request = this.messages.findLast(
      (message) => message.type === 'render',
    )
    if (request?.type !== 'render') throw new Error('expected render')
    return request
  }
  analyze() {
    const request = this.messages.findLast(
      (message) => message.type === 'analyze',
    )
    const solution = {
      matrix: identityMatrix(),
      confidence: 0.8,
      status: 'corrected' as const,
      reason: '',
      rotationDegrees: 0,
    }
    const analysis: UprightAnalysis = {
      lines: [],
      solutions: {
        off: solution,
        auto: solution,
        level: solution,
        vertical: solution,
        full: solution,
      },
    }
    this.emit({
      type: 'analyzed',
      sourceId: request!.sourceId,
      analysis,
      elapsedMs: 1,
    })
  }
  answer(request = this.lastRender()) {
    this.emit({
      type: 'rendered',
      sourceId: request.sourceId,
      requestId: request.requestId,
      result: {
        frame: { width: 80, height: 60, data: new Uint8ClampedArray(19200) },
        displayMatrix: request.matrix,
        retainedArea: 1,
      },
    })
  }
  refuse(request = this.lastRender()) {
    this.emit({
      type: 'error',
      sourceId: request.sourceId,
      requestId: request.requestId,
      phase: 'render',
      message: 'invalid-transform',
    })
  }
}

const capturedImage = { width: 80, height: 60 }
/** The accepted descriptor the workflow publishes for `capturedImage`. */
const capturedFrame: DecodedPreviewFrame = {
  sessionId: 'one',
  frameId: 'decoded-frame-1',
  stage: 'quick',
  width: 80,
  height: 60,
  exposure: {
    kind: 'source-pin',
    value: { ev: 0, multiplier: 1, source: 'identity' },
  },
  quickPredecessorFrameId: null,
}
const capturePipelineRef = { current: {} }
const delivered = {
  kind: 'full-resolution',
  filename: 'current.jpg',
} as ExportResult

/**
 * The real Transform feature over a workflow whose session moves its
 * geometry only through Transform events; `commit` hears each move.
 * `observing` stands for
 * the Transform panel being mounted; `released` for a finished export that
 * released the preview and holds a delivered JPEG; `exposure` for a colour
 * edit that the Transform frame has to be re-captured for.
 */
function TransformSession({
  observing,
  released,
  exposure,
  commit,
  workflowOverrides,
  onExport,
  children,
}: {
  observing: boolean
  released: boolean
  exposure: number
  commit: (geometry: ExportGeometry | null) => void
  workflowOverrides: Partial<UseRawWorkflowReturn>
  onExport: () => void
  children: ReactNode
}) {
  const onCommit = useCallback(
    (_source: string, next: ExportGeometry | null) => commit(next),
    [commit],
  )
  const { transform: port } = useTransformSessionFixture('one', onCommit)
  const base = workflowFixture()
  const workflow = {
    ...base,
    params: { ...base.params, userExposureEv: exposure },
    viewMode: 'processed',
    decodedImageRef: { current: released ? null : capturedImage },
    decodedImageVersion: released ? 2 : 1,
    decodedFrame: released ? null : capturedFrame,
    lutDataVersion: 1,
    pipelineRef: capturePipelineRef,
    previewSuspended: released,
    exportResult: released ? delivered : null,
    transform: port,
    ...workflowOverrides,
  } as unknown as UseRawWorkflowReturn
  const transform = useRawTransformFeature(workflow, false)
  const { observe } = transform
  useEffect(() => (observing ? observe() : undefined), [observe, observing])
  return (
    <ProviderWith workflow={workflow} transform={transform} onExport={onExport}>
      {children}
    </ProviderWith>
  )
}

/** What a surface is handed, and the commands it calls. */
function useToolBoundary() {
  return { surface: useRawWorkflowContext(), commands: useRawToolCommands() }
}

/** What a shell reads from its provider: the context and the commands. */
function useSurfaceView() {
  return {
    ...useRawWorkflowContext(),
    ...useRawToolCommands(),
    histogram: useRawPreviewHistogram(),
  }
}
type SurfaceView = ReturnType<typeof useSurfaceView>

async function renderTransformSession<Result = SurfaceView>(
  workflowOverrides: Partial<UseRawWorkflowReturn> = {},
  useValue: () => Result = useSurfaceView as () => Result,
) {
  vi.useFakeTimers()
  FakeWorker.instances = []
  vi.stubGlobal('Worker', FakeWorker)
  vi.mocked(captureTransformSource).mockResolvedValue({
    name: 'current.nef',
    kind: 'raw',
    originalWidth: 80,
    originalHeight: 60,
    frame: { width: 80, height: 60, data: new Uint8ClampedArray(19200) },
  })
  const state = { observing: true, released: false, exposure: 0 }
  const commit = vi.fn()
  const onExport = vi.fn()
  const hook = renderHook(useValue, {
    wrapper: ({ children }) => (
      <TransformSession
        observing={state.observing}
        released={state.released}
        exposure={state.exposure}
        commit={commit}
        workflowOverrides={workflowOverrides}
        onExport={onExport}
      >
        {children}
      </TransformSession>
    ),
  })
  await act(() => vi.advanceTimersByTimeAsync(150))
  const worker = FakeWorker.instances[0]!
  worker.analyze()
  worker.answer()
  return { ...hook, state, commit, onExport, worker }
}

describe('rawWorkflowToolProvider Transform guards', () => {
  it('keeps full-resolution export while blocking HQ preview, compare and the stale histogram under Transform', () => {
    const workflow = workflowFixture()
    const measured = jotaiStore.get(previewHistogramStateAtom)
    const onExport = vi.fn()
    const onCompareReset = vi.fn()
    const frame = document.createElement('div')
    let transform = transformFeatureFixture({ active: true, hasImage: true })
    const { result, rerender } = renderHook(useSurfaceView, {
      wrapper: ({ children }) => (
        <RawWorkflowToolProvider
          workflow={workflow}
          transform={transform}
          onlineLutSources={{} as UseOnlineLutSourcesResult}
          isCpuMode={false}
          isProcessing={false}
          runtimeReadinessState="ready"
          previewFrameEl={frame}
          onReplaceFile={vi.fn()}
          onResetSession={vi.fn()}
          onCompareReset={onCompareReset}
          onLutDrop={vi.fn()}
          onExport={onExport}
          onPrepareRuntime={vi.fn()}
        >
          {children}
        </RawWorkflowToolProvider>
      ),
    })
    // The surfaces read the feature itself; only its edits are wrapped.
    expect(transformPreviewOf(result.current.transform!)).toBe(
      transformPreviewOf(transform),
    )
    expect(result.current.transform?.active).toBe(true)
    // Full resolution reproduces the geometry, so the promise stays open.
    expect(result.current.canExport).toBe(true)
    expect(result.current.disabledReason).toBeUndefined()
    // The bounded HQ preview cannot, and names the alternative.
    expect(result.current.canPreviewExport).toBe(false)
    expect(result.current.previewExportDisabledReason).toEqual({
      source: 'surface',
      code: 'transform-hq-export',
    })
    expect(result.current.histogram).toEqual({
      state: 'unsupported',
      reason: 'Histogram is unavailable for the transformed preview.',
    })
    expect(result.current.previewFrameEl).toBeNull()
    expect(result.current.viewMode).toBe('processed')
    // Compare is refused in the policy every surface reads; its commands
    // reach the workflow's own, which refuse a committed Transform as well.
    for (const surface of ['desktop', 'mobile'] as const) {
      const actions = result.current.toolAvailability[surface]
      for (const action of ['originalView', 'split', 'splitReset'] as const) {
        expect(actions[action]).toEqual({
          available: false,
          reason: 'transform-compare',
        })
      }
    }
    result.current.onCompareReset()
    result.current.onViewModeChange('compare')
    result.current.onCompareSplitChange(0.4)
    expect(onCompareReset).toHaveBeenCalledOnce()
    expect(workflow.setViewMode).toHaveBeenLastCalledWith('compare')
    expect(workflow.setCompareSplit).toHaveBeenLastCalledWith(0.4)
    result.current.onExport()
    void result.current.onPreviewExport?.()
    expect(onExport).toHaveBeenCalledOnce()
    expect(workflow.exportPreviewImage).not.toHaveBeenCalled()

    transform = { ...transform, active: false }
    rerender()
    expect(result.current.canExport).toBe(true)
    expect(result.current.canPreviewExport).toBe(true)
    expect(result.current.histogram).toBe(measured)
    expect(result.current.previewFrameEl).toBe(frame)
    for (const surface of ['desktop', 'mobile'] as const) {
      const actions = result.current.toolAvailability[surface]
      expect(actions.originalView.available).toBe(true)
      expect(actions.split.available).toBe(true)
      expect(actions.splitReset.available).toBe(true)
    }
    result.current.onExport()
    void result.current.onPreviewExport?.()
    expect(onExport).toHaveBeenCalledTimes(2)
    expect(workflow.exportPreviewImage).toHaveBeenCalledOnce()
  })
  it('refuses both exports, in facts and callbacks, while Transform is unanswered or refused', () => {
    const workflow = workflowFixture()
    const onExport = vi.fn()
    let transform = transformFeatureFixture({
      hasImage: true,
      exportBlock: 'pending',
    })
    const { result, rerender } = renderHook(useSurfaceView, {
      wrapper: ({ children }) => (
        <ProviderWith
          workflow={workflow}
          transform={transform}
          onExport={onExport}
        >
          {children}
        </ProviderWith>
      ),
    })
    const attempt = () => {
      result.current.onExport()
      void result.current.onPreviewExport?.()
    }

    // A first Transform that has not rendered yet: nothing is committed, so
    // either export would write a photo without it.
    expect(result.current.canExport).toBe(false)
    expect(result.current.disabledReason).toEqual({
      source: 'surface',
      code: 'transform-pending',
    })
    expect(result.current.canPreviewExport).toBe(false)
    expect(result.current.previewExportDisabledReason).toEqual({
      source: 'surface',
      code: 'transform-hq-export',
    })
    attempt()

    transform = { ...transform, active: true, exportBlock: 'invalid' }
    rerender()
    expect(result.current.canExport).toBe(false)
    expect(result.current.disabledReason).toEqual({
      source: 'surface',
      code: 'transform-invalid',
    })
    expect(result.current.canPreviewExport).toBe(false)
    attempt()

    transform = { ...transform, exportBlock: 'unavailable' }
    rerender()
    expect(result.current.disabledReason).toEqual({
      source: 'surface',
      code: 'transform-unavailable',
    })
    attempt()
    expect(onExport).not.toHaveBeenCalled()
    expect(workflow.exportPreviewImage).not.toHaveBeenCalled()

    // The answered geometry is committed: full resolution reproduces it.
    transform = { ...transform, exportBlock: null }
    rerender()
    expect(result.current.canExport).toBe(true)
    expect(result.current.disabledReason).toBeUndefined()
    expect(result.current.canPreviewExport).toBe(false)
    attempt()
    expect(onExport).toHaveBeenCalledOnce()
    expect(workflow.exportPreviewImage).not.toHaveBeenCalled()
  })

  it('leaves an earlier workflow reason in place while Transform also blocks export', () => {
    const workflow = {
      ...workflowFixture(),
      canExport: false,
      exportRefusal: { code: 'capability-probing' },
    } as unknown as UseRawWorkflowReturn
    const onExport = vi.fn()
    const { result } = renderHook(useSurfaceView, {
      wrapper: ({ children }) => (
        <ProviderWith
          workflow={workflow}
          transform={transformFeatureFixture({
            hasImage: true,
            exportBlock: 'pending',
          })}
          onExport={onExport}
        >
          {children}
        </ProviderWith>
      ),
    })
    expect(result.current.canExport).toBe(false)
    expect(result.current.disabledReason).toEqual({
      source: 'workflow',
      reason: { code: 'capability-probing' },
    })
    expect(result.current.exportBlockedByLutContract).toBe(false)
    result.current.onExport()
    expect(onExport).not.toHaveBeenCalled()
  })

  it('does not route to the LUT contract while Transform is what blocks export', () => {
    const workflow = {
      ...workflowFixture(),
      canExport: false,
      exportRefusal: { code: 'lut-input-unconfirmed' },
      activeStyle: {
        kind: 'custom',
        name: 'Unknown',
        defaultIntensity: 0.7,
        currentIntensity: 0.7,
        lutAsset: {
          format: 'cube',
          dimension: 33,
          profileResolution: { kind: 'unknown' },
        },
      },
    } as unknown as UseRawWorkflowReturn
    let transform = transformFeatureFixture({
      hasImage: true,
      exportBlock: 'pending',
    })
    const { result, rerender } = renderHook(useSurfaceView, {
      wrapper: ({ children }) => (
        <ProviderWith workflow={workflow} transform={transform}>
          {children}
        </ProviderWith>
      ),
    })
    expect(result.current.canExport).toBe(false)
    expect(result.current.disabledReason).toEqual({
      source: 'surface',
      code: 'transform-pending',
    })
    expect(result.current.exportBlockedByLutContract).toBe(false)

    transform = { ...transform, exportBlock: null }
    rerender()
    expect(result.current.disabledReason).toEqual({
      source: 'workflow',
      reason: { code: 'lut-input-unconfirmed' },
    })
    expect(result.current.exportBlockedByLutContract).toBe(true)
  })

  it('follows the answered geometry, not the Transform panel, through export and preview release', async () => {
    const download = vi.fn()
    const session = await renderTransformSession({
      downloadExportResult: download,
    })
    const { result, rerender, state, commit, onExport, worker } = session
    // Opening a neutral Transform and analysing the photo blocks nothing.
    expect(result.current.canExport).toBe(true)
    expect(commit).not.toHaveBeenCalled()

    act(() =>
      result.current.transform!.setManual({ ...NEUTRAL_TRANSFORM, rotate: 3 }),
    )
    expect(result.current.canExport).toBe(false)
    expect(result.current.disabledReason).toEqual({
      source: 'surface',
      code: 'transform-pending',
    })
    expect(result.current.canPreviewExport).toBe(false)

    // The topbar Export opens the export panel and unmounts Transform; the
    // request still decides the gate.
    state.observing = false
    rerender()
    expect(result.current.canExport).toBe(false)
    result.current.onExport()
    expect(onExport).not.toHaveBeenCalled()

    worker.answer()
    expect(commit).toHaveBeenCalledOnce()
    expect(result.current.transform?.active).toBe(true)
    expect(result.current.canExport).toBe(true)
    expect(result.current.canPreviewExport).toBe(false)
    result.current.onExport()
    expect(onExport).toHaveBeenCalledOnce()

    // The export finishes and releases the preview: the geometry stays
    // committed and the delivered JPEG stays deliverable.
    state.released = true
    rerender()
    expect(result.current.previewSuspended).toBe(true)
    expect(result.current.exportResult).toBe(delivered)
    expect(result.current.transform?.active).toBe(true)
    expect(result.current.canExport).toBe(true)
    expect(commit).toHaveBeenCalledOnce()
    result.current.onDownloadExport()
    expect(download).toHaveBeenCalledOnce()
    session.unmount()
  })

  it('refuses export from a colour edit until the new frame answers, and while its capture fails', async () => {
    const session = await renderTransformSession()
    const { result, rerender, state, commit, onExport, worker } = session
    act(() =>
      result.current.transform!.setManual({ ...NEUTRAL_TRANSFORM, rotate: 3 }),
    )
    worker.answer()
    expect(commit).toHaveBeenCalledOnce()
    expect(result.current.canExport).toBe(true)

    // The frame that answered is no longer the photo once the colour moves.
    state.exposure = 1
    rerender()
    expect(result.current.canExport).toBe(false)
    expect(result.current.disabledReason).toEqual({
      source: 'surface',
      code: 'transform-pending',
    })
    result.current.onExport()
    await act(() => vi.advanceTimersByTimeAsync(60))
    expect(result.current.canExport).toBe(false)
    await act(() => vi.advanceTimersByTimeAsync(90))
    worker.analyze()
    worker.answer()
    expect(result.current.canExport).toBe(true)
    expect(commit).toHaveBeenCalledOnce()

    // A capture that fails leaves nothing showing the geometry on the photo.
    vi.mocked(captureTransformSource).mockRejectedValueOnce(new Error('lost'))
    state.exposure = 2
    rerender()
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(result.current.transform?.active).toBe(true)
    expect(result.current.canExport).toBe(false)
    expect(result.current.disabledReason).toEqual({
      source: 'surface',
      code: 'transform-unavailable',
    })
    expect(result.current.canPreviewExport).toBe(false)
    result.current.onExport()
    expect(onExport).not.toHaveBeenCalled()
    session.unmount()
  })

  it('keeps the last valid geometry but refuses export while the newest edit is refused', async () => {
    const session = await renderTransformSession()
    const { result, commit, onExport, worker } = session
    act(() =>
      result.current.transform!.setManual({ ...NEUTRAL_TRANSFORM, rotate: 3 }),
    )
    worker.answer()
    expect(commit).toHaveBeenCalledOnce()
    const committed = commit.mock.calls[0]![0]

    act(() =>
      result.current.transform!.setManual({ ...NEUTRAL_TRANSFORM, rotate: 9 }),
    )
    worker.refuse()
    expect(result.current.transform?.active).toBe(true)
    expect(commit).toHaveBeenCalledOnce()
    expect(result.current.canExport).toBe(false)
    expect(result.current.disabledReason).toEqual({
      source: 'surface',
      code: 'transform-invalid',
    })
    result.current.onExport()
    expect(onExport).not.toHaveBeenCalled()

    // Reset retires the refused edit and the committed geometry together.
    act(() => result.current.transform!.reset())
    expect(commit).toHaveBeenLastCalledWith(null)
    expect(committed).not.toBeNull()
    expect(result.current.transform?.active).toBe(false)
    expect(result.current.canExport).toBe(true)
    expect(result.current.canPreviewExport).toBe(true)
    session.unmount()
  })

  it('reports compare support and the delivered size to the tool surfaces', () => {
    const workflow = workflowFixture()
    let isCpuMode = false
    const { result, rerender } = renderHook(useSurfaceView, {
      wrapper: ({ children }) => (
        <RawWorkflowToolProvider
          workflow={workflow}
          onlineLutSources={{} as UseOnlineLutSourcesResult}
          isCpuMode={isCpuMode}
          isProcessing
          runtimeReadinessState="ready"
          previewFrameEl={null}
          onReplaceFile={vi.fn()}
          onResetSession={vi.fn()}
          onCompareReset={vi.fn()}
          onLutDrop={vi.fn()}
          onExport={vi.fn()}
          onPrepareRuntime={vi.fn()}
        >
          {children}
        </RawWorkflowToolProvider>
      ),
    })
    expect(result.current.compareSupported).toBe(true)
    // The export recap's size is unknown until the workflow reports it.
    expect(result.current.deliveredExportSize).toBeNull()
    workflow.deliveredExportSize = { width: 9728, height: 6656 }
    rerender()
    expect(result.current.deliveredExportSize).toEqual({
      width: 9728,
      height: 6656,
    })

    // The CPU preview has no split surface to compare on.
    isCpuMode = true
    rerender()
    expect(result.current.compareSupported).toBe(false)
  })

  it('lets the CPU preview show the original but never the split', () => {
    const workflow = workflowFixture()
    const onCompareReset = vi.fn()
    const { result } = renderHook(useSurfaceView, {
      wrapper: ({ children }) => (
        <RawWorkflowToolProvider
          workflow={workflow}
          transform={transformFeatureFixture({ hasImage: true })}
          onlineLutSources={{} as UseOnlineLutSourcesResult}
          isCpuMode
          isProcessing={false}
          runtimeReadinessState="ready"
          previewFrameEl={null}
          onReplaceFile={vi.fn()}
          onResetSession={vi.fn()}
          onCompareReset={onCompareReset}
          onLutDrop={vi.fn()}
          onExport={vi.fn()}
          onPrepareRuntime={vi.fn()}
        >
          {children}
        </RawWorkflowToolProvider>
      ),
    })
    // No custom style: no applied LUT for the Look strip to match.
    expect(result.current.appliedLut).toBeNull()
    // A split left over from the GPU path reads as the processed photo.
    expect(result.current.viewMode).toBe('processed')
    // No split surface, so no split or split reset: the surfaces read the
    // policy, and the workflow's own commands refuse the split too.
    expect(result.current.compareSupported).toBe(false)
    for (const surface of ['desktop', 'mobile'] as const) {
      const actions = result.current.toolAvailability[surface]
      expect(actions.originalView.available).toBe(true)
      expect(actions.split).toEqual({ available: false, reason: 'cpu-preview' })
      expect(actions.splitReset).toEqual({
        available: false,
        reason: 'cpu-preview',
      })
    }
    result.current.onViewModeChange('original')
    result.current.onCompareSplitChange(0.4)
    result.current.onCompareReset()
    expect(workflow.setViewMode).toHaveBeenLastCalledWith('original')
    expect(workflow.setCompareSplit).toHaveBeenLastCalledWith(0.4)
    expect(onCompareReset).toHaveBeenCalledOnce()
  })

  it('tells the Look strip which LUT is applied by its cube hash', () => {
    const workflow = {
      ...workflowFixture(),
      activeStyle: {
        kind: 'custom',
        name: 'Kodak 2383',
        defaultIntensity: 0.7,
        currentIntensity: 0.7,
        lutAsset: {
          format: 'cube',
          dimension: 33,
          sha256: 'a'.repeat(64),
          sourceName: 'kodak-2383.cube',
        },
      },
    } as unknown as UseRawWorkflowReturn
    const { result } = renderHook(useSurfaceView, {
      wrapper: ({ children }) => (
        <RawWorkflowToolProvider
          workflow={workflow}
          onlineLutSources={{} as UseOnlineLutSourcesResult}
          isCpuMode={false}
          isProcessing={false}
          runtimeReadinessState="ready"
          previewFrameEl={null}
          onReplaceFile={vi.fn()}
          onResetSession={vi.fn()}
          onCompareReset={vi.fn()}
          onLutDrop={vi.fn()}
          onExport={vi.fn()}
          onPrepareRuntime={vi.fn()}
        >
          {children}
        </RawWorkflowToolProvider>
      ),
    })
    expect(result.current.appliedLut).toEqual({
      name: 'Kodak 2383',
      sha256: 'a'.repeat(64),
      sourceName: 'kodak-2383.cube',
    })
    // No contract on the style: nothing for the export panel to route to.
    expect(result.current.exportBlockedByLutContract).toBe(false)
  })

  it('flags an export blocked by the LUT contract, and only that block', () => {
    const workflow = {
      ...workflowFixture(),
      canExport: false,
      exportRefusal: { code: 'lut-input-unconfirmed' },
      activeStyle: {
        kind: 'custom',
        name: 'Unknown',
        defaultIntensity: 0.7,
        currentIntensity: 0.7,
        lutAsset: {
          format: 'cube',
          dimension: 33,
          profileResolution: { kind: 'unknown' },
        },
      },
    } as unknown as UseRawWorkflowReturn
    const { result, rerender } = renderHook(useSurfaceView, {
      wrapper: ({ children }) => (
        <RawWorkflowToolProvider
          workflow={workflow}
          onlineLutSources={{} as UseOnlineLutSourcesResult}
          isCpuMode={false}
          isProcessing={false}
          runtimeReadinessState="ready"
          previewFrameEl={null}
          onReplaceFile={vi.fn()}
          onResetSession={vi.fn()}
          onCompareReset={vi.fn()}
          onLutDrop={vi.fn()}
          onExport={vi.fn()}
          onPrepareRuntime={vi.fn()}
        >
          {children}
        </RawWorkflowToolProvider>
      ),
    })
    expect(result.current.exportBlockedByLutContract).toBe(true)

    // An earlier gate is what export states: choosing a contract would not
    // unblock it, so no route is offered.
    workflow.exportRefusal = { code: 'quick-preview-pending' }
    rerender()
    expect(result.current.exportBlockedByLutContract).toBe(false)
  })

  it("shows the decoded preview size over the renderer's own, apart from the source size", () => {
    const workflow = {
      ...workflowFixture(),
      decodedImageRef: { current: { width: 4000, height: 2666 } },
    } as unknown as UseRawWorkflowReturn
    act(() =>
      setPipelineStats({
        uploadTime: 4,
        lutUploadTime: 0,
        processTime: 18,
        totalTime: 22,
        inputSize: { width: 4000, height: 2666 },
        previewSize: { width: 1200, height: 800 },
        inputFormat: 'uint16-rgb',
        transformPath: 'no-lut',
        lutRole: null,
        lutInputTransfer: null,
        lutOutputTransfer: null,
        lutSize: null,
      }),
    )
    try {
      const { result } = renderHook(useRawPreviewStats, {
        wrapper: ({ children }) => (
          <ProviderWith workflow={workflow}>{children}</ProviderWith>
        ),
      })
      expect(result.current).toEqual({
        processTime: 18,
        inputSize: { width: 4000, height: 2666 },
        previewSize: { width: 4000, height: 2666 },
      })
    } finally {
      act(() => setPipelineStats(null))
    }
  })

  it('reports the aspect the stage is displaying', () => {
    const decoded = { width: 6000, height: 4000 }
    const workflow = {
      ...workflowFixture(),
      decodedImageRef: { current: decoded },
    } as unknown as UseRawWorkflowReturn
    let transform = transformFeatureFixture({ hasImage: true })
    const { result, rerender } = renderHook(useSurfaceView, {
      wrapper: ({ children }) => (
        <RawWorkflowToolProvider
          workflow={workflow}
          transform={transform}
          onlineLutSources={{} as UseOnlineLutSourcesResult}
          isCpuMode={false}
          isProcessing={false}
          runtimeReadinessState="ready"
          previewFrameEl={null}
          onReplaceFile={vi.fn()}
          onResetSession={vi.fn()}
          onCompareReset={vi.fn()}
          onLutDrop={vi.fn()}
          onExport={vi.fn()}
          onPrepareRuntime={vi.fn()}
        >
          {children}
        </RawWorkflowToolProvider>
      ),
    })
    // The decoded preview is what the canvas aspect-fits.
    expect(result.current.previewAspect).toBe(1.5)

    // The Transform overlay draws its own result frame over the stage.
    transform = withTransformPreview(
      transformFeatureFixture({ hasImage: true, showOverlay: true }),
      {
        result: {
          frame: { width: 800, height: 1000 },
        } as NonNullable<TransformPreviewState['result']>,
      },
    )
    rerender()
    expect(result.current.previewAspect).toBe(0.8)

    // Export releases the decoded preview; the aspect is unknown until the
    // preview is restored.
    transform = transformFeatureFixture({ hasImage: true })
    workflow.decodedImageRef.current = null
    rerender()
    expect(result.current.previewAspect).toBeNull()
  })
})

/**
 * A provider over a workflow whose every edit is a spy, so a test can say
 * exactly which edits reached the session. `release` stands for a finished
 * export that released the preview and holds the delivered JPEG; `restore`
 * for the photographer bringing the preview back.
 */
function renderReleasablePreview<Result = SurfaceView>(
  useValue: () => Result = useSurfaceView as () => Result,
) {
  const workflow = {
    ...workflowFixture(),
    previewSuspended: false,
    exportResult: null,
    setIntensity: vi.fn(),
    setToneParams: vi.fn(),
    resetTone: vi.fn(),
    setColorParams: vi.fn(),
    resetColor: vi.fn(),
    setSelectiveColorBand: vi.fn(),
    resetSelectiveColor: vi.fn(),
    clearLUT: vi.fn(),
    selectLUTProfile: vi.fn(),
    shareExportResult: vi.fn(),
    downloadExportResult: vi.fn(),
    downloadExportManifest: vi.fn(),
    copyExportResult: vi.fn(),
  } as unknown as UseRawWorkflowReturn
  const onLutDrop = vi.fn()
  const onExport = vi.fn()
  const transform = transformFeatureFixture({ hasImage: true, available: true })
  const loadEntry = vi.fn(async (): Promise<LutLoadOutcome> => 'loaded')
  const cancelEntryLoad = vi.fn()
  const activateCatalogs = vi.fn()
  let onlineLutSources = {
    loadEntry,
    loadingEntryId: null,
    failedEntryId: null,
    cancelEntryLoad,
    activateCatalogs,
    resourceActivation: {},
    catalogActivation: 'inactive',
  } as unknown as UseOnlineLutSourcesResult
  const hook = renderHook(useValue, {
    wrapper: ({ children }) => (
      <RawWorkflowToolProvider
        workflow={workflow}
        transform={transform}
        onlineLutSources={onlineLutSources}
        isCpuMode={false}
        isProcessing={false}
        runtimeReadinessState="ready"
        previewFrameEl={null}
        onReplaceFile={vi.fn()}
        onResetSession={vi.fn()}
        onCompareReset={vi.fn()}
        onLutDrop={onLutDrop}
        onExport={onExport}
        onPrepareRuntime={vi.fn()}
      >
        {children}
      </RawWorkflowToolProvider>
    ),
  })
  const edits = [
    workflow.setToneParams,
    workflow.resetTone,
    workflow.setColorParams,
    workflow.resetColor,
    workflow.setSelectiveColorBand,
    workflow.resetSelectiveColor,
    workflow.setIntensity,
    onLutDrop,
    workflow.clearLUT,
    workflow.selectLUTProfile,
    transform.setMode,
    transform.setManual,
    transform.setConstrainCrop,
    transform.reset,
    loadEntry,
  ]
  return {
    ...hook,
    workflow,
    onExport,
    edits,
    loadEntry,
    cancelEntryLoad,
    activateCatalogs,
    setOnlineLutSources(
      patch: Partial<Pick<UseOnlineLutSourcesResult, 'loadingEntryId'>>,
    ) {
      onlineLutSources = { ...onlineLutSources, ...patch }
      hook.rerender()
    },
    release() {
      workflow.previewSuspended = true
      workflow.exportResult = delivered
      hook.rerender()
    },
    restore() {
      workflow.previewSuspended = false
      hook.rerender()
    },
  }
}

describe('rawWorkflowToolProvider released preview', () => {
  it('still lists catalogs while the preview is released: listing is not an edit', () => {
    const { result, release, activateCatalogs } = renderReleasablePreview()
    release()

    result.current.onlineLutSources!.activateCatalogs?.({
      resourceIds: ['profiles'],
    })
    expect(activateCatalogs).toHaveBeenCalledWith({ resourceIds: ['profiles'] })
    expect(result.current.onlineLutSources!.catalogActivation).toBe('inactive')
  })

  it('cancels a catalog load still in flight when the preview is released', () => {
    const { release, restore, cancelEntryLoad, setOnlineLutSources } =
      renderReleasablePreview()
    setOnlineLutSources({ loadingEntryId: 'kodak-2383' })
    expect(cancelEntryLoad).not.toHaveBeenCalled()

    release()
    expect(cancelEntryLoad).toHaveBeenCalledOnce()

    // Nothing is loading once the preview is back.
    setOnlineLutSources({ loadingEntryId: null })
    restore()
    expect(cancelEntryLoad).toHaveBeenCalledOnce()
  })

  it('does not load a catalog tap that was still waiting out its frame when the preview was released', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      frames.push(callback),
    )
    const workflow = {
      ...workflowFixture(),
      previewSuspended: false,
    } as unknown as UseRawWorkflowReturn
    const loadEntry = vi.fn(async (): Promise<LutLoadOutcome> => 'loaded')
    const onlineLutSources = {
      loadEntry,
      loadingEntryId: null,
      failedEntryId: null,
      cancelEntryLoad: vi.fn(),
    } as unknown as UseOnlineLutSourcesResult
    const { result, rerender } = renderHook(
      () => useOnlineLutEntryLoader(useRawWorkflowContext().onlineLutSources),
      {
        wrapper: ({ children }) => (
          <RawWorkflowToolProvider
            workflow={workflow}
            onlineLutSources={onlineLutSources}
            isCpuMode={false}
            isProcessing={false}
            runtimeReadinessState="ready"
            previewFrameEl={null}
            onReplaceFile={vi.fn()}
            onResetSession={vi.fn()}
            onCompareReset={vi.fn()}
            onLutDrop={vi.fn()}
            onExport={vi.fn()}
            onPrepareRuntime={vi.fn()}
          >
            {children}
          </RawWorkflowToolProvider>
        ),
      },
    )
    const onLoaded = vi.fn()
    let tap: Promise<void> | undefined
    act(() => {
      tap = result.current.loadOnlineLutEntry('kodak-2383', onLoaded)
    })
    expect(frames).toHaveLength(1)

    workflow.previewSuspended = true
    rerender()
    await act(async () => {
      frames.shift()!(0)
      await tap
    })
    expect(loadEntry).not.toHaveBeenCalled()
    expect(onLoaded).not.toHaveBeenCalled()
    expect(result.current.loadingEntryId).toBeNull()
  })

  it('keeps the delivered JPEG and the committed geometry through Transform edits held across the release', async () => {
    const session = await renderTransformSession()
    const { result, rerender, state, commit, worker } = session
    act(() =>
      result.current.transform!.setManual({ ...NEUTRAL_TRANSFORM, rotate: 3 }),
    )
    worker.answer()
    expect(commit).toHaveBeenCalledOnce()
    const held = result.current.transform!

    state.released = true
    rerender()
    const posted = worker.messages.length
    act(() => {
      // Each mobile section reset, and the desktop controls, from a panel
      // that was on screen before the release.
      held.setConstrainCrop(true)
      held.setManual(
        resetTransformGroup('perspective', transformPreviewOf(held).manual),
      )
      held.reset()
      result.current.transform!.setMode('auto')
      result.current.transform!.setConstrainCrop(false)
    })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(worker.messages).toHaveLength(posted)
    expect(commit).toHaveBeenCalledOnce()
    expect(result.current.transform?.active).toBe(true)
    expect(transformPreviewOf(result.current.transform!).manual.rotate).toBe(3)
    expect(result.current.exportResult).toBe(delivered)
    expect(result.current.canExport).toBe(true)

    // Restored, Transform edits again.
    state.released = false
    rerender()
    act(() => result.current.transform!.reset())
    expect(commit).toHaveBeenLastCalledWith(null)
    session.unmount()
  })
})

function interruptedWorkflow(exportInterrupted: boolean) {
  return {
    ...workflowFixture(),
    supportLevel: 'experimental',
    exportResult: null,
    exportShareCapability: { available: false, reasonCode: 'no-result' },
    exportInterrupted,
  } as unknown as UseRawWorkflowReturn
}

function emptyOnlineLutSources() {
  return {
    state: {
      resources: [],
      entries: [],
      issues: [],
      activeResourceId: null,
      isLoading: false,
    },
    sourceUrlInput: '',
    setSourceUrlInput: vi.fn(),
    addSourceFromInput: vi.fn(),
    refreshSource: vi.fn(),
    removeSource: vi.fn(),
    loadEntry: vi.fn(),
    loadingEntryId: null,
    failedEntryId: null,
    entryLoadProgress: null,
    cancelEntryLoad: vi.fn(),
    loadedEntry: null,
    activateCatalogs: vi.fn(),
    resourceActivation: {},
    catalogActivation: 'inactive',
    share: { enabled: false, url: null, copy: vi.fn() },
  } as unknown as UseOnlineLutSourcesResult
}

describe('rawWorkflowToolProvider interruption note', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn().mockImplementation(() => ({
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      })),
    )
  })

  it('hands the surfaces one typed note for the loaded source', () => {
    let workflow = interruptedWorkflow(true)
    const onExport = vi.fn()
    const { result, rerender } = renderHook(useSurfaceView, {
      wrapper: ({ children }) => (
        <ProviderWith workflow={workflow} onExport={onExport}>
          {children}
        </ProviderWith>
      ),
    })

    expect(result.current.interruptionNote).toEqual({ kind: 'interrupted' })
    // The note names no source and carries no journal sentence; the
    // surfaces get no recovery state and no file picker.
    expect(JSON.stringify(result.current.interruptionNote)).not.toMatch(
      /journal|attempt/,
    )

    // Another source has no hint of its own, so the note goes.
    workflow = interruptedWorkflow(false)
    rerender()
    expect(result.current.interruptionNote).toBeNull()

    // The note mounting, changing and clearing starts no export.
    expect(onExport).not.toHaveBeenCalled()
    result.current.onExport()
    expect(onExport).toHaveBeenCalledExactlyOnceWith()
  })
})

/**
 * The provider and the real tool surfaces over a workflow whose view mode
 * follows the commands it is sent, so a test sees what the stage would.
 */
function PolicySurface({
  isCpuMode = false,
  transform = transformFeatureFixture({ hasImage: true }),
  workflowOverrides = {},
  onExport = vi.fn(),
  commands,
}: {
  isCpuMode?: boolean
  transform?: ReturnType<typeof transformFeatureFixture>
  workflowOverrides?: Partial<UseRawWorkflowReturn>
  onExport?: () => void
  commands: {
    setViewMode: (mode: 'processed' | 'original' | 'compare') => void
    setToneParams: () => void
    onCompareReset: () => void
  }
}) {
  const [viewMode, setViewMode] = useState<
    'processed' | 'original' | 'compare'
  >('processed')
  const workflow = {
    ...interruptedWorkflow(false),
    viewMode,
    setViewMode: (mode: 'processed' | 'original' | 'compare') => {
      commands.setViewMode(mode)
      setViewMode(mode)
    },
    setToneParams: commands.setToneParams,
    ...workflowOverrides,
  } as unknown as UseRawWorkflowReturn
  return (
    <JotaiProvider store={jotaiStore}>
      <RawWorkflowToolProvider
        workflow={workflow}
        transform={transform}
        onlineLutSources={emptyOnlineLutSources()}
        isCpuMode={isCpuMode}
        isProcessing={workflow.status !== 'ready'}
        runtimeReadinessState="ready"
        previewFrameEl={null}
        onReplaceFile={vi.fn()}
        onResetSession={vi.fn()}
        onCompareReset={commands.onCompareReset}
        onLutDrop={vi.fn()}
        onExport={onExport}
        onPrepareRuntime={vi.fn()}
      >
        <RawToolSurface />
      </RawWorkflowToolProvider>
    </JotaiProvider>
  )
}

function policyCommands() {
  return {
    setViewMode: vi.fn(),
    setToneParams: vi.fn(),
    onCompareReset: vi.fn(),
  }
}

describe('rawWorkflowToolProvider surface policy', () => {
  let previousViewport = jotaiStore.get(viewportWidthAtom)
  beforeEach(() => {
    previousViewport = jotaiStore.get(viewportWidthAtom)
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn().mockImplementation(() => ({
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      })),
    )
  })
  afterEach(() => {
    // Unmount the surface before restoring the viewport and the open tool
    // cards it reads, so the restore re-renders nothing outside act and the
    // next rail mounts with the cards its storage holds.
    cleanup()
    jotaiStore.set(viewportWidthAtom, previousViewport)
    jotaiStore.set(toolCardOpenAtom, RESET)
  })
  const showDesktop = () => jotaiStore.set(viewportWidthAtom, 1280)
  const showMobile = () => jotaiStore.set(viewportWidthAtom, 390)

  it('hands each surface the shared action policy, decode-time difference included', () => {
    let workflow = { ...workflowFixture(), status: 'decoding' }
    let isCpuMode = false
    let transform = transformFeatureFixture({ hasImage: true })
    const { result, rerender } = renderHook(useSurfaceView, {
      wrapper: ({ children }) => (
        <RawWorkflowToolProvider
          workflow={workflow as unknown as UseRawWorkflowReturn}
          transform={transform}
          onlineLutSources={{} as UseOnlineLutSourcesResult}
          isCpuMode={isCpuMode}
          isProcessing={workflow.status !== 'ready'}
          runtimeReadinessState="ready"
          previewFrameEl={null}
          onReplaceFile={vi.fn()}
          onResetSession={vi.fn()}
          onCompareReset={vi.fn()}
          onLutDrop={vi.fn()}
          onExport={vi.fn()}
          onPrepareRuntime={vi.fn()}
        >
          {children}
        </RawWorkflowToolProvider>
      ),
    })
    // Desktop keeps its controls while a stage decodes; mobile waits.
    const decoding = result.current.toolAvailability
    expect(decoding.desktop.edit.available).toBe(true)
    expect(decoding.mobile.edit).toEqual({
      available: false,
      reason: 'preview-decoding',
    })

    // The CPU preview shows the original but has no split to open or reset.
    workflow = { ...workflow, status: 'ready' }
    isCpuMode = true
    rerender()
    for (const surface of ['desktop', 'mobile'] as const) {
      const actions = result.current.toolAvailability[surface]
      expect(actions.originalView.available).toBe(true)
      expect(actions.split).toEqual({ available: false, reason: 'cpu-preview' })
      expect(actions.splitReset.available).toBe(false)
      expect(actions.edit.available).toBe(true)
    }

    // A committed Transform has nothing to compare against.
    transform = transformFeatureFixture({ hasImage: true, active: true })
    rerender()
    expect(result.current.toolAvailability.mobile.originalView).toEqual({
      available: false,
      reason: 'transform-compare',
    })

    // A released preview locks the edits, not the way back or the result.
    transform = transformFeatureFixture({ hasImage: true })
    workflow = {
      ...workflow,
      previewSuspended: true,
      exportResult: delivered,
    } as typeof workflow
    rerender()
    for (const surface of ['desktop', 'mobile'] as const) {
      const actions = result.current.toolAvailability[surface]
      expect(actions.edit).toEqual({
        available: false,
        reason: 'preview-released',
      })
      expect(actions.lutApplication.available).toBe(false)
      expect(actions.exportEntry.available).toBe(true)
      expect(actions.delivery.available).toBe(true)
      expect(actions.restorePreview.available).toBe(true)
    }
  })

  it('hands each surface the Transform tool policy from what its preview observes', () => {
    let workflow = workflowFixture()
    let isCpuMode = true
    let transform: ReturnType<typeof transformFeatureFixture> | undefined =
      transformFeatureFixture({ hasImage: true })
    const { result, rerender } = renderHook(useSurfaceView, {
      wrapper: ({ children }) => (
        <RawWorkflowToolProvider
          workflow={workflow}
          transform={transform}
          onlineLutSources={{} as UseOnlineLutSourcesResult}
          isCpuMode={isCpuMode}
          isProcessing={workflow.status !== 'ready'}
          runtimeReadinessState="ready"
          previewFrameEl={null}
          onReplaceFile={vi.fn()}
          onResetSession={vi.fn()}
          onCompareReset={vi.fn()}
          onLutDrop={vi.fn()}
          onExport={vi.fn()}
          onPrepareRuntime={vi.fn()}
        >
          {children}
        </RawWorkflowToolProvider>
      ),
    })
    const transformActions = () =>
      (['desktop', 'mobile'] as const).map((surface) => {
        const actions = result.current.toolAvailability[surface]
        return {
          geometry: actions.transformGeometry,
          overlay: actions.transformOverlay,
          reset: actions.transformReset,
        }
      })
    const open = { available: true, reason: null }

    // No current CPU frame yet: nothing to capture, so nothing to answer on.
    for (const actions of transformActions()) {
      expect(actions.geometry).toEqual({
        available: false,
        reason: 'transform-unavailable',
      })
      expect(actions.reset).toEqual(open)
    }

    // A frame to capture, but the worker does not hold it yet.
    transform = transformFeatureFixture({ hasImage: true, available: true })
    rerender()
    for (const actions of transformActions()) {
      expect(actions.geometry).toEqual({
        available: false,
        reason: 'transform-pending',
      })
      expect(actions.overlay).toEqual({
        available: false,
        reason: 'transform-pending',
      })
    }

    // The worker holds the frame and answered on the photo as it now looks.
    const ready = transformFeatureFixture({
      hasImage: true,
      available: true,
      current: true,
    })
    transform = withTransformPreview(ready, { ready: true })
    rerender()
    for (const actions of transformActions()) {
      expect(actions).toEqual({ geometry: open, overlay: open, reset: open })
    }

    // A failed capture refuses the geometry but keeps the way back.
    transform = { ...transform, captureError: true, current: false }
    rerender()
    for (const actions of transformActions()) {
      expect(actions.geometry).toEqual({
        available: false,
        reason: 'transform-unavailable',
      })
      expect(actions.reset).toEqual(open)
    }

    // A decode replaces the frame on either surface, unlike the other edits
    // desktop keeps.
    transform = withTransformPreview(ready, { ready: true })
    isCpuMode = false
    workflow = { ...workflow, status: 'decoding' } as UseRawWorkflowReturn
    rerender()
    expect(result.current.toolAvailability.desktop.edit.available).toBe(true)
    for (const actions of transformActions()) {
      for (const action of [actions.geometry, actions.overlay, actions.reset])
        expect(action).toEqual({
          available: false,
          reason: 'preview-decoding',
        })
    }

    // Without a Transform preview there is no Transform tool.
    transform = undefined
    workflow = { ...workflow, status: 'ready' } as UseRawWorkflowReturn
    rerender()
    for (const actions of transformActions()) {
      for (const action of [actions.geometry, actions.overlay, actions.reset])
        expect(action).toEqual({ available: false, reason: null })
    }
  })

  it('sends compare commands to the workflow, whose own guard decides', () => {
    const workflow = workflowFixture()
    const onCompareReset = vi.fn()
    let isCpuMode = true
    let transform = transformFeatureFixture({ hasImage: true })
    const { result, rerender } = renderHook(useSurfaceView, {
      wrapper: ({ children }) => (
        <RawWorkflowToolProvider
          workflow={workflow}
          transform={transform}
          onlineLutSources={{} as UseOnlineLutSourcesResult}
          isCpuMode={isCpuMode}
          isProcessing={false}
          runtimeReadinessState="ready"
          previewFrameEl={null}
          onReplaceFile={vi.fn()}
          onResetSession={vi.fn()}
          onCompareReset={onCompareReset}
          onLutDrop={vi.fn()}
          onExport={vi.fn()}
          onPrepareRuntime={vi.fn()}
        >
          {children}
        </RawWorkflowToolProvider>
      ),
    })
    // No surface command is swapped for another or dropped on the way: the
    // workflow refuses a split the CPU preview or a Transform cannot show.
    result.current.onViewModeChange('compare')
    result.current.onCompareSplitChange(0.3)
    result.current.onCompareReset()
    expect(workflow.setViewMode).toHaveBeenLastCalledWith('compare')
    expect(workflow.setCompareSplit).toHaveBeenLastCalledWith(0.3)
    expect(onCompareReset).toHaveBeenCalledOnce()

    isCpuMode = false
    transform = transformFeatureFixture({ hasImage: true, active: true })
    rerender()
    result.current.onViewModeChange('original')
    result.current.onCompareReset()
    expect(workflow.setViewMode).toHaveBeenLastCalledWith('original')
    expect(onCompareReset).toHaveBeenCalledTimes(2)
  })

  it('shows the adjustments the store renders with on desktop, not a copy the workflow hands on', () => {
    showDesktop()
    onTestFinished(() => {
      setCurrentSession(null)
      resetToDefaults()
    })
    setProcessingParams({ ...getProcessingParams(), userContrast: 12 })
    render(<PolicySurface commands={policyCommands()} />)
    expect(screen.getByRole('slider', { name: 'Contrast' })).toHaveAttribute(
      'aria-valuenow',
      '12',
    )
  })

  it('shows the export progress the store holds on the mobile topbar', () => {
    showMobile()
    onTestFinished(() => {
      setCurrentSession(null)
      resetToDefaults()
    })
    act(() => {
      setProcessingStatus('exporting')
      setProgress(42)
    })
    const { container } = render(
      <PolicySurface
        commands={policyCommands()}
        workflowOverrides={{ status: 'exporting', progress: 0 }}
      />,
    )
    expect(
      container.querySelector('[data-mobile-export-action]'),
    ).toHaveTextContent('42%')
  })
})

/** Every edit a tool command makes: Adjust, Look and its contract. */
function editThroughCommands(commands: RawToolCommands) {
  commands.onToneChange({ userExposureEv: 1 })
  commands.onToneReset()
  commands.onColorChange({ userSaturation: 20 })
  commands.onColorReset()
  commands.onSelectiveColorChange('red', { hue: 10 })
  commands.onSelectiveColorReset()
  commands.onIntensityChange(0.4)
  void commands.onLutLoad([new File(['LUT_3D_SIZE 2'], 'look.cube')])
  commands.onLutClear()
  commands.onLutProfileSelect({ id: 'slog3' } as unknown as LUTColorProfile)
}

/** A workflow whose every command is a fresh spy. */
function commandWorkflow() {
  return {
    ...workflowFixture(),
    previewSuspended: false,
    exportResult: null,
    setIntensity: vi.fn(),
    setToneParams: vi.fn(),
    resetTone: vi.fn(),
    setColorParams: vi.fn(),
    resetColor: vi.fn(),
    setSelectiveColorBand: vi.fn(),
    resetSelectiveColor: vi.fn(),
    clearLUT: vi.fn(),
    selectLUTProfile: vi.fn(),
    setViewMode: vi.fn(),
    setCompareSplit: vi.fn(),
    exportPreviewImage: vi.fn(),
    shareExportResult: vi.fn(),
    downloadExportResult: vi.fn(),
    downloadExportManifest: vi.fn(),
    copyExportResult: vi.fn(),
  } as unknown as UseRawWorkflowReturn
}

describe('rawWorkflowToolProvider tool commands', () => {
  it('names every command a surface calls, and nothing else', () => {
    const { result } = renderHook(useRawToolCommands, {
      wrapper: ({ children }) => (
        <ProviderWith workflow={commandWorkflow()}>{children}</ProviderWith>
      ),
    })
    expect(Object.keys(result.current).sort()).toEqual(
      [
        'onColorChange',
        'onColorReset',
        'onCompareReset',
        'onCompareSplitChange',
        'onCopyExport',
        'onDownloadExport',
        'onDownloadExportManifest',
        'onExport',
        'onIntensityChange',
        'onLutClear',
        'onLutLoad',
        'onLutProfileSelect',
        'onPrepareRuntime',
        'onPreviewExport',
        'onReplaceFile',
        'onResetSession',
        'onSelectiveColorChange',
        'onSelectiveColorReset',
        'onShareExport',
        'onToneChange',
        'onToneReset',
        'onViewModeChange',
      ].sort(),
    )
  })

  it('keeps one set of commands across renders, each reaching the workflow as it now is', () => {
    let workflow = commandWorkflow()
    let onLutDrop = vi.fn()
    const onExport = vi.fn()
    const onCompareReset = vi.fn()
    const { result, rerender } = renderHook(useToolBoundary, {
      wrapper: ({ children }) => (
        <RawWorkflowToolProvider
          workflow={workflow}
          onlineLutSources={{} as UseOnlineLutSourcesResult}
          isCpuMode={false}
          isProcessing={false}
          runtimeReadinessState="ready"
          previewFrameEl={null}
          onReplaceFile={vi.fn()}
          onResetSession={vi.fn()}
          onCompareReset={onCompareReset}
          onLutDrop={onLutDrop}
          onExport={onExport}
          onPrepareRuntime={vi.fn()}
        >
          {children}
        </RawWorkflowToolProvider>
      ),
    })
    const held = result.current
    const first = workflow
    const firstLutDrop = onLutDrop

    // The workflow hands new commands; the surfaces keep the ones they hold.
    workflow = commandWorkflow()
    onLutDrop = vi.fn()
    rerender()
    expect(result.current.commands).toBe(held.commands)
    // The context hands on no command of its own beside them.
    for (const name of Object.keys(held.commands)) {
      expect(result.current.surface, name).not.toHaveProperty(name)
    }

    editThroughCommands(held.commands)
    held.commands.onViewModeChange('original')
    held.commands.onCompareSplitChange(0.3)
    held.commands.onCompareReset()
    held.commands.onExport()
    void held.commands.onPreviewExport()
    void held.commands.onDownloadExport()
    void held.commands.onDownloadExportManifest()
    void held.commands.onShareExport()
    void held.commands.onCopyExport()
    for (const command of [
      workflow.setToneParams,
      workflow.resetTone,
      workflow.setColorParams,
      workflow.resetColor,
      workflow.setSelectiveColorBand,
      workflow.resetSelectiveColor,
      workflow.setIntensity,
      onLutDrop,
      workflow.clearLUT,
      workflow.selectLUTProfile,
      workflow.exportPreviewImage,
      workflow.downloadExportResult,
      workflow.downloadExportManifest,
      workflow.shareExportResult,
      workflow.copyExportResult,
      onCompareReset,
      onExport,
    ]) {
      expect(command).toHaveBeenCalledOnce()
    }
    expect(workflow.setViewMode).toHaveBeenCalledWith('original')
    expect(workflow.setCompareSplit).toHaveBeenCalledWith(0.3)
    expect(first.setToneParams).not.toHaveBeenCalled()
    expect(firstLutDrop).not.toHaveBeenCalled()
  })

  it('decides each export when it is called: pending, then answered, then a failed capture', async () => {
    const session = await renderTransformSession({}, useToolBoundary)
    const { result, rerender, state, commit, onExport, worker } = session
    const held = result.current.commands
    act(() =>
      result.current.surface.transform!.setManual({
        ...NEUTRAL_TRANSFORM,
        rotate: 3,
      }),
    )
    // The edit has not rendered yet: the policy refuses both exports, and
    // so do the commands held from before the edit.
    expect(result.current.surface.toolAvailability.desktop.fullExport).toEqual({
      available: false,
      reason: 'transform-pending',
    })
    held.onExport()
    void held.onPreviewExport()
    expect(onExport).not.toHaveBeenCalled()

    // Answered, the same command exports at full resolution; HQ preview
    // never applies Transform.
    worker.answer()
    expect(commit).toHaveBeenCalledOnce()
    expect(result.current.commands).toBe(held)
    held.onExport()
    void held.onPreviewExport()
    expect(onExport).toHaveBeenCalledOnce()
    expect(result.current.surface.canPreviewExport).toBe(false)

    // A capture that fails leaves nothing showing the geometry on the photo.
    vi.mocked(captureTransformSource).mockRejectedValueOnce(new Error('lost'))
    state.exposure = 2
    rerender()
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(result.current.surface.toolAvailability.desktop.fullExport).toEqual({
      available: false,
      reason: 'transform-unavailable',
    })
    held.onExport()
    expect(onExport).toHaveBeenCalledOnce()
    expect(result.current.commands).toBe(held)
    session.unmount()
  })

  it('refuses every edit command while the preview is released, and keeps delivery and Export', async () => {
    const session = renderReleasablePreview(useToolBoundary)
    const { result, workflow, onExport, edits, release, restore } = session
    const held = result.current.commands
    const commandEdits = edits.slice(0, 10)

    release()
    expect(result.current.commands).toBe(held)
    expect(result.current.surface.previewSuspended).toBe(true)
    editThroughCommands(held)
    for (const edit of commandEdits) expect(edit).not.toHaveBeenCalled()

    held.onDownloadExport()
    void held.onDownloadExportManifest()
    held.onShareExport()
    held.onCopyExport()
    held.onExport()
    expect(workflow.downloadExportResult).toHaveBeenCalledOnce()
    expect(workflow.downloadExportManifest).toHaveBeenCalledOnce()
    expect(workflow.shareExportResult).toHaveBeenCalledOnce()
    expect(workflow.copyExportResult).toHaveBeenCalledOnce()
    expect(onExport).toHaveBeenCalledOnce()

    restore()
    editThroughCommands(held)
    for (const edit of commandEdits) expect(edit).toHaveBeenCalledOnce()
  })
})
