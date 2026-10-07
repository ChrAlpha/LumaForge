import type {
  ColorGraphIntentSource,
  LUTColorProfile,
  LUTContractResolution,
  LUTData,
} from '@lumaforge/luma-color-runtime'
import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { renderHook } from '@testing-library/react'
import type { Dispatch, SetStateAction } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { DecodedImage } from '~/lib/raw/decoder'

import { PREVIEW_TRANSFORM_HQ_EXPORT_REASON } from '../../../model/derive-session'
import type { ImageSession, TransformState } from '../../../model/session'
import { createTransformState } from '../../../model/session-factory'
import {
  captureExportResultIdentity,
  isSameExportResult,
} from '../../../services/export/export-result-identity'
import { HQ_PREVIEW_LOOK_EXPORT_REASON } from '../../../services/export/hq-preview-look'
import type {
  TransformEvent,
  TransformStatus,
} from '../../../services/transform/transform-state'
import {
  deriveTransformStatus,
  reduceTransformState,
} from '../../../services/transform/transform-state'
import { useHqPreviewExportAction } from './useHqPreviewExportAction'

/** The look the test session names: a built-in style WebGPU draws. */
const SESSION_LOOK: ColorGraphIntentSource = {
  styleKind: 'builtin',
  builtinPreset: 'cinematic',
  intensity: 0.7,
  ...NEUTRAL_USER_COLOR_INTENT,
}

const CUSTOM_LOOK: ColorGraphIntentSource = {
  ...SESSION_LOOK,
  styleKind: 'custom',
  builtinPreset: null,
}

function lutProfile(overrides: Partial<LUTColorProfile> = {}): LUTColorProfile {
  return {
    id: 'test-profile',
    label: 'Test profile',
    role: 'scene-creative',
    inputGamut: 'v-gamut',
    inputTransfer: 'v-log',
    inputRange: 'full',
    outputGamut: 'srgb-rec709',
    outputTransfer: 'srgb',
    outputRange: 'full',
    aliases: [],
    ...overrides,
  }
}

function lutData(profileResolution: LUTContractResolution): LUTData {
  return {
    size: 2,
    data: new Float32Array(2 ** 3 * 3),
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    inputProfile: 'v-log',
    profileResolution,
  }
}

/** Confirmed, but with a linear output export refuses. */
const LINEAR_OUTPUT_LUT = lutData({
  kind: 'confirmed',
  confidence: 'user',
  profile: lutProfile({ outputGamut: 'rec2020', outputTransfer: 'linear' }),
})
/** A recommended contract the user has not confirmed. */
const UNCONFIRMED_LUT = lutData({
  kind: 'recommended',
  recommendations: [lutProfile()],
})
const ACCEPTED_LUT = lutData({
  kind: 'confirmed',
  confidence: 'user',
  profile: lutProfile(),
})

function createCustomLutSession(): ImageSession {
  return {
    ...createSession(),
    activeStyle: {
      kind: 'custom',
      name: 'kodak-2383',
      defaultIntensity: 0.7,
      currentIntensity: 0.7,
    },
  }
}

function createSession(): ImageSession {
  return {
    id: 'session-1',
    createdAt: 1,
    sourceFile: {
      file: new File(['raw'], 'frame.dng'),
      name: 'frame.dng',
      extension: 'dng',
      sizeBytes: 3,
      metadata: { width: 800, height: 600 },
      supportLevel: 'experimental',
    },
    previewBundle: {
      embeddedPreview: { status: 'idle' },
      quickDecodePreview: { status: 'idle' },
      boundedHqPreview: { status: 'ready', width: 800, height: 600 },
      displaySource: 'bounded-hq',
      boundedHqRequiredForExport: false,
    },
    activeStyle: {
      kind: 'builtin',
      name: 'cinema',
      defaultIntensity: 0.7,
      currentIntensity: 0.7,
    },
    viewState: {
      mode: 'processed',
      compareSplit: 0.5,
      zoom: 1,
      panX: 0,
      panY: 0,
      fitMode: 'screen',
    },
    renderState: { status: 'ready', lastRenderSource: 'bounded-hq' },
    exportState: {
      status: 'idle',
      fullResCapability: { status: 'unknown' },
      retryRecommended: false,
    },
  }
}

