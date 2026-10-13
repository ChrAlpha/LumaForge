import type {
  ColorGraphIntent,
  LUTColorProfile,
  LUTContractResolution,
  LUTData,
} from '@lumaforge/luma-color-runtime'
import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { createBlobOutputResult } from '@lumaforge/render-engine/export'
import { act, renderHook } from '@testing-library/react'
import i18n from 'i18next'
import { atom, createStore } from 'jotai'
import type { ComponentType, PropsWithChildren, SetStateAction } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '~/lib/i18n'
import type { DecodedImage } from '~/lib/raw/decoder'
import enMessages from '~/locales/en.json'

import type { ExportResult } from '../../../model/export-result'
import { createExportResult } from '../../../model/export-result'
import type { ImageSession, TransformState } from '../../../model/session'
import { createTransformState } from '../../../model/session-factory'
import {
  captureExportResultIdentity,
  isSameExportResult,
} from '../../../services/export/export-result-identity'
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
const SESSION_LOOK: ColorGraphIntent = {
  styleKind: 'builtin',
  builtinPreset: 'cinematic',
  intensity: 0.7,
  ...NEUTRAL_USER_COLOR_INTENT,
}

const CUSTOM_LOOK: ColorGraphIntent = {
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
    exportGeometry: null,
    transform: createTransformState('session-1'),
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

/**
 * A full-resolution JPEG the session delivered for `intent` and `lut`, from
 * the decoded frame's pinned exposure and no committed geometry.
 */
function createDeliveredFullResolution(
  session: ImageSession,
  intent: ColorGraphIntent,
  lut: LUTData | null,
  filename: string,
): ExportResult {
  return createExportResult({
    kind: 'full-resolution',
    output: createBlobOutputResult({
      filename,
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    }),
    width: 800,
    height: 600,
    now: () => 1,
    copyCapability: { mode: 'full-resolution' },
    identity: captureExportResultIdentity({
      resultKind: 'full-resolution',
      attemptId: 'attempt-1',
      sessionId: session.id,
      sourceFile: session.sourceFile.file!,
      intent,
      lut,
      rawRenderExposure: createDecodedImage().renderExposure,
      geometry: null,
    }),
  })
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
    clientEpoch: 1,
    requestId: 1,
    geometry: SAMPLE_GEOMETRY,
  }
  const events: Record<TransformStatus, TransformEvent[]> = {
    neutral: [],
    pending: [
      { type: 'capture', sourceId, captureKey, clientEpoch: 1 },
      request,
    ],
    accepted: [
      { type: 'capture', sourceId, captureKey, clientEpoch: 1 },
      request,
      {
        type: 'rendered',
        sourceId,
        captureKey,
        clientEpoch: 1,
        requestId: 1,
        geometry: SAMPLE_GEOMETRY,
        frame: { width: 800, height: 600 },
      },
    ],
    invalid: [
      { type: 'capture', sourceId, captureKey, clientEpoch: 1 },
      request,
      {
        type: 'render-failed',
        sourceId,
        captureKey,
        clientEpoch: 1,
        requestId: 1,
        failure: 'transform',
      },
    ],
    unavailable: [
      { type: 'capture', sourceId, captureKey, clientEpoch: 1 },
      { type: 'capture-failed', sourceId, captureKey, clientEpoch: 1 },
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

/**
 * A stand-in for the preview pipeline: it renders with the color and the LUT
 * it holds, which follow the store only when the test says the preview's
 * effects have run.
 */
function createPipeline(
  params: ColorGraphIntent,
  lut: LUTData | null,
  renderToHiddenCanvas: (size: {
    width: number
    height: number
  }) => Promise<HTMLCanvasElement>,
) {
  const held = { params, lut }
  return {
    held,
    pipeline: {
      renderToHiddenCanvas,
      getParams: () => ({ ...held.params, viewMode: 'processed' as const }),
      getLutData: () => held.lut,
    },
  }
}

/**
 * A live HQ export harness over a store: the session, the stored color and
 * the LUT live in atoms whose writes the next read sees in the same tick,
 * before any rerender, and the action reads them through getters. The refs
 * stand for the render-written copies, which follow nothing here, and the
 * pipeline holds the look it was created with until `drawStoredLook`.
 */
function setupHq(
  initial: ImageSession = createSession(),
  look: { params?: ColorGraphIntent; lut?: LUTData | null } = {},
  wrapper?: ComponentType<PropsWithChildren>,
) {
  const store = createStore()
  const sessionAtom = atom<ImageSession | null>(initial)
  const intentAtom = atom<ColorGraphIntent>(look.params ?? SESSION_LOOK)
  const lutAtom = atom<LUTData | null>(look.lut ?? null)
  const getSession = () => store.get(sessionAtom)
  const writeSession = (update: SetStateAction<ImageSession | null>) =>
    store.set(sessionAtom, update)
  const decodedImageRef: { current: DecodedImage | null } = {
    current: createDecodedImage(),
  }
  const exportGraphVersionRef = { current: 1 }
  const exportAbortControllerRef: { current: AbortController | null } = {
    current: null,
  }
  const isMountedRef = { current: true }
  const trace: string[] = []
  const renders: Array<{
    complete: (canvas: HTMLCanvasElement) => void
    fail: (error: unknown) => void
  }> = []
  const renderToHiddenCanvas = vi.fn(
    () =>
      new Promise<HTMLCanvasElement>((resolve, reject) => {
        trace.push('service:render')
        renders.push({ complete: resolve, fail: reject })
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
  const { held, pipeline } = createPipeline(
    store.get(intentAtom),
    store.get(lutAtom),
    renderToHiddenCanvas,
  )
  const pipelineRef: { current: typeof pipeline | null } = {
    current: pipeline,
  }
  const { result } = renderHook(
    () =>
      useHqPreviewExportAction({
        getSession,
        getColorIntent: () => store.get(intentAtom),
        getLutData: () => store.get(lutAtom),
        decodedImageRef,
        pipelineRef,
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
          writeSession(updater)
          trace.push(
            `state:session:${getSession()?.exportState.status ?? 'null'}`,
          )
        },
        setStatus: (status) => trace.push(`state:status:${status}`),
        toast: { success, error },
      }),
    { wrapper },
  )
  return {
    result,
    session: getSession,
    writeSession,
    writeIntent: (intent: ColorGraphIntent) => store.set(intentAtom, intent),
    writeLut: (lut: LUTData | null) => store.set(lutAtom, lut),
    /** The preview's effects run: the pipeline takes the stored look. */
    drawStoredLook() {
      held.params = store.get(intentAtom)
      held.lut = store.get(lutAtom)
    },
    held,
    pipelineRef,
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
    /** Completes the latest render, or the one at `index`. */
    complete(index = renders.length - 1) {
      renders[index]!.complete({ toBlob } as unknown as HTMLCanvasElement)
    },
    fail(reason: unknown, index = renders.length - 1) {
      renders[index]!.fail(reason)
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
      h.writeSession((live) => ({ ...live!, transform: transformAt(status) }))
      await exportPreviewImage()

      expect(h.trace).toEqual(['toast:error:HQ preview export is not ready'])
      expect(h.error).toHaveBeenCalledWith('HQ preview export is not ready', {
        description: enMessages['raw.transform.hqExportReason'],
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

    expect(h.session()?.exportState.status).toBe('ready')
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
        h.writeSession((live) => ({
          ...live!,
          transform: editTransform(live!.transform!, 4),
        }))
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
        h.writeSession((live) => ({ ...live!, id: 'session-2' }))
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
      const sessionAfterSupersession = h.session()
      h.complete()
      await pending

      expect(h.trace.slice(supersededAt)).toEqual(['test:superseded'])
      expect(h.session()).toBe(sessionAfterSupersession)
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
    h.writeSession((live) => ({ ...live!, exportGeometry: SAMPLE_GEOMETRY }))
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
      description: enMessages['raw.transform.hqExportReason'],
    })
    expect(h.toBlob).not.toHaveBeenCalled()
    expect(h.registerExportResultResource).not.toHaveBeenCalled()
    expect(h.session()?.exportState.result).toBeUndefined()
    expect(h.exportAbortControllerRef.current).toBeNull()
  })

  it.each(supersessions)(
    'does not record an HQ failure that arrives after $name',
    async ({ supersede }) => {
      const h = setupHq()
      const pending = h.result.current.exportPreviewImage()
      const supersededAt = h.trace.push('test:superseded') - 1
      supersede(h)
      const sessionAfterSupersession = h.session()
      h.fail(new Error('GPU device lost'))
      await pending

      expect(h.trace.slice(supersededAt)).toEqual(['test:superseded'])
      expect(h.session()).toBe(sessionAfterSupersession)
      expect(h.error).not.toHaveBeenCalled()
    },
  )
})

describe('useHqPreviewExportAction live store reads', () => {
  it('refuses a captured action once a pending Transform edit lands in the store, in the same tick', async () => {
    const h = setupHq({ ...createSession(), transform: transformAt('neutral') })
    const exportPreviewImage = h.result.current.exportPreviewImage
    // The first edit asks for a geometry the preview has not answered yet;
    // nothing rerenders before the action runs.
    h.writeSession((live) => ({
      ...live!,
      transform: editTransform(live!.transform!, 3),
    }))
    await exportPreviewImage()

    expect(h.trace).toEqual(['toast:error:HQ preview export is not ready'])
    expect(h.error).toHaveBeenCalledWith('HQ preview export is not ready', {
      description: enMessages['raw.transform.hqExportReason'],
    })
    expect(h.renderToHiddenCanvas).not.toHaveBeenCalled()
    expect(h.exportAbortControllerRef.current).toBeNull()
  })

  it.each([
    { name: 'a linear output', lut: LINEAR_OUTPUT_LUT },
    { name: 'an unconfirmed contract', lut: UNCONFIRMED_LUT },
  ])(
    'refuses a captured action once the store selects a LUT with $name the preview leaves out',
    async ({ lut }) => {
      const h = setupHq()
      const exportPreviewImage = h.result.current.exportPreviewImage
      // A LUT apply writes the session look, the color and the LUT in the
      // same tick, before any rerender or LUT effect.
      h.writeSession((live) => ({
        ...live!,
        activeStyle: createCustomLutSession().activeStyle,
      }))
      h.writeIntent(CUSTOM_LOOK)
      h.writeLut(lut)
      await exportPreviewImage()

      expect(h.trace).toEqual(['toast:error:HQ preview export is not ready'])
      expect(h.error).toHaveBeenCalledWith('HQ preview export is not ready', {
        description: enMessages['raw.export.previewLookUnavailable'],
      })
      expect(h.renderToHiddenCanvas).not.toHaveBeenCalled()
    },
  )

  it('names the session, color and LUT the store holds when a captured action runs', async () => {
    const h = setupHq()
    const exportPreviewImage = h.result.current.exportPreviewImage
    h.writeSession((live) => ({
      ...live!,
      activeStyle: createCustomLutSession().activeStyle,
    }))
    h.writeIntent({ ...CUSTOM_LOOK, userContrast: 25 })
    h.writeLut(ACCEPTED_LUT)
    // The preview's effects have drawn the written look; still no rerender
    // hands the surface a new action.
    h.drawStoredLook()
    const admitted = h.session()!
    const expected = captureExportResultIdentity({
      resultKind: 'hq-preview',
      attemptId: 'not-compared',
      sessionId: admitted.id,
      sourceFile: admitted.sourceFile.file!,
      intent: { ...CUSTOM_LOOK, userContrast: 25 },
      lut: ACCEPTED_LUT,
      rawRenderExposure: createDecodedImage().renderExposure,
      geometry: null,
    })
    const pending = exportPreviewImage()
    h.complete()
    await pending

    const result = h.session()?.exportState.result
    expect(result?.kind).toBe('hq-preview')
    expect(result?.filename).toBe('frame_kodak-2383_hq-preview.jpg')
    expect(result?.identity).toEqual({
      ...expected,
      attemptId: expect.any(String),
    })
  })

  /** The LUT the session holds, under a table of its own. */
  const ANOTHER_ACCEPTED_LUT: LUTData = {
    ...ACCEPTED_LUT,
    data: new Float32Array(ACCEPTED_LUT.data.length).fill(0.5),
  }

  const undrawnWrites: Array<{
    name: string
    initial: [ImageSession, { params: ColorGraphIntent; lut: LUTData | null }]
    write: (h: ReturnType<typeof setupHq>) => void
  }> = [
    {
      name: 'a color edit',
      initial: [createSession(), { params: SESSION_LOOK, lut: null }],
      write: (h) => h.writeIntent({ ...SESSION_LOOK, userContrast: 25 }),
    },
    {
      name: 'a LUT replacement',
      initial: [
        createCustomLutSession(),
        { params: CUSTOM_LOOK, lut: ACCEPTED_LUT },
      ],
      write: (h) => h.writeLut(ANOTHER_ACCEPTED_LUT),
    },
    {
      name: 'a LUT contract change',
      initial: [
        createCustomLutSession(),
        { params: CUSTOM_LOOK, lut: ACCEPTED_LUT },
      ],
      write: (h) =>
        h.writeLut({
          ...ACCEPTED_LUT,
          profileResolution: {
            kind: 'confirmed',
            confidence: 'user',
            profile: lutProfile({ id: 'other-profile' }),
          },
        }),
    },
  ]

  it.each(undrawnWrites)(
    'refuses a captured action after $name the preview pipeline has not drawn yet',
    async ({ initial, write }) => {
      const h = setupHq(...initial)
      const exportPreviewImage = h.result.current.exportPreviewImage
      // The store takes the write in the same tick; the pipeline still holds
      // the look it drew before, and would render that under the new name.
      write(h)
      await exportPreviewImage()

      expect(h.trace).toEqual(['toast:error:HQ preview export is not ready'])
      expect(h.error).toHaveBeenCalledWith('HQ preview export is not ready', {
        description: enMessages['raw.export.previewUnavailable'],
      })
      expect(h.renderToHiddenCanvas).not.toHaveBeenCalled()
      expect(h.exportAbortControllerRef.current).toBeNull()
      expect(h.session()?.exportState.status).toBe('idle')

      // Once the preview draws it, the same captured action exports it.
      h.drawStoredLook()
      const pending = exportPreviewImage()
      h.complete()
      await pending
      expect(h.session()?.exportState.result?.kind).toBe('hq-preview')
    },
  )

  it('never encodes a render the pipeline drew with another LUT than the attempt admitted', async () => {
    const h = setupHq(createCustomLutSession(), {
      params: CUSTOM_LOOK,
      lut: ACCEPTED_LUT,
    })
    const pending = h.result.current.exportPreviewImage()
    expect(h.renderToHiddenCanvas).toHaveBeenCalledTimes(1)
    const changedAt = h.trace.push('test:pipeline-lut') - 1
    // The pipeline takes another table while it renders.
    h.held.lut = ANOTHER_ACCEPTED_LUT
    h.complete()
    await pending

    expect(h.trace.slice(changedAt)).toEqual([
      'test:pipeline-lut',
      'state:session:idle',
      'state:status:ready',
      'state:progress:0',
      'toast:error:HQ preview export is not ready',
    ])
    expect(h.error).toHaveBeenCalledWith('HQ preview export is not ready', {
      description: enMessages['raw.export.previewUnavailable'],
    })
    expect(h.toBlob).not.toHaveBeenCalled()
    expect(h.registerExportResultResource).not.toHaveBeenCalled()
    expect(h.session()?.exportState.result).toBeUndefined()
    expect(h.exportAbortControllerRef.current).toBeNull()
  })

  it.each([
    [
      'the preview replaces its pipeline',
      (h: ReturnType<typeof setupHq>) => {
        // A pipeline holding the very same look still did not draw it.
        h.pipelineRef.current = createPipeline(
          h.held.params,
          h.held.lut,
          vi.fn(),
        ).pipeline
      },
    ],
    [
      'the preview releases its pipeline',
      (h: ReturnType<typeof setupHq>) => {
        h.pipelineRef.current = null
      },
    ],
    [
      'the preview frame carries another RAW render exposure',
      (h: ReturnType<typeof setupHq>) => {
        h.decodedImageRef.current = {
          ...createDecodedImage(),
          renderExposure: { ev: 1, multiplier: 2, source: 'identity' },
        }
      },
    ],
  ])('never encodes a render once %s while it draws', async (_, change) => {
    const h = setupHq()
    const pending = h.result.current.exportPreviewImage()
    expect(h.renderToHiddenCanvas).toHaveBeenCalledTimes(1)
    const changedAt = h.trace.push('test:changed') - 1
    change(h)
    h.complete()
    await pending

    expect(h.trace.slice(changedAt)).toEqual([
      'test:changed',
      'state:session:idle',
      'state:status:ready',
      'state:progress:0',
      'toast:error:HQ preview export is not ready',
    ])
    expect(h.toBlob).not.toHaveBeenCalled()
    expect(h.registerExportResultResource).not.toHaveBeenCalled()
    expect(h.session()?.exportState.result).toBeUndefined()
  })

  it.each(['completes', 'fails'] as const)(
    'leaves a successor attempt its state when a superseded render %s',
    async (ending) => {
      const h = setupHq()
      const first = h.result.current.exportPreviewImage()
      const second = h.result.current.exportPreviewImage()
      expect(h.renderToHiddenCanvas).toHaveBeenCalledTimes(2)
      const successorState = h.session()
      expect(successorState?.exportState.status).toBe('exporting')
      const supersededAt = h.trace.push('test:superseded') - 1

      if (ending === 'completes') h.complete(0)
      else h.fail(new Error('GPU device lost'), 0)
      await first

      expect(h.trace.slice(supersededAt)).toEqual(['test:superseded'])
      expect(h.session()).toBe(successorState)
      expect(h.exportAbortControllerRef.current).not.toBeNull()

      h.complete(1)
      await second
      expect(h.session()?.exportState.status).toBe('ready')
      expect(h.session()?.exportState.result?.kind).toBe('hq-preview')
      expect(h.registerExportResultResource).toHaveBeenCalledTimes(1)
      expect(h.exportAbortControllerRef.current).toBeNull()
    },
  )

  it('never replaces a full-resolution result that lands while a superseded HQ render runs', async () => {
    const h = setupHq()
    const pending = h.result.current.exportPreviewImage()
    // A full-resolution export takes the slot and delivers its result.
    const fullResolution = createDeliveredFullResolution(
      h.session()!,
      SESSION_LOOK,
      null,
      'frame_cinema_fullres.jpg',
    )
    h.exportAbortControllerRef.current = new AbortController()
    h.writeSession((live) => ({
      ...live!,
      exportState: {
        ...live!.exportState,
        status: 'ready',
        result: fullResolution,
      },
    }))
    const delivered = h.session()
    h.complete()
    await pending

    expect(h.session()).toBe(delivered)
    expect(h.session()?.exportState.result).toBe(fullResolution)
    expect(h.toBlob).not.toHaveBeenCalled()
    expect(h.registerExportResultResource).not.toHaveBeenCalled()
    expect(h.success).not.toHaveBeenCalled()
  })
})

describe('useHqPreviewExportAction refusal copy', () => {
  beforeEach(() => {
    localStorage.setItem('lumaforge.locale', 'zh-CN')
  })

  afterEach(() => {
    localStorage.clear()
    document.documentElement.lang = 'en'
  })

  it('shows a refusal before the bounded HQ frame in the current locale', async () => {
    const h = setupHq(createSession(), {}, I18nProvider)
    h.decodedImageRef.current = { ...createDecodedImage(), source: 'quick' }
    await h.result.current.exportPreviewImage()

    expect(h.error).toHaveBeenCalledWith('HQ 预览导出尚未就绪', {
      description: 'bounded HQ 预览完成后才能导出 HQ 预览 JPEG。',
    })
    expect(h.renderToHiddenCanvas).not.toHaveBeenCalled()
  })
})

describe('useHqPreviewExportAction notification copy', () => {
  afterEach(() => {
    localStorage.clear()
    document.documentElement.lang = 'en'
  })

  type Attempt = (h: ReturnType<typeof setupHq>) => void

  const ATTEMPTS: Record<string, Attempt> = {
    success: (h) => h.complete(),
    failure: (h) => h.fail(new Error('GPU device lost')),
    'failure without a message': (h) => h.fail('lost'),
    superseded: (h) => {
      h.exportGraphVersionRef.current += 1
      h.fail(new Error('GPU device lost'))
    },
    unmounted: (h) => {
      h.isMountedRef.current = false
      h.complete()
    },
  }

  async function notifyAll(wrapper?: ComponentType<PropsWithChildren>) {
    const shown: Record<string, unknown[][]> = {}
    for (const [name, settle] of Object.entries(ATTEMPTS)) {
      const h = setupHq(createSession(), {}, wrapper)
      const pending = h.result.current.exportPreviewImage()
      settle(h)
      await pending
      shown[name] = [
        ...h.success.mock.calls.map((call) => ['success', ...call]),
        ...h.error.mock.calls.map((call) => ['error', ...call]),
      ]
    }
    return shown
  }

  it('keeps every English notification', async () => {
    expect(await notifyAll()).toEqual({
      success: [['success', 'HQ preview JPEG ready']],
      failure: [
        [
          'error',
          'HQ preview export failed',
          { description: 'GPU device lost' },
        ],
      ],
      'failure without a message': [
        [
          'error',
          'HQ preview export failed',
          { description: 'HQ preview export failed.' },
        ],
      ],
      superseded: [],
      unmounted: [],
    })
  })

  it('shows each notification in the locale current when the attempt settles', async () => {
    const shown: Record<string, unknown[][]> = {}
    try {
      for (const [name, settle] of Object.entries(ATTEMPTS)) {
        localStorage.clear()
        await act(() => i18n.changeLanguage('en'))
        const h = setupHq(createSession(), {}, I18nProvider)
        const pending = h.result.current.exportPreviewImage()
        // The language menu switches while the preview renders.
        localStorage.setItem('lumaforge.locale', 'zh-CN')
        await act(() => i18n.changeLanguage('zh-CN'))
        settle(h)
        await pending
        shown[name] = [
          ...h.success.mock.calls.map((call) => ['success', ...call]),
          ...h.error.mock.calls.map((call) => ['error', ...call]),
        ]
      }
    } finally {
      await act(() => i18n.changeLanguage('en'))
    }

    expect(shown).toEqual({
      success: [['success', 'HQ 预览 JPEG 已就绪']],
      failure: [
        ['error', 'HQ 预览导出失败', { description: 'GPU device lost' }],
      ],
      'failure without a message': [
        ['error', 'HQ 预览导出失败', { description: 'HQ 预览导出失败。' }],
      ],
      superseded: [],
      unmounted: [],
    })
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
      // ending the attempt: the intent record in place, the stored color and
      // LUT, the decoded image (a new frame carries the source's pinned
      // exposure), the view.
      Object.assign(look, { intensity: 0.1, userExposureEv: 1.5 })
      h.writeIntent({ ...params, intensity: 0.2 })
      h.writeLut(
        lut && { ...lut, data: new Float32Array(lut.data.length).fill(1) },
      )
      h.decodedImageRef.current = { ...createDecodedImage(), width: 400 }
      h.writeSession((live) => ({
        ...live!,
        viewState: { ...live!.viewState, mode: 'original', zoom: 2 },
      }))
      h.complete()
      await pending

      const result = h.session()?.exportState.result
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
    const firstIdentity = h.session()?.exportState.result?.identity
    const second = h.result.current.exportPreviewImage()
    h.complete()
    await second
    const secondIdentity = h.session()?.exportState.result?.identity

    expect(firstIdentity && secondIdentity).toBeTruthy()
    expect(secondIdentity!.attemptId).not.toBe(firstIdentity!.attemptId)
    expect(secondIdentity!.inputSignature).toBe(firstIdentity!.inputSignature)
  })
})
