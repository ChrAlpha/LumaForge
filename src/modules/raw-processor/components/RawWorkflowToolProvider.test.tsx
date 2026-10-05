import type { ExportGeometry } from '@lumaforge/render-engine/export'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
import { captureTransformSource } from '../services/preview/capture-transform-source'
import { COLOR_NEUTRAL } from './color-fields'
import { useRawWorkflowContext } from './RawWorkflowContext'
import { RawWorkflowToolProvider } from './RawWorkflowToolProvider'
import { TONE_NEUTRAL } from './tone-fields'
import { transformFeatureFixture } from './tools/transform-feature.fixture'

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
      onRecoverExportSource={vi.fn()}
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
          onRecoverExportSource={vi.fn()}
          onPrepareRuntime={vi.fn()}
        >
          {children}
        </RawWorkflowToolProvider>
      ),
    })
    expect(result.current.transform).toBe(transform)
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
    result.current.onExport({ quality: 'high', fidelity: 'safe' })
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
    result.current.onExport({ quality: 'high', fidelity: 'safe' })
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
      result.current.onExport({ quality: 'high', fidelity: 'safe' })
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
    result.current.onExport({ quality: 'high', fidelity: 'safe' })
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
    result.current.onExport({ quality: 'high', fidelity: 'safe' })
    expect(onExport).not.toHaveBeenCalled()

    worker.answer()
    expect(commit).toHaveBeenCalledOnce()
    expect(result.current.transform?.active).toBe(true)
    expect(result.current.canExport).toBe(true)
    expect(result.current.canPreviewExport).toBe(false)
    result.current.onExport({ quality: 'high', fidelity: 'safe' })
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
    result.current.onExport({ quality: 'high', fidelity: 'safe' })
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
    result.current.onExport({ quality: 'high', fidelity: 'safe' })
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
    result.current.onExport({ quality: 'high', fidelity: 'safe' })
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
          onRecoverExportSource={vi.fn()}
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
          onCompareReset={vi.fn()}
          onLutDrop={vi.fn()}
          onExport={vi.fn()}
          onRecoverExportSource={vi.fn()}
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
          onRecoverExportSource={vi.fn()}
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
          onRecoverExportSource={vi.fn()}
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
          onRecoverExportSource={vi.fn()}
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