function createDecodedImage(): DecodedImage {
  return {
    width: 800,
    height: 600,
    channels: 4,
    bitsPerChannel: 32,
    data: new Float32Array(800 * 600 * 4),
    layout: 'rgba-float32',
    colorSpace: 'linear-prophoto-rgb',
    source: 'bounded-hq',
    metadata: { width: 800, height: 600 },
    renderExposure: {
      ev: 0,
      multiplier: 1,
      source: 'identity',
    },
  }
}

/** A committed geometry: a slight rotation with the crop constrained. */
const SAMPLE_GEOMETRY = {
  matrix: [0.999, -0.035, 0.018, 0.035, 0.999, -0.017, 0, 0, 1],
  constrainCrop: true,
}

/** Asks the session's Transform for a manual rotation; a new intent. */
function editTransform(state: TransformState, rotate: number) {
  return reduceTransformState(state, {
    type: 'edit',
    sourceId: state.sourceId,
    intent: { manual: { ...state.intent.manual, rotate } },
  })
}

/**
 * A first Transform edit and the events that bring it to `status`, with no
 * geometry held unless the preview's answer was accepted.
 */
function transformAt(status: TransformStatus): TransformState {
  const sourceId = 'session-1'
  const captureKey = 'frame-1'
  const request: TransformEvent = {
    type: 'request',
    sourceId,
    captureKey,
    requestId: 1,
    geometry: SAMPLE_GEOMETRY,
  }
  const events: Record<TransformStatus, TransformEvent[]> = {
    neutral: [],
    pending: [{ type: 'capture', sourceId, captureKey }, request],
    accepted: [
      { type: 'capture', sourceId, captureKey },
      request,
      {
        type: 'rendered',
        sourceId,
        captureKey,
        requestId: 1,
        geometry: SAMPLE_GEOMETRY,
        frame: { width: 800, height: 600 },
      },
    ],
    invalid: [
      { type: 'capture', sourceId, captureKey },
      request,
      {
        type: 'render-failed',
        sourceId,
        captureKey,
        requestId: 1,
        failure: 'transform',
      },
    ],
    unavailable: [
      { type: 'capture', sourceId, captureKey },
      { type: 'capture-failed', sourceId, captureKey },
    ],
  }
  const neutral = createTransformState(sourceId)
  const state = events[status].reduce(
    reduceTransformState,
    status === 'neutral' ? neutral : editTransform(neutral, 2),
  )
  expect(deriveTransformStatus(state)).toBe(status)
  return state
}

