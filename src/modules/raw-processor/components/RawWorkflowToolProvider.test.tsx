import type { LUTColorProfile } from '@lumaforge/luma-color-runtime'
import type { ExportGeometry } from '@lumaforge/render-engine/export'
import { act, render, renderHook, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider as JotaiProvider } from 'jotai'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { viewportAtom } from '~/atoms/viewport'
import { jotaiStore } from '~/lib/jotai'
import { identityMatrix } from '~/modules/transform-demo/geometry/matrix'
import type { UprightAnalysis } from '~/modules/transform-demo/geometry/types'
import { NEUTRAL_TRANSFORM } from '~/modules/transform-demo/transform-types'
import type {
  TransformWorkerRequest,
  TransformWorkerResponse,
} from '~/modules/transform-demo/worker-protocol'

import type { UseOnlineLutSourcesResult } from '../hooks/useOnlineLutSources'
import { useRawTransformFeature } from '../hooks/useRawTransformFeature'
import type { UseRawWorkflowReturn } from '../hooks/useRawWorkflow.types'
import type { ExportResult } from '../model/export-result'
import type { LutLoadOutcome } from '../services/look/orchestrate-lut-load'
import { captureTransformSource } from '../services/preview/capture-transform-source'
import { COLOR_NEUTRAL } from './color-fields'
import { RawToolSurface } from './RawToolSurface'
import type { RawToolSurfaceProps } from './RawWorkflowContext'
import { useRawWorkflowContext } from './RawWorkflowContext'
import { RawWorkflowToolProvider } from './RawWorkflowToolProvider'
import { TONE_NEUTRAL } from './tone-fields'
import { useOnlineLutEntryLoader } from './tools/lut/useOnlineLutEntryLoader'
import { transformFeatureFixture } from './tools/transform-feature.fixture'
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
    stats: null,
    viewMode: 'compare',
    compareSplit: 0.7,
    setViewMode: vi.fn(),
    setCompareSplit: vi.fn(),
    canExport: true,
    canPreviewExport: true,
    exportPreviewImage: vi.fn(),
    histogram: { state: 'unavailable', reason: 'no-image' },
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
      message: 'invalid-transform',
    })
  }
}

const capturedImage = { width: 80, height: 60 }
const capturePipelineRef = { current: {} }
const delivered = {
  kind: 'full-resolution',
  filename: 'current.jpg',
} as ExportResult

