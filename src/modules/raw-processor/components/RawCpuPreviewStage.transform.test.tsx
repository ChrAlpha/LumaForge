import type { ProcessingParams } from '@lumaforge/luma-color-runtime'
import { pickColorGraphIntent } from '@lumaforge/luma-color-runtime'
import type { ExportGeometry } from '@lumaforge/render-engine/export'
import type {
  CpuPreviewRequest,
  CpuPreviewResponse,
} from '@lumaforge/render-engine/preview'
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'
import type { DecodedImage } from '~/lib/raw/decoder'
import { identityMatrix } from '~/lib/transform/geometry/matrix'
import type { UprightAnalysis } from '~/lib/transform/geometry/types'
import type { PreviewSource } from '~/lib/transform/preview-types'
import { NEUTRAL_TRANSFORM } from '~/lib/transform/transform-types'
import type {
  TransformWorkerRequest,
  TransformWorkerResponse,
} from '~/lib/transform/worker-protocol'

import { useTransformSessionFixture } from '../hooks/transform-session.fixture'
import { useRawTransformFeature } from '../hooks/useRawTransformFeature'
import type { UseRawWorkflowReturn } from '../hooks/useRawWorkflow.types'
import { captureTransformSource } from '../services/preview/capture-transform-source'
import { RawCpuPreviewStage } from './RawCpuPreviewStage'

vi.mock(
  '../services/preview/capture-transform-source',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../services/preview/capture-transform-source')
    >()),
    captureTransformSource: vi.fn(),
  }),
)
vi.mock('./CpuPreviewCanvas', () => ({
  CpuPreviewCanvas: () => <div data-testid="cpu-canvas" />,
}))

type WorkerMessage = CpuPreviewRequest | TransformWorkerRequest
type WorkerResponse = CpuPreviewResponse | TransformWorkerResponse

/** Stands in for both the CPU preview worker and the Transform worker. */
class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: { data: WorkerResponse }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  readonly posted: WorkerMessage[] = []
  constructor() {
    FakeWorker.instances.push(this)
  }
  postMessage(message: WorkerMessage) {
    this.posted.push(message)
  }
  terminate() {}
  emit(data: WorkerResponse) {
    act(() => this.onmessage?.({ data }))
  }
}

type CpuRender = Extract<CpuPreviewRequest, { type: 'render' }>
type TransformRender = Extract<TransformWorkerRequest, { type: 'render' }>

function cpuWorker() {
  const worker = FakeWorker.instances.find(
    (instance) => instance.posted[0]?.type === 'loadSource',
  )
  if (!worker) throw new Error('expected the CPU preview worker')
  return worker
}

function transformWorker() {
  const worker = FakeWorker.instances.find(
    (instance) => instance.posted[0]?.type === 'analyze',
  )
  if (!worker) throw new Error('expected the Transform worker')
  return worker
}

function cpuRenders() {
  return cpuWorker().posted.filter(
    (message): message is CpuRender =>
      message.type === 'render' && 'graph' in message,
  )
}

function finishCpuRender(request: CpuRender) {
  cpuWorker().emit({
    type: 'rendered',
    sourceId: request.sourceId,
    requestId: request.requestId,
    rgba: new Uint8ClampedArray(80 * 60 * 4),
    width: 80,
    height: 60,
  })
}

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