/** A live HQ export harness whose session writes land in `sessionRef`. */
function setupHq(
  initial: ImageSession = createSession(),
  look: { params?: ColorGraphIntentSource; lut?: LUTData | null } = {},
) {
  const sessionRef: { current: ImageSession | null } = { current: initial }
  const paramsRef = { current: look.params ?? SESSION_LOOK }
  const lutDataRef = { current: look.lut ?? null }
  const decodedImageRef: { current: DecodedImage | null } = {
    current: createDecodedImage(),
  }
  const exportGraphVersionRef = { current: 1 }
  const exportAbortControllerRef: { current: AbortController | null } = {
    current: null,
  }
  const isMountedRef = { current: true }
  const trace: string[] = []
  let completeRender!: (canvas: HTMLCanvasElement) => void
  let failRender!: (error: unknown) => void
  const renderToHiddenCanvas = vi.fn(
    () =>
      new Promise<HTMLCanvasElement>((resolve, reject) => {
        trace.push('service:render')
        completeRender = resolve
        failRender = reject
      }),
  )
  const registerExportResultResource = vi.fn(() => {
    trace.push('service:registerExportResultResource')
  })
  // The JPEG encode of the rendered canvas.
  const toBlob = vi.fn((callback: BlobCallback) => {
    trace.push('service:encode')
    callback(new Blob(['jpeg'], { type: 'image/jpeg' }))
  })
  const success = vi.fn((message: string) => {
    trace.push(`toast:success:${message}`)
  })
  const error = vi.fn((message: string) => {
    trace.push(`toast:error:${message}`)
  })
  const { result } = renderHook(() =>
    useHqPreviewExportAction({
      sessionRef,
      paramsRef,
      lutDataRef,
      decodedImageRef,
      pipelineRef: { current: { renderToHiddenCanvas } },
      isMountedRef,
      exportGraphVersionRef,
      exportAbortControllerRef,
      previewCopyCanvasRef: { current: null },
      previewSuspended: false,
      abortExportWork: () => {
        trace.push('service:abortExportWork')
        exportAbortControllerRef.current?.abort()
        exportAbortControllerRef.current = null
      },
      queueExportResultResourceDisposal: vi.fn(),
      registerExportResultResource,
      scheduleToast: (notify) => notify(),
      setProgress: (progress) => trace.push(`state:progress:${progress}`),
      setSession: (updater) => {
        const next =
          typeof updater === 'function' ? updater(sessionRef.current) : updater
        trace.push(`state:session:${next?.exportState.status ?? 'null'}`)
        sessionRef.current = next
      },
      setStatus: (status) => trace.push(`state:status:${status}`),
      toast: { success, error },
    }),
  )
  return {
    result,
    sessionRef,
    paramsRef,
    lutDataRef,
    decodedImageRef,
    exportGraphVersionRef,
    exportAbortControllerRef,
    isMountedRef,
    trace,
    renderToHiddenCanvas,
    registerExportResultResource,
    success,
    error,
    toBlob,
    complete() {
      completeRender({ toBlob } as unknown as HTMLCanvasElement)
    },
    fail(reason: unknown) {
      failRender(reason)
    },
  }
}