/**
 * The real Transform feature over a workflow whose session keeps one
 * committed geometry, changed only through `commit`. `observing` stands for
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
  const [geometry, setGeometry] = useState<ExportGeometry | null>(null)
  const commitGeometry = useCallback(
    (next: ExportGeometry | null) => {
      commit(next)
      setGeometry(next)
    },
    [commit],
  )
  const base = workflowFixture()
  const workflow = {
    ...base,
    params: { ...base.params, userExposureEv: exposure },
    viewMode: 'processed',
    decodedImageRef: { current: released ? null : capturedImage },
    decodedImageVersion: released ? 2 : 1,
    lutDataVersion: 1,
    pipelineRef: capturePipelineRef,
    previewSuspended: released,
    exportResult: released ? delivered : null,
    previewTransform: {
      sourceId: 'one',
      active: Boolean(geometry),
      geometry,
      commit: commitGeometry,
    },
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

async function renderTransformSession(
  workflowOverrides: Partial<UseRawWorkflowReturn> = {},
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
  const hook = renderHook(useRawWorkflowContext, {
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
    const onExport = vi.fn()
    const onCompareReset = vi.fn()
    const frame = document.createElement('div')
    let transform = transformFeatureFixture({ active: true, hasImage: true })
    const { result, rerender } = renderHook(useRawWorkflowContext, {
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
    expect(result.current.transform?.demo).toBe(transform.demo)
    expect(result.current.transform?.active).toBe(true)
    // Full resolution reproduces the geometry, so the promise stays open.
    expect(result.current.canExport).toBe(true)
    expect(result.current.disabledReason).toBeUndefined()
    // The bounded HQ preview cannot, and names the alternative.
    expect(result.current.canPreviewExport).toBe(false)
    expect(result.current.previewExportDisabledReason).toBe(
      'Export at full resolution to keep Transform, or reset Transform for an HQ preview JPEG.',
    )
    expect(result.current.histogram).toEqual({
      state: 'unsupported',
      reason: 'Histogram is unavailable for the transformed preview.',
    })
    expect(result.current.previewFrameEl).toBeNull()
    expect(result.current.viewMode).toBe('processed')
    result.current.onExport()
    void result.current.onPreviewExport?.()
    result.current.onCompareReset()
    result.current.onViewModeChange('original')
    result.current.onCompareSplitChange(0.2)
    expect(onExport).toHaveBeenCalledOnce()
    expect(workflow.exportPreviewImage).not.toHaveBeenCalled()
    expect(onCompareReset).not.toHaveBeenCalled()
    expect(workflow.setViewMode).not.toHaveBeenCalled()
    expect(workflow.setCompareSplit).not.toHaveBeenCalled()

    transform = { ...transform, active: false }
    rerender()
    expect(result.current.canExport).toBe(true)
    expect(result.current.canPreviewExport).toBe(true)
    expect(result.current.histogram).toBe(workflow.histogram)
    expect(result.current.previewFrameEl).toBe(frame)
    result.current.onExport()
    void result.current.onPreviewExport?.()
    result.current.onCompareReset()
    result.current.onViewModeChange('original')
    result.current.onCompareSplitChange(0.2)
    expect(onExport).toHaveBeenCalledTimes(2)
    expect(workflow.exportPreviewImage).toHaveBeenCalledOnce()
    expect(onCompareReset).toHaveBeenCalledOnce()
    expect(workflow.setViewMode).toHaveBeenCalledWith('original')
    expect(workflow.setCompareSplit).toHaveBeenCalledWith(0.2)
  })
  it('refuses both exports, in facts and callbacks, while Transform is unanswered or refused', () => {
    const workflow = workflowFixture()
    const onExport = vi.fn()
    let transform = transformFeatureFixture({
      hasImage: true,
      exportBlock: 'pending',
    })
    const { result, rerender } = renderHook(useRawWorkflowContext, {
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
    expect(result.current.disabledReason).toBe('Preparing the current photo…')
    expect(result.current.canPreviewExport).toBe(false)
    expect(result.current.previewExportDisabledReason).toBe(
      'Export at full resolution to keep Transform, or reset Transform for an HQ preview JPEG.',
    )
    attempt()

    transform = { ...transform, active: true, exportBlock: 'invalid' }
    rerender()
    expect(result.current.canExport).toBe(false)
    expect(result.current.disabledReason).toBe(
      'This transform leaves too little usable image. Reduce the adjustment or reset.',
    )
    expect(result.current.canPreviewExport).toBe(false)
    attempt()

    transform = { ...transform, exportBlock: 'unavailable' }
    rerender()
    expect(result.current.disabledReason).toBe(
      'The processed preview is unavailable. Wait for it or reset Transform.',
    )
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
    const earlier = 'Export is already running.'
    const workflow = {
      ...workflowFixture(),
      canExport: false,
      exportDisabledReason: earlier,
    } as unknown as UseRawWorkflowReturn
    const onExport = vi.fn()
    const { result } = renderHook(useRawWorkflowContext, {
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
    expect(result.current.disabledReason).toBe(earlier)
    expect(result.current.exportBlockedByLutContract).toBe(false)
    result.current.onExport()
    expect(onExport).not.toHaveBeenCalled()
  })

  it('does not route to the LUT contract while Transform is what blocks export', () => {
    const contractReason =
      'Choose a LUT input profile before full-resolution export.'
    const workflow = {
      ...workflowFixture(),
      canExport: false,
      exportDisabledReason: contractReason,
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
    const { result, rerender } = renderHook(useRawWorkflowContext, {
      wrapper: ({ children }) => (
        <ProviderWith workflow={workflow} transform={transform}>
          {children}
        </ProviderWith>
      ),
    })
    expect(result.current.canExport).toBe(false)
    expect(result.current.disabledReason).toBe('Preparing the current photo…')
    expect(result.current.exportBlockedByLutContract).toBe(false)

    transform = { ...transform, exportBlock: null }
    rerender()
    expect(result.current.disabledReason).toBe(contractReason)
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
    expect(result.current.disabledReason).toBe('Preparing the current photo…')
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
    expect(result.current.disabledReason).toBe('Preparing the current photo…')
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
    expect(result.current.disabledReason).toBe(
      'The processed preview is unavailable. Wait for it or reset Transform.',
    )
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
    expect(result.current.disabledReason).toBe(
      'This transform leaves too little usable image. Reduce the adjustment or reset.',
    )
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

  it('reports compare support and export progress to the tool surfaces', () => {
    const workflow = {
      ...workflowFixture(),
      status: 'exporting',
      progress: 42,
    } as unknown as UseRawWorkflowReturn
    let isCpuMode = false
    const { result, rerender } = renderHook(useRawWorkflowContext, {
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
    expect(result.current.isExporting).toBe(true)
    expect(result.current.progress).toBe(42)
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
    const { result } = renderHook(useRawWorkflowContext, {
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
    result.current.onViewModeChange('original')
    expect(workflow.setViewMode).toHaveBeenLastCalledWith('original')
    result.current.onViewModeChange('compare')
    expect(workflow.setViewMode).toHaveBeenLastCalledWith('processed')
    result.current.onCompareSplitChange(0.2)
    expect(workflow.setCompareSplit).not.toHaveBeenCalled()
    // No split surface, so no split reset: the surfaces read the fact and the
    // callback refuses too.
    expect(result.current.compareSupported).toBe(false)
    result.current.onCompareReset()
    expect(onCompareReset).not.toHaveBeenCalled()
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
    const { result } = renderHook(useRawWorkflowContext, {
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
    const contractReason =
      'Choose a LUT input profile before full-resolution export.'
    const workflow = {
      ...workflowFixture(),
      canExport: false,
      exportDisabledReason: contractReason,
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
    const { result, rerender } = renderHook(useRawWorkflowContext, {
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
    workflow.exportDisabledReason = 'Quick preview is still being prepared.'
    rerender()
    expect(result.current.exportBlockedByLutContract).toBe(false)
  })

  it('reports the aspect the stage is displaying', () => {
    const decoded = { width: 6000, height: 4000 }
    const workflow = {
      ...workflowFixture(),
      decodedImageRef: { current: decoded },
    } as unknown as UseRawWorkflowReturn
    let transform = transformFeatureFixture({ hasImage: true })
    const { result, rerender } = renderHook(useRawWorkflowContext, {
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
    const base = transformFeatureFixture({ hasImage: true, showOverlay: true })
    transform = {
      ...base,
      demo: {
        ...base.demo,
        result: {
          frame: { width: 800, height: 1000 },
        } as NonNullable<typeof base.demo.result>,
      },
    }
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
function renderReleasablePreview() {
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
  const hook = renderHook(useRawWorkflowContext, {
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

/** Every edit a tool surface can make: Adjust, Look, its contract, Transform. */
function editEverything(surface: RawToolSurfaceProps) {
  surface.onToneChange({ userExposureEv: 1 })
  surface.onToneReset()
  surface.onColorChange({ userSaturation: 20 })
  surface.onColorReset()
  surface.onSelectiveColorChange('red', { hue: 10 })
  surface.onSelectiveColorReset()
  surface.onIntensityChange(0.4)
  void surface.onLutLoad([new File(['LUT_3D_SIZE 2'], 'look.cube')])
  surface.onLutClear()
  surface.onLutProfileSelect({ id: 'slog3' } as unknown as LUTColorProfile)
  surface.transform!.setMode('auto')
  surface.transform!.setManual({ ...NEUTRAL_TRANSFORM, rotate: 2 })
  surface.transform!.setConstrainCrop(false)
  surface.transform!.reset()
  return surface.onlineLutSources!.loadEntry('kodak-2383')
}