/** Analyses the captured frame, then answers the render it asks for. */
function answerTransform() {
  const worker = transformWorker()
  const analyze = worker.posted.findLast(
    (message) => message.type === 'analyze',
  )!
  worker.emit({
    type: 'analyzed',
    sourceId: analyze.sourceId,
    analysis,
    elapsedMs: 1,
  })
  const request = worker.posted.findLast(
    (message): message is TransformRender => message.type === 'render',
  )!
  worker.emit({
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

const image = {
  width: 80,
  height: 60,
  channels: 3,
  bitsPerChannel: 16,
  data: new Uint16Array(80 * 60 * 3),
  layout: 'rgb-u16',
  colorSpace: 'linear-prophoto-rgb',
  source: 'quick',
  metadata: { width: 80, height: 60 },
  renderExposure: { ev: 0, multiplier: 1, source: 'identity' },
} as DecodedImage

function acceptedFrame(
  over: Partial<DecodedPreviewFrame> &
    Pick<DecodedPreviewFrame, 'frameId' | 'stage'>,
): DecodedPreviewFrame {
  return {
    sessionId: 'session-1',
    width: 80,
    height: 60,
    exposure: {
      kind: 'source-pin',
      value: { ev: 0, multiplier: 1, source: 'identity' },
    },
    quickPredecessorFrameId: null,
    ...over,
  }
}

const quickFrame = acceptedFrame({ frameId: 'decoded-frame-1', stage: 'quick' })
const hqImage = { ...image, source: 'bounded-hq' } as DecodedImage

const baseParams: ProcessingParams = {
  intensity: 1,
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

const captured: PreviewSource = {
  name: 'frame.nef',
  kind: 'raw',
  originalWidth: 80,
  originalHeight: 60,
  frame: { width: 80, height: 60, data: new Uint8ClampedArray(80 * 60 * 4) },
}

type Feature = ReturnType<typeof useRawTransformFeature>
const latest: { feature: Feature | null; geometry: ExportGeometry | null } = {
  feature: null,
  geometry: null,
}

/** The CPU stage handing its processed frames to Transform, as /raw wires it. */
function CpuTransformHarness({
  userTemperature,
  decodedImage = image,
  decodedFrame = quickFrame,
}: {
  userTemperature: number
  decodedImage?: DecodedImage
  decodedFrame?: DecodedPreviewFrame
}) {
  const { transform, geometry } = useTransformSessionFixture('one')
  const params = { ...baseParams, userTemperature }
  const feature = useRawTransformFeature(
    {
      hasImage: true,
      sourceFileName: 'frame.nef',
      status: 'ready',
      decodedImageVersion: 1,
      lutDataVersion: 1,
      decodedImageRef: { current: decodedImage },
      decodedFrame,
      pipelineRef: { current: null },
      viewMode: 'processed',
      params,
      previewSuspended: false,
      transform,
      setViewMode: () => {},
    } as unknown as UseRawWorkflowReturn,
    true,
  )
  latest.feature = feature
  latest.geometry = geometry
  return (
    <RawCpuPreviewStage
      image={decodedImage}
      decodedFrame={decodedFrame}
      color={pickColorGraphIntent(params)}
      lut={null}
      fallbackThumbnailUrl={null}
      onProcessedFrame={feature.setCpuFrame}
      transformActive={feature.active}
    />
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeWorker.instances = []
  vi.stubGlobal('Worker', FakeWorker)
  vi.mocked(captureTransformSource).mockResolvedValue(captured)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('cPU preview frames handed to Transform', () => {
  it('solves a first Transform on the newest colour, not a frame still being replaced', async () => {
    const view = render(<CpuTransformHarness userTemperature={0} />)
    finishCpuRender(cpuRenders().at(-1)!)

    // A colour edit renders, and a second one waits behind it.
    view.rerender(<CpuTransformHarness userTemperature={10} />)
    const older = cpuRenders().at(-1)!
    view.rerender(<CpuTransformHarness userTemperature={20} />)
    expect(cpuRenders()).toHaveLength(2)

    act(() => {
      latest.feature!.observe()
      latest.feature!.setManual({ ...NEUTRAL_TRANSFORM, rotate: 3 })
    })
    expect(latest.feature!.exportBlock).toBe('pending')

    // The older colour lands while the newer one is still on the worker.
    finishCpuRender(older)
    const newer = cpuRenders().at(-1)!
    expect(newer.requestId).toBeGreaterThan(older.requestId)
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).not.toHaveBeenCalled()
    expect(latest.geometry).toBeNull()
    expect(latest.feature!.exportBlock).toBe('pending')

    finishCpuRender(newer)
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(captureTransformSource).toHaveBeenCalledOnce()
    expect(
      vi.mocked(captureTransformSource).mock.lastCall?.[0].cpuFrame?.requestId,
    ).toBe(newer.requestId)
    expect(latest.feature!.exportBlock).toBe('pending')

    answerTransform()
    expect(latest.geometry).not.toBeNull()
    expect(latest.feature!.exportBlock).toBeNull()
    view.unmount()
  })

  it('hands Transform frames named by the CPU source the accepted frame loaded', async () => {
    const view = render(<CpuTransformHarness userTemperature={0} />)
    const loads = () =>
      cpuWorker().posted.filter((message) => message.type === 'loadSource')
    expect(loads()).toEqual([
      expect.objectContaining({ sourceId: quickFrame.frameId }),
    ])
    finishCpuRender(cpuRenders().at(-1)!)

    act(() => {
      latest.feature!.observe()
      latest.feature!.setManual({ ...NEUTRAL_TRANSFORM, rotate: 3 })
    })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(
      vi.mocked(captureTransformSource).mock.lastCall?.[0].cpuFrame?.sourceId,
    ).toBe(quickFrame.frameId)
    answerTransform()
    expect(latest.feature!.exportBlock).toBeNull()

    // The HQ continuation of the quick frame keeps the quick source, and the
    // frames Transform reads keep naming it.
    view.rerender(
      <CpuTransformHarness
        userTemperature={0}
        decodedImage={hqImage}
        decodedFrame={acceptedFrame({
          frameId: 'decoded-frame-2',
          stage: 'bounded-hq',
          quickPredecessorFrameId: quickFrame.frameId,
        })}
      />,
    )
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(loads()).toHaveLength(1)
    for (const [input] of vi.mocked(captureTransformSource).mock.calls) {
      expect(input.cpuFrame?.sourceId).toBe(quickFrame.frameId)
    }

    // A bounded-HQ frame that continues no loaded quick frame is loaded as
    // its own source: Transform waits for a frame rendered from it.
    const replacement = acceptedFrame({
      frameId: 'decoded-frame-3',
      stage: 'bounded-hq',
    })
    const capturesBeforeReplacement = vi.mocked(captureTransformSource).mock
      .calls.length
    view.rerender(
      <CpuTransformHarness
        userTemperature={0}
        decodedImage={{ ...hqImage }}
        decodedFrame={replacement}
      />,
    )
    expect(loads().at(-1)).toMatchObject({ sourceId: replacement.frameId })
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(vi.mocked(captureTransformSource).mock.calls).toHaveLength(
      capturesBeforeReplacement,
    )

    finishCpuRender(cpuRenders().at(-1)!)
    await act(() => vi.advanceTimersByTimeAsync(150))
    expect(
      vi.mocked(captureTransformSource).mock.lastCall?.[0].cpuFrame?.sourceId,
    ).toBe(replacement.frameId)
    view.unmount()
  })
})