describe('useHqPreviewExportAction attempt currency', () => {
  it.each(['pending', 'accepted', 'invalid', 'unavailable'] as const)(
    'refuses a captured HQ action once the Transform is %s, before any render',
    async (status) => {
      const h = setupHq()
      const exportPreviewImage = h.result.current.exportPreviewImage
      // The first non-neutral edit lands after the surface captured the
      // action; a pending Transform holds no geometry yet.
      h.sessionRef.current = {
        ...h.sessionRef.current!,
        transform: transformAt(status),
      }
      await exportPreviewImage()

      expect(h.trace).toEqual(['toast:error:HQ preview export is not ready'])
      expect(h.error).toHaveBeenCalledWith('HQ preview export is not ready', {
        description: PREVIEW_TRANSFORM_HQ_EXPORT_REASON,
      })
      expect(h.renderToHiddenCanvas).not.toHaveBeenCalled()
    },
  )

  it('exports with a neutral Transform', async () => {
    const h = setupHq({
      ...createSession(),
      transform: transformAt('neutral'),
    })
    const pending = h.result.current.exportPreviewImage()
    h.complete()
    await pending

    expect(h.sessionRef.current?.exportState.status).toBe('ready')
    expect(h.success).toHaveBeenCalledWith('HQ preview JPEG ready')
  })

  const supersessions: Array<{
    name: string
    supersede: (h: ReturnType<typeof setupHq>) => void
  }> = [
    {
      name: 'the export graph version advances',
      supersede(h) {
        h.exportGraphVersionRef.current += 1
      },
    },
    {
      name: 'the first Transform edit lands',
      supersede(h) {
        const live = h.sessionRef.current!
        h.sessionRef.current = {
          ...live,
          transform: editTransform(
            live.transform ?? createTransformState(live.id),
            4,
          ),
        }
      },
    },
    {
      name: 'another attempt takes the export slot',
      supersede(h) {
        h.exportAbortControllerRef.current = new AbortController()
      },
    },
    {
      name: 'the view unmounts',
      supersede(h) {
        h.isMountedRef.current = false
      },
    },
    {
      name: 'the session is replaced',
      supersede(h) {
        h.sessionRef.current = { ...h.sessionRef.current!, id: 'session-2' }
      },
    },
  ]

  it.each(supersessions)(
    'does not publish an HQ JPEG that completes after $name',
    async ({ supersede }) => {
      const h = setupHq()
      const pending = h.result.current.exportPreviewImage()
      expect(h.renderToHiddenCanvas).toHaveBeenCalledTimes(1)
      const supersededAt = h.trace.push('test:superseded') - 1
      supersede(h)
      const sessionAfterSupersession = h.sessionRef.current
      h.complete()
      await pending

      expect(h.trace.slice(supersededAt)).toEqual(['test:superseded'])
      expect(h.sessionRef.current).toBe(sessionAfterSupersession)
      expect(h.registerExportResultResource).not.toHaveBeenCalled()
      // The canvas rendered for the ended attempt is never encoded.
      expect(h.toBlob).not.toHaveBeenCalled()
    },
  )

  it('ends an attempt whose session comes to hold a geometry while it renders, before encoding', async () => {
    const h = setupHq({
      ...createSession(),
      transform: transformAt('neutral'),
    })
    const pending = h.result.current.exportPreviewImage()
    const supersededAt = h.trace.push('test:geometry') - 1
    // The same neutral intent, but a geometry the HQ JPEG would leave out.
    h.sessionRef.current = {
      ...h.sessionRef.current!,
      exportGeometry: SAMPLE_GEOMETRY,
    }
    h.complete()
    await pending

    expect(h.trace.slice(supersededAt)).toEqual([
      'test:geometry',
      'state:session:idle',
      'state:status:ready',
      'state:progress:0',
      'toast:error:HQ preview export is not ready',
    ])
    expect(h.error).toHaveBeenCalledWith('HQ preview export is not ready', {
      description: PREVIEW_TRANSFORM_HQ_EXPORT_REASON,
    })
    expect(h.toBlob).not.toHaveBeenCalled()
    expect(h.registerExportResultResource).not.toHaveBeenCalled()
    expect(h.sessionRef.current?.exportState.result).toBeUndefined()
    expect(h.exportAbortControllerRef.current).toBeNull()
  })

  it.each(supersessions)(
    'does not record an HQ failure that arrives after $name',
    async ({ supersede }) => {
      const h = setupHq()
      const pending = h.result.current.exportPreviewImage()
      const supersededAt = h.trace.push('test:superseded') - 1
      supersede(h)
      const sessionAfterSupersession = h.sessionRef.current
      h.fail(new Error('GPU device lost'))
      await pending

      expect(h.trace.slice(supersededAt)).toEqual(['test:superseded'])
      expect(h.sessionRef.current).toBe(sessionAfterSupersession)
      expect(h.error).not.toHaveBeenCalled()
    },
  )

  it('pins the write order of a current HQ attempt that succeeds or fails', async () => {
    const delivered = setupHq()
    const success = delivered.result.current.exportPreviewImage()
    delivered.complete()
    await success
    expect(delivered.trace).toEqual([
      'service:abortExportWork',
      'state:status:exporting',
      'state:progress:0',
      'state:session:exporting',
      'service:render',
      'service:encode',
      'service:registerExportResultResource',
      'state:session:ready',
      'state:progress:100',
      'state:status:ready',
      'toast:success:HQ preview JPEG ready',
    ])
    expect(delivered.exportAbortControllerRef.current).toBeNull()

    const failed = setupHq()
    const failure = failed.result.current.exportPreviewImage()
    failed.fail(new Error('GPU device lost'))
    await failure
    expect(failed.trace).toEqual([
      'service:abortExportWork',
      'state:status:exporting',
      'state:progress:0',
      'state:session:exporting',
      'service:render',
      'state:session:idle',
      'state:status:ready',
      'state:progress:0',
      'toast:error:HQ preview export failed',
    ])
    expect(failed.exportAbortControllerRef.current).toBeNull()
  })
})