describe('rawWorkflowToolProvider released preview', () => {
  it('refuses every edit while the preview is released, through callbacks held from before it', async () => {
    const session = renderReleasablePreview()
    const { result, workflow, onExport, edits, release, restore } = session
    // A scrub, a deferred strength step or a panel still leaving holds the
    // callbacks of the render it started in.
    const held = result.current

    release()
    expect(result.current.previewSuspended).toBe(true)
    await expect(editEverything(held)).resolves.toBe('aborted')
    await expect(editEverything(result.current)).resolves.toBe('aborted')
    for (const edit of edits) expect(edit).not.toHaveBeenCalled()

    // The delivered JPEG stays deliverable, and Export stays open.
    result.current.onDownloadExport()
    void result.current.onDownloadExportManifest?.()
    result.current.onShareExport()
    result.current.onCopyExport()
    result.current.onExport()
    expect(workflow.downloadExportResult).toHaveBeenCalledOnce()
    expect(workflow.downloadExportManifest).toHaveBeenCalledOnce()
    expect(workflow.shareExportResult).toHaveBeenCalledOnce()
    expect(workflow.copyExportResult).toHaveBeenCalledOnce()
    expect(onExport).toHaveBeenCalledOnce()
    expect(result.current.exportResult).toBe(delivered)

    // Restored, the same held callbacks edit again.
    restore()
    await expect(editEverything(held)).resolves.toBe('loaded')
    for (const edit of edits) expect(edit).toHaveBeenCalledOnce()
  })

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
      held.setManual(resetTransformGroup('perspective', held.demo.manual))
      held.reset()
      result.current.transform!.setMode('auto')
      result.current.transform!.setConstrainCrop(false)
    })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(worker.messages).toHaveLength(posted)
    expect(commit).toHaveBeenCalledOnce()
    expect(result.current.transform?.active).toBe(true)
    expect(result.current.transform?.demo.manual.rotate).toBe(3)
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

const INTERRUPTED_HINT =
  'The previous export was interrupted. The next export you start uses the current RAW and adjustments with a safer setting.'

function interruptedWorkflow(
  exportRecovery: UseRawWorkflowReturn['exportRecovery'],
) {
  return {
    ...workflowFixture(),
    supportLevel: 'experimental',
    exportResult: null,
    exportShareCapability: { available: false, reason: 'Export first.' },
    exportRecovery,
  } as unknown as UseRawWorkflowReturn
}

const INTERRUPTED: UseRawWorkflowReturn['exportRecovery'] = {
  status: 'ready-to-retry',
  exportId: 'attempt-1',
  message: 'The journal sentence the surfaces never show.',
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

function SurfaceWith({
  workflow,
  onExport,
}: {
  workflow: UseRawWorkflowReturn
  onExport: () => void
}) {
  return (
    <JotaiProvider store={jotaiStore}>
      <RawWorkflowToolProvider
        workflow={workflow}
        onlineLutSources={emptyOnlineLutSources()}
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
        <RawToolSurface />
      </RawWorkflowToolProvider>
    </JotaiProvider>
  )
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

  it('hands the surfaces one typed note for the loaded source, and no recovery entry', () => {
    let workflow = interruptedWorkflow(INTERRUPTED)
    const onExport = vi.fn()
    const { result, rerender } = renderHook(useRawWorkflowContext, {
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
    expect(result.current).not.toHaveProperty('recovery')
    expect(result.current).not.toHaveProperty('onRecoverExportSource')

    // A legacy shape reads as the same note.
    workflow = interruptedWorkflow({
      status: 'source-required',
      exportId: 'export-1',
      message: 'Please reselect frame.RAF.',
      expectedFileName: 'frame.RAF',
      manifest: {} as never,
    })
    rerender()
    expect(result.current.interruptionNote).toEqual({ kind: 'interrupted' })

    // Another source has no hint of its own, so the note goes.
    workflow = interruptedWorkflow({ status: 'none' })
    rerender()
    expect(result.current.interruptionNote).toBeNull()

    // The note mounting, changing and clearing starts no export.
    expect(onExport).not.toHaveBeenCalled()
    result.current.onExport()
    expect(onExport).toHaveBeenCalledExactlyOnceWith()
  })

  it('shows the note in the desktop export block, and only the explicit Export starts one', async () => {
    const user = userEvent.setup()
    const onExport = vi.fn()
    const prev = jotaiStore.get(viewportAtom)
    jotaiStore.set(viewportAtom, { ...prev, w: 1280, sm: true })
    try {
      const { container, rerender } = render(
        <SurfaceWith
          workflow={interruptedWorkflow(INTERRUPTED)}
          onExport={onExport}
        />,
      )
      const block = container.querySelector<HTMLElement>(
        '[data-raw-export-block]',
      )!
      expect(within(block).getByText(INTERRUPTED_HINT)).toHaveAttribute(
        'data-export-interruption',
      )
      expect(container).not.toHaveTextContent(/journal sentence/)

      rerender(
        <SurfaceWith
          workflow={interruptedWorkflow({ status: 'none' })}
          onExport={onExport}
        />,
      )
      expect(within(block).queryByText(INTERRUPTED_HINT)).toBeNull()
      expect(onExport).not.toHaveBeenCalled()

      await user.click(
        within(block).getByRole('button', {
          name: 'Export full-resolution JPEG',
        }),
      )
      expect(onExport).toHaveBeenCalledExactlyOnceWith()
    } finally {
      jotaiStore.set(viewportAtom, prev)
    }
  })

  it('shows the same note in the mobile export deck the topbar opens, and only the explicit Export starts one', async () => {
    const user = userEvent.setup()
    const onExport = vi.fn()
    const prev = jotaiStore.get(viewportAtom)
    jotaiStore.set(viewportAtom, { ...prev, w: 390, sm: false })
    try {
      const { container } = render(
        <SurfaceWith
          workflow={interruptedWorkflow(INTERRUPTED)}
          onExport={onExport}
        />,
      )
      const openExport = () =>
        user.click(
          container.querySelector<HTMLButtonElement>(
            '[data-mobile-export-action]',
          )!,
        )

      await openExport()
      const panel = container.querySelector<HTMLElement>(
        '[data-mobile-export-panel]',
      )!
      expect(within(panel).getByText(INTERRUPTED_HINT)).toHaveAttribute(
        'data-export-interruption',
      )
      expect(container).not.toHaveTextContent(/journal sentence/)

      // Closing and reopening the deck starts nothing.
      await user.click(
        within(panel).getByRole('button', { name: 'Close export' }),
      )
      expect(container.querySelector('[data-mobile-export-panel]')).toBeNull()
      await openExport()
      expect(screen.getByText(INTERRUPTED_HINT)).toBeVisible()
      expect(onExport).not.toHaveBeenCalled()

      await user.click(
        screen.getByRole('button', { name: 'Export full-resolution JPEG' }),
      )
      expect(onExport).toHaveBeenCalledExactlyOnceWith()
    } finally {
      jotaiStore.set(viewportAtom, prev)
    }
  })
})