describe('useHqPreviewExportAction result identity', () => {
  it.each([
    { name: 'the session look', params: SESSION_LOOK, lut: null },
    { name: 'a custom LUT', params: CUSTOM_LOOK, lut: ACCEPTED_LUT },
  ])(
    'records the request it captured before rendering $name',
    async ({ params, lut }) => {
      const look = { ...params }
      const session = lut === null ? createSession() : createCustomLutSession()
      const expected = captureExportResultIdentity({
        resultKind: 'hq-preview',
        attemptId: 'not-compared',
        sessionId: 'session-1',
        sourceFile: session.sourceFile.file!,
        intent: params,
        lut,
        rawRenderExposure: createDecodedImage().renderExposure,
        geometry: null,
      })
      const h = setupHq(session, { params: look, lut })
      const pending = h.result.current.exportPreviewImage()
      expect(h.renderToHiddenCanvas).toHaveBeenCalledTimes(1)

      // While it renders, what the request was read from moves on without
      // ending the attempt: the intent record in place, the refs, the view.
      Object.assign(look, { intensity: 0.1, userExposureEv: 1.5 })
      h.paramsRef.current = { ...params, intensity: 0.2 }
      h.lutDataRef.current = lut && {
        ...lut,
        data: new Float32Array(lut.data.length).fill(1),
      }
      h.decodedImageRef.current = {
        ...createDecodedImage(),
        renderExposure: { ev: 1, multiplier: 2, source: 'user' },
      }
      h.sessionRef.current = {
        ...h.sessionRef.current!,
        viewState: {
          ...h.sessionRef.current!.viewState,
          mode: 'original',
          zoom: 2,
        },
      }
      h.complete()
      await pending

      const result = h.sessionRef.current?.exportState.result
      expect(result?.kind).toBe('hq-preview')
      expect(result?.identity).toEqual({
        ...expected,
        attemptId: expect.any(String),
      })
      expect(result?.identity?.attemptId).not.toBe('')
      expect(
        isSameExportResult(result!.identity!, {
          ...expected,
          attemptId: result!.identity!.attemptId,
        }),
      ).toBe(true)
      expect(Object.isFrozen(result!.identity)).toBe(true)
      expect(h.registerExportResultResource).toHaveBeenCalledWith(result)
    },
  )

  it('names every attempt apart', async () => {
    const h = setupHq()
    const first = h.result.current.exportPreviewImage()
    h.complete()
    await first
    const firstIdentity = h.sessionRef.current?.exportState.result?.identity
    const second = h.result.current.exportPreviewImage()
    h.complete()
    await second
    const secondIdentity = h.sessionRef.current?.exportState.result?.identity

    expect(firstIdentity && secondIdentity).toBeTruthy()
    expect(secondIdentity!.attemptId).not.toBe(firstIdentity!.attemptId)
    expect(secondIdentity!.inputSignature).toBe(firstIdentity!.inputSignature)
  })
})

describe('useHqPreviewExportAction', () => {
  it('discards an HQ render completed after preview geometry invalidates its export', async () => {
    const sessionRef: { current: ImageSession | null } = {
      current: createSession(),
    }
    const exportGraphVersionRef = { current: 1 }
    const exportAbortControllerRef: { current: AbortController | null } = {
      current: null,
    }
    let completeRender!: (canvas: HTMLCanvasElement) => void
    const renderToHiddenCanvas = vi.fn(
      () =>
        new Promise<HTMLCanvasElement>((resolve) => {
          completeRender = resolve
        }),
    )
    const registerExportResultResource = vi.fn()
    const success = vi.fn()
    const error = vi.fn()
    const { result } = renderHook(() =>
      useHqPreviewExportAction({
        sessionRef,
        paramsRef: { current: SESSION_LOOK },
        lutDataRef: { current: null },
        decodedImageRef: { current: createDecodedImage() },
        pipelineRef: { current: { renderToHiddenCanvas } },
        isMountedRef: { current: true },
        exportGraphVersionRef,
        exportAbortControllerRef,
        previewCopyCanvasRef: { current: null },
        previewSuspended: false,
        abortExportWork: vi.fn(),
        queueExportResultResourceDisposal: vi.fn(),
        registerExportResultResource,
        scheduleToast: (notify) => notify(),
        setProgress: vi.fn(),
        setSession: (updater) => {
          sessionRef.current =
            typeof updater === 'function'
              ? updater(sessionRef.current)
              : updater
        },
        setStatus: vi.fn(),
        toast: { success, error },
      }),
    )
    const pending = result.current.exportPreviewImage()
    expect(renderToHiddenCanvas).toHaveBeenCalledTimes(1)
    exportAbortControllerRef.current!.abort()
    exportGraphVersionRef.current += 1
    sessionRef.current = {
      ...sessionRef.current!,
      exportGeometry: SAMPLE_GEOMETRY,
      exportState: { ...sessionRef.current!.exportState, status: 'idle' },
    }
    completeRender({
      toBlob: (callback: BlobCallback) =>
        callback(new Blob(['jpeg'], { type: 'image/jpeg' })),
    } as HTMLCanvasElement)
    await pending

    expect(sessionRef.current.exportState.result).toBeUndefined()
    expect(sessionRef.current.exportState.status).toBe('idle')
    expect(registerExportResultResource).not.toHaveBeenCalled()
    expect(success).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('rejects a previously captured HQ action after geometry becomes active', async () => {
    const sessionRef = { current: createSession() }
    const renderToHiddenCanvas = vi.fn()
    const setStatus = vi.fn()
    const error = vi.fn()
    const { result } = renderHook(() =>
      useHqPreviewExportAction({
        sessionRef,
        paramsRef: { current: SESSION_LOOK },
        lutDataRef: { current: null },
        decodedImageRef: { current: createDecodedImage() },
        pipelineRef: { current: { renderToHiddenCanvas } },
        isMountedRef: { current: true },
        exportGraphVersionRef: { current: 1 },
        exportAbortControllerRef: { current: null },
        previewCopyCanvasRef: { current: null },
        previewSuspended: false,
        abortExportWork: vi.fn(),
        queueExportResultResourceDisposal: vi.fn(),
        registerExportResultResource: vi.fn(),
        scheduleToast: (notify) => notify(),
        setProgress: vi.fn(),
        setSession: vi.fn(),
        setStatus,
        toast: { success: vi.fn(), error },
      }),
    )
    const exportPreviewImage = result.current.exportPreviewImage
    sessionRef.current = {
      ...sessionRef.current,
      exportGeometry: SAMPLE_GEOMETRY,
    }
    await exportPreviewImage()

    expect(renderToHiddenCanvas).not.toHaveBeenCalled()
    expect(setStatus).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith('HQ preview export is not ready', {
      description: PREVIEW_TRANSFORM_HQ_EXPORT_REASON,
    })
  })

  it('refuses an HQ export before the bounded HQ frame without clearing the delivered result', async () => {
    const previousResult = {
      kind: 'full-resolution',
      filename: 'frame_cinema_fullres.jpg',
    } as unknown as NonNullable<ImageSession['exportState']['result']>
    const sessionRef: { current: ImageSession | null } = {
      current: {
        ...createSession(),
        exportState: {
          ...createSession().exportState,
          status: 'ready',
          result: previousResult,
        },
      },
    }
    const setSession = vi.fn()
    const setStatus = vi.fn()
    const queueExportResultResourceDisposal = vi.fn()
    const abortExportWork = vi.fn()
    const error = vi.fn()
    const { result } = renderHook(() =>
      useHqPreviewExportAction({
        sessionRef,
        paramsRef: { current: SESSION_LOOK },
        lutDataRef: { current: null },
        decodedImageRef: {
          current: { ...createDecodedImage(), source: 'quick' },
        },
        pipelineRef: { current: { renderToHiddenCanvas: vi.fn() } },
        isMountedRef: { current: true },
        exportGraphVersionRef: { current: 1 },
        exportAbortControllerRef: { current: null },
        previewCopyCanvasRef: { current: null },
        previewSuspended: false,
        abortExportWork,
        queueExportResultResourceDisposal,
        registerExportResultResource: vi.fn(),
        scheduleToast: (notify) => notify(),
        setProgress: vi.fn(),
        setSession,
        setStatus,
        toast: { success: vi.fn(), error },
      }),
    )

    await result.current.exportPreviewImage()

    expect(error).toHaveBeenCalledWith(
      'HQ preview export is not ready',
      expect.anything(),
    )
    expect(abortExportWork).not.toHaveBeenCalled()
    expect(queueExportResultResourceDisposal).not.toHaveBeenCalled()
    expect(setSession).not.toHaveBeenCalled()
    expect(setStatus).not.toHaveBeenCalled()
    expect(sessionRef.current?.exportState.result).toBe(previousResult)
  })

  it('exports the bounded HQ preview and stores the completed result on the active session', async () => {
    class FakeClipboardItem {
      static supports(type: string) {
        return type === 'image/jpeg'
      }

      constructor(public readonly items: Record<string, Blob>) {}
    }
    vi.stubGlobal('navigator', { clipboard: { write: vi.fn() } })
    vi.stubGlobal('ClipboardItem', FakeClipboardItem)

    let session: ImageSession | null = createSession()
    const sessionRef: { current: ImageSession | null } = { current: session }
    const setSession: Dispatch<SetStateAction<ImageSession | null>> = vi.fn(
      (updater: SetStateAction<ImageSession | null>) => {
        session = typeof updater === 'function' ? updater(session) : updater
        sessionRef.current = session
      },
    )
    const fakeCanvas = {
      toBlob: vi.fn((callback: BlobCallback, type?: string) => {
        callback(new Blob(['jpeg'], { type: type ?? 'image/jpeg' }))
      }),
    } as unknown as HTMLCanvasElement
    const renderToHiddenCanvas = vi.fn().mockResolvedValue(fakeCanvas)
    const registerExportResultResource = vi.fn()
    const statusUpdates: string[] = []
    const progressUpdates: number[] = []
    const toastMessages: string[] = []
    const previewCopyCanvasRef = {
      current: {} as HTMLCanvasElement,
    }

    const { result } = renderHook(() =>
      useHqPreviewExportAction({
        sessionRef,
        paramsRef: { current: SESSION_LOOK },
        lutDataRef: { current: null },
        decodedImageRef: { current: createDecodedImage() },
        pipelineRef: { current: { renderToHiddenCanvas } },
        isMountedRef: { current: true },
        exportGraphVersionRef: { current: 1 },
        exportAbortControllerRef: { current: null },
        previewCopyCanvasRef,
        previewSuspended: false,
        previewExportDisabledReason: undefined,
        abortExportWork: vi.fn(),
        queueExportResultResourceDisposal: vi.fn(),
        registerExportResultResource,
        scheduleToast: (notify) => notify(),
        setProgress: (progress) => progressUpdates.push(progress),
        setSession,
        setStatus: (status) => statusUpdates.push(status),
        toast: {
          success: (message) => {
            toastMessages.push(message)
          },
          error: vi.fn(),
        },
      }),
    )

    await result.current.exportPreviewImage()

    expect(renderToHiddenCanvas).toHaveBeenCalledWith({
      width: 800,
      height: 600,
    })
    expect(fakeCanvas.toBlob).toHaveBeenCalledWith(
      expect.any(Function),
      'image/jpeg',
      0.92,
    )
    expect(registerExportResultResource).toHaveBeenCalledTimes(1)
    expect(previewCopyCanvasRef.current).toBeNull()
    expect(session?.exportState.status).toBe('ready')
    expect(session?.exportState.result?.kind).toBe('hq-preview')
    expect(session?.exportState.result?.filename).toBe(
      'frame_cinema_hq-preview.jpg',
    )
    expect(statusUpdates).toEqual(['exporting', 'ready'])
    expect(progressUpdates).toEqual([0, 100])
    expect(toastMessages).toEqual(['HQ preview JPEG ready'])
  })

  it('refuses an HQ export while the preview leaves out the selected LUT, even from a captured action', async () => {
    for (const selectedLut of [LINEAR_OUTPUT_LUT, UNCONFIRMED_LUT]) {
      const previousResult = {
        kind: 'full-resolution',
        filename: 'frame_kodak-2383_fullres.jpg',
      } as unknown as NonNullable<ImageSession['exportState']['result']>
      const sessionRef = {
        current: {
          ...createCustomLutSession(),
          exportState: {
            ...createSession().exportState,
            status: 'ready' as const,
            result: previousResult,
          },
        },
      }
      const lutDataRef: { current: LUTData | null } = { current: ACCEPTED_LUT }
      const renderToHiddenCanvas = vi.fn()
      const abortExportWork = vi.fn()
      const setSession = vi.fn()
      const setStatus = vi.fn()
      const error = vi.fn()
      const { result } = renderHook(() =>
        useHqPreviewExportAction({
          sessionRef,
          paramsRef: { current: CUSTOM_LOOK },
          lutDataRef,
          decodedImageRef: { current: createDecodedImage() },
          pipelineRef: { current: { renderToHiddenCanvas } },
          isMountedRef: { current: true },
          exportGraphVersionRef: { current: 1 },
          exportAbortControllerRef: { current: null },
          previewCopyCanvasRef: { current: null },
          previewSuspended: false,
          abortExportWork,
          queueExportResultResourceDisposal: vi.fn(),
          registerExportResultResource: vi.fn(),
          scheduleToast: (notify) => notify(),
          setProgress: vi.fn(),
          setSession,
          setStatus,
          toast: { success: vi.fn(), error },
        }),
      )
      // The surface captured the action while the LUT still drew.
      const exportPreviewImage = result.current.exportPreviewImage
      lutDataRef.current = selectedLut
      await exportPreviewImage()

      expect(renderToHiddenCanvas).not.toHaveBeenCalled()
      expect(abortExportWork).not.toHaveBeenCalled()
      expect(setSession).not.toHaveBeenCalled()
      expect(setStatus).not.toHaveBeenCalled()
      expect(sessionRef.current.exportState.result).toBe(previousResult)
      expect(error).toHaveBeenCalledWith('HQ preview export is not ready', {
        description: HQ_PREVIEW_LOOK_EXPORT_REASON,
      })
    }
  })

  it('names the HQ JPEG after a LUT the preview draws', async () => {
    let session: ImageSession | null = createCustomLutSession()
    const sessionRef: { current: ImageSession | null } = { current: session }
    const setSession: Dispatch<SetStateAction<ImageSession | null>> = vi.fn(
      (updater: SetStateAction<ImageSession | null>) => {
        session = typeof updater === 'function' ? updater(session) : updater
        sessionRef.current = session
      },
    )
    const renderToHiddenCanvas = vi.fn().mockResolvedValue({
      toBlob: (callback: BlobCallback) =>
        callback(new Blob(['jpeg'], { type: 'image/jpeg' })),
    } as HTMLCanvasElement)
    const { result } = renderHook(() =>
      useHqPreviewExportAction({
        sessionRef,
        paramsRef: { current: CUSTOM_LOOK },
        lutDataRef: { current: ACCEPTED_LUT },
        decodedImageRef: { current: createDecodedImage() },
        pipelineRef: { current: { renderToHiddenCanvas } },
        isMountedRef: { current: true },
        exportGraphVersionRef: { current: 1 },
        exportAbortControllerRef: { current: null },
        previewCopyCanvasRef: { current: null },
        previewSuspended: false,
        abortExportWork: vi.fn(),
        queueExportResultResourceDisposal: vi.fn(),
        registerExportResultResource: vi.fn(),
        scheduleToast: (notify) => notify(),
        setProgress: vi.fn(),
        setSession,
        setStatus: vi.fn(),
        toast: { success: vi.fn(), error: vi.fn() },
      }),
    )

    await result.current.exportPreviewImage()

    expect(renderToHiddenCanvas).toHaveBeenCalledTimes(1)
    expect(session?.exportState.result?.filename).toBe(
      'frame_kodak-2383_hq-preview.jpg',
    )
  })
})
