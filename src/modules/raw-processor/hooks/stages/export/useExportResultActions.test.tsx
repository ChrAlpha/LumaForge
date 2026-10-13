import type { ColorGraphIntent, LUTData } from '@lumaforge/luma-color-runtime'
import {
  NEUTRAL_USER_COLOR_INTENT,
  parseCubeLUT,
  toLUTData,
} from '@lumaforge/luma-color-runtime'
import type { FileBackedOutputResult } from '@lumaforge/render-engine/export'
import type { RenderManifest } from '@lumaforge/render-engine/manifest'
import { act, renderHook } from '@testing-library/react'
import i18n from 'i18next'
import { atom, createStore } from 'jotai'
import type { ComponentType, PropsWithChildren } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '~/lib/i18n'
import type { DecodedImage } from '~/lib/raw/decoder'
import type { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'

import type {
  ExportCopyCapability,
  ExportResult,
  ExportResultKind,
} from '../../../model/export-result'
import type { ImageSession } from '../../../model/session'
import { createImageSession } from '../../../model/session-factory'
import { captureExportResultIdentity } from '../../../services/export/export-result-identity'
import { claimExportSlot } from '../../../services/export/export-state'
import { useExportResultActions } from './useExportResultActions'

/** A preview pipeline as the hidden-canvas copy reads it. */
type PreviewPipeline = Pick<
  RawProcessingPipeline,
  'renderToHiddenCanvas' | 'getParams' | 'getLutData'
>

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const sourceFile = new File(['raw'], 'frame.dng', { lastModified: 1_000 })
const lutTable = new Float32Array(2 * 2 * 2 * 3).fill(0.5)

const filmCube = `TITLE "Film"\nLUT_3D_SIZE 2\n${'0.5 0.5 0.5\n'.repeat(8)}`

function makeLut(overrides: Partial<LUTData> = {}): LUTData {
  return {
    ...toLUTData(parseCubeLUT(filmCube)),
    data: lutTable,
    profileResolution: {
      kind: 'confirmed',
      profile: {
        id: 'display-srgb',
        label: 'Display sRGB',
        role: 'display-look',
        inputGamut: 'srgb-rec709',
        inputTransfer: 'srgb',
        inputRange: 'full',
        aliases: [],
      },
      confidence: 'user',
    },
    ...overrides,
  }
}

const intent: ColorGraphIntent = {
  styleKind: 'custom',
  builtinPreset: null,
  intensity: 0.37,
  ...NEUTRAL_USER_COLOR_INTENT,
}

const exposure = {
  ev: 0.5,
  multiplier: 2 ** 0.5,
  source: 'image-statistics' as const,
}

function createResult({
  kind = 'full-resolution',
  attemptId = 'attempt-1',
  session,
  lut = makeLut(),
  output,
  copyCapability = {
    mode: 'full-resolution',
  },
}: {
  kind?: ExportResultKind
  attemptId?: string
  session: ImageSession
  lut?: LUTData | null
  output: ExportResult['output']
  copyCapability?: ExportCopyCapability
}): ExportResult {
  return {
    kind,
    identity: captureExportResultIdentity({
      resultKind: kind,
      attemptId,
      sessionId: session.id,
      sourceFile,
      intent,
      lut,
      rawRenderExposure: exposure,
      geometry: session.exportGeometry ?? null,
    }),
    output,
    filename: 'frame.jpg',
    width: 800,
    height: 600,
    size: output.byteLength,
    createdAt: 1,
    copyCapability,
  }
}

/** A stored output whose materialization waits until the test releases it. */
function createPausedOutput() {
  const opened = deferred<Blob>()
  const openBlob = vi.fn(() => opened.promise)
  const output: FileBackedOutputResult = {
    kind: 'file-backed',
    exportId: 'export-1',
    filename: 'frame.jpg',
    byteLength: 4,
    mimeType: 'image/jpeg',
    openBlob,
  }
  return {
    output,
    openBlob,
    release: () => opened.resolve(new Blob(['jpeg'], { type: 'image/jpeg' })),
  }
}

function blobOutput(): ExportResult['output'] {
  return {
    kind: 'blob',
    filename: 'frame.jpg',
    byteLength: 4,
    mimeType: 'image/jpeg',
    blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
  }
}

function stubDelivery() {
  const createObjectURL = vi.fn(() => 'blob:delivery')
  const revokeObjectURL = vi.fn()
  vi.stubGlobal(
    'URL',
    Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }),
  )
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => {})
  const share = vi.fn().mockResolvedValue(undefined)
  const clipboardWrite = vi.fn().mockResolvedValue(undefined)
  class FakeClipboardItem {
    static supports(type: string) {
      return type === 'image/jpeg' || type === 'image/png'
    }

    constructor(public readonly items: Record<string, Blob>) {}
  }
  vi.stubGlobal('navigator', {
    canShare: () => true,
    share,
    clipboard: { write: clipboardWrite },
  })
  vi.stubGlobal('ClipboardItem', FakeClipboardItem)
  return { createObjectURL, click, share, clipboardWrite }
}

function createReadySession(
  overrides: Partial<ImageSession> = {},
): ImageSession {
  const session = createImageSession(sourceFile)
  return {
    ...session,
    exportState: { ...session.exportState, status: 'ready' },
    ...overrides,
  }
}

function setup({
  session = createReadySession(),
  result,
  pipeline = null,
  wrapper,
}: {
  session?: ImageSession
  result: (session: ImageSession) => ExportResult
  pipeline?: Pick<PreviewPipeline, 'renderToHiddenCanvas'> | null
  wrapper?: ComponentType<PropsWithChildren>
}) {
  const stored = result(session)
  // The session, color and LUT live in a store whose writes the next read
  // sees in the same tick; nothing rerenders the hook after it mounts.
  const store = createStore()
  const sessionAtom = atom<ImageSession | null>({
    ...session,
    exportState: { ...session.exportState, result: stored },
  })
  const intentAtom = atom<ColorGraphIntent>(intent)
  const lutAtom = atom<LUTData | null>(makeLut())
  const getSession = () => store.get(sessionAtom)
  // The pipeline draws the look it holds, which follows the store only when
  // a test says the preview's effects have run; it starts caught up.
  const held = { intent: store.get(intentAtom), lut: store.get(lutAtom) }
  const holdLook = (
    rendering: Pick<PreviewPipeline, 'renderToHiddenCanvas'>,
  ): PreviewPipeline => ({
    renderToHiddenCanvas: rendering.renderToHiddenCanvas,
    getParams: () => ({ ...held.intent, output: 'processed' as const }),
    getLutData: () => held.lut,
  })
  const refs = {
    getSession,
    getColorIntent: () => store.get(intentAtom),
    getLutData: () => store.get(lutAtom),
    exportGraphVersionRef: { current: 3 },
    exportAbortControllerRef: { current: null as AbortController | null },
    isMountedRef: { current: true },
    pipelineRef: {
      current: pipeline ? holdLook(pipeline) : null,
    } as { current: PreviewPipeline | null },
    decodedImageRef: {
      current: { renderExposure: exposure },
    } as { current: Pick<DecodedImage, 'renderExposure'> | null },
  }
  // The attempt that produced the result claimed the slot and released it
  // when it ended, as every completed export does.
  claimExportSlot(
    refs.exportAbortControllerRef,
    new AbortController(),
    stored.identity?.attemptId ?? 'attempt-1',
  )
  refs.exportAbortControllerRef.current = null
  const toast = { success: vi.fn(), error: vi.fn() }
  const { result: hook } = renderHook(
    () =>
      useExportResultActions({
        ...refs,
        previewSize: { width: 640, height: 480 },
        scheduleToast: (notify) => notify(),
        toast,
      }),
    { wrapper },
  )
  return {
    ...refs,
    held,
    holdLook,
    stored,
    toast,
    actions: () => hook.current,
    setSession: (session: ImageSession | null) =>
      store.set(sessionAtom, session),
    setIntent: (next: ColorGraphIntent) => store.set(intentAtom, next),
    setLut: (next: LUTData | null) => store.set(lutAtom, next),
  }
}

type Harness = ReturnType<typeof setup>

function withSession(
  harness: Harness,
  update: (session: ImageSession) => ImageSession,
) {
  const current = harness.getSession()
  if (current) harness.setSession(update(current))
}

function withResult(harness: Harness, result: ExportResult | undefined) {
  withSession(harness, (session) => ({
    ...session,
    exportState: { ...session.exportState, result },
  }))
}

/**
 * One change for each live read a delivery checks: the export graph, the
 * session, the export slot, the color intent, the LUT and the mount.
 */
const STALE_CHANGES: Array<[string, (harness: Harness) => void]> = [
  [
    'an edit moves the export graph',
    (harness) => {
      harness.exportGraphVersionRef.current += 1
    },
  ],
  [
    'the session is replaced',
    (harness) => {
      harness.setSession({
        ...createReadySession(),
        exportState: harness.getSession()!.exportState,
      })
    },
  ],
  [
    'a later attempt claims the export slot',
    (harness) => {
      claimExportSlot(
        harness.exportAbortControllerRef,
        new AbortController(),
        'attempt-2',
      )
    },
  ],
  [
    'the user color changes',
    (harness) => {
      harness.setIntent({ ...intent, userExposureEv: 0.4 })
    },
  ],
  [
    'the LUT table is replaced',
    (harness) => {
      harness.setLut(makeLut({ data: lutTable.slice() }))
    },
  ],
  [
    'the workflow unmounts',
    (harness) => {
      harness.isMountedRef.current = false
    },
  ],
]

describe('useExportResultActions', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('copies preview-size exports from a rendered hidden canvas', async () => {
    const { clipboardWrite } = stubDelivery()
    const fakeCanvas = {
      toBlob: vi.fn((callback: BlobCallback, type?: string) => {
        callback(new Blob(['png'], { type: type ?? 'image/png' }))
      }),
    } as unknown as HTMLCanvasElement
    const renderToHiddenCanvas = vi.fn().mockResolvedValue(fakeCanvas)
    const harness = setup({
      pipeline: { renderToHiddenCanvas },
      result: (session) =>
        createResult({
          session,
          output: blobOutput(),
          copyCapability: {
            mode: 'preview-size',
            reasonCode: 'full-resolution-copy-unsupported',
          },
        }),
    })

    await harness.actions().copyExportResult()

    expect(renderToHiddenCanvas).toHaveBeenCalledWith({
      width: 640,
      height: 480,
    })
    expect(fakeCanvas.toBlob).toHaveBeenCalledWith(
      expect.any(Function),
      'image/png',
    )
    expect(clipboardWrite).toHaveBeenCalledTimes(1)
    expect(harness.toast.success).toHaveBeenCalledWith(
      'Preview-size image copied',
    )
  })

  it('downloads the attached manifest and stays silent when none exists', async () => {
    const { createObjectURL } = stubDelivery()
    const manifest = {
      manifest_version: 1,
      kind: 'export',
      manifest_sha256: 'b'.repeat(64),
    } as unknown as RenderManifest
    const harness = setup({
      result: (session) => createResult({ session, output: blobOutput() }),
    })

    await harness.actions().downloadExportManifest()
    expect(createObjectURL).not.toHaveBeenCalled()

    withResult(harness, { ...harness.stored, manifest })
    await harness.actions().downloadExportManifest()

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(harness.toast.error).not.toHaveBeenCalled()
  })

  it.each(STALE_CHANGES)(
    'delivers nothing when %s while the output materializes',
    async (_change, change) => {
      const delivery = stubDelivery()
      const paused = createPausedOutput()
      const harness = setup({
        result: (session) => createResult({ session, output: paused.output }),
      })

      const pending = harness.actions().downloadExportResult()
      expect(paused.openBlob).toHaveBeenCalledTimes(1)
      change(harness)
      paused.release()
      await pending

      expect(delivery.createObjectURL).not.toHaveBeenCalled()
      expect(delivery.click).not.toHaveBeenCalled()
      expect(harness.toast.success).not.toHaveBeenCalled()
    },
  )

  it('delivers the result the store holds before any rerender shows it', async () => {
    const delivery = stubDelivery()
    const harness = setup({
      result: (session) => createResult({ session, output: blobOutput() }),
    })
    const { downloadExportResult } = harness.actions()
    // A later attempt publishes its result and releases the slot; the hook
    // has not rerendered since.
    claimExportSlot(
      harness.exportAbortControllerRef,
      new AbortController(),
      'attempt-2',
    )
    harness.exportAbortControllerRef.current = null
    const later = createResult({
      session: harness.getSession()!,
      attemptId: 'attempt-2',
      output: blobOutput(),
    })
    withResult(harness, later)

    await downloadExportResult()

    expect(delivery.click).toHaveBeenCalledTimes(1)
    expect(harness.toast.error).not.toHaveBeenCalled()
  })

  it('downloads nothing when a debug listener moves the graph as the output materializes', async () => {
    const delivery = stubDelivery()
    const harness = setup({
      result: (session) => createResult({ session, output: blobOutput() }),
    })
    const onDebug = (event: Event) => {
      const detail = (event as CustomEvent<{ type: string }>).detail
      if (detail.type === 'output-materialized') {
        harness.exportGraphVersionRef.current += 1
      }
    }
    window.addEventListener('lumaforge-export-debug', onDebug)
    try {
      await harness.actions().downloadExportResult()
    } finally {
      window.removeEventListener('lumaforge-export-debug', onDebug)
    }

    expect(delivery.createObjectURL).not.toHaveBeenCalled()
    expect(delivery.click).not.toHaveBeenCalled()
    expect(harness.toast.error).toHaveBeenCalledTimes(1)
  })

  it('refuses an HQ preview result once the session holds a geometry', async () => {
    const delivery = stubDelivery()
    const harness = setup({
      result: (session) =>
        createResult({ session, kind: 'hq-preview', output: blobOutput() }),
    })
    withSession(harness, (session) => ({
      ...session,
      exportGeometry: {
        matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        constrainCrop: true,
      },
    }))

    await harness.actions().downloadExportResult()

    expect(delivery.click).not.toHaveBeenCalled()
  })

  it('refuses the manifest of a result the workflow moved on from', async () => {
    const { createObjectURL } = stubDelivery()
    const manifest = { manifest_version: 1 } as unknown as RenderManifest
    const harness = setup({
      result: (session) => ({
        ...createResult({ session, output: blobOutput() }),
        manifest,
      }),
    })
    harness.setIntent({ ...intent, userContrast: 10 })

    await harness.actions().downloadExportManifest()

    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('does not copy a hidden-canvas render that became stale', async () => {
    const { clipboardWrite } = stubDelivery()
    const rendered = deferred<HTMLCanvasElement>()
    const canvas = {
      toBlob: vi.fn((callback: BlobCallback) => {
        callback(new Blob(['png'], { type: 'image/png' }))
      }),
    } as unknown as HTMLCanvasElement
    const harness = setup({
      pipeline: { renderToHiddenCanvas: () => rendered.promise },
      result: (session) =>
        createResult({
          session,
          output: blobOutput(),
          copyCapability: {
            mode: 'preview-size',
            reasonCode: 'full-resolution-copy-unsupported',
          },
        }),
    })

    const pending = harness.actions().copyExportResult()
    harness.exportGraphVersionRef.current += 1
    rendered.resolve(canvas)
    await pending

    expect(canvas.toBlob).not.toHaveBeenCalled()
    expect(clipboardWrite).not.toHaveBeenCalled()
  })

  describe('preview-size copy from the pipeline', () => {
    const NOT_READY = [
      'Copy failed',
      { description: 'Preview image is not ready to copy.' },
    ]

    function previewSizeResult(session: ImageSession) {
      return createResult({
        session,
        output: blobOutput(),
        copyCapability: {
          mode: 'preview-size',
          reasonCode: 'full-resolution-copy-unsupported',
        },
      })
    }

    function encodingCanvas(encode?: Promise<Blob | null>) {
      return {
        toBlob: vi.fn((callback: BlobCallback) => {
          if (encode) void encode.then(callback)
          else callback(new Blob(['png'], { type: 'image/png' }))
        }),
      } as unknown as HTMLCanvasElement
    }

    /** Ways the pipeline stops drawing the result the store still names. */
    const LAGS: Array<[string, (harness: Harness) => void]> = [
      [
        'the pipeline holds another tone than the store',
        (harness) => {
          harness.held.intent = { ...intent, userExposureEv: 0.4 }
        },
      ],
      [
        'the pipeline holds another look strength than the store',
        (harness) => {
          harness.held.intent = { ...intent, intensity: 0.38 }
        },
      ],
      [
        'the pipeline holds another LUT table than the store',
        (harness) => {
          harness.held.lut = makeLut({ data: lutTable.slice() })
        },
      ],
      [
        'the pipeline holds no LUT yet',
        (harness) => {
          harness.held.lut = null
        },
      ],
      [
        'the preview frame carries another RAW render exposure',
        (harness) => {
          harness.decodedImageRef.current = {
            renderExposure: { ...exposure, ev: 1, multiplier: 2 },
          }
        },
      ],
      [
        'the preview has no frame',
        (harness) => {
          harness.decodedImageRef.current = null
        },
      ],
    ]

    it.each(LAGS)(
      'renders nothing and copies nothing when %s',
      async (_, lag) => {
        const { clipboardWrite } = stubDelivery()
        const renderToHiddenCanvas = vi.fn(async () => encodingCanvas())
        const harness = setup({
          pipeline: { renderToHiddenCanvas },
          result: previewSizeResult,
        })
        lag(harness)

        await harness.actions().copyExportResult()

        expect(renderToHiddenCanvas).not.toHaveBeenCalled()
        expect(clipboardWrite).not.toHaveBeenCalled()
        expect(harness.toast.success).not.toHaveBeenCalled()
        expect(harness.toast.error.mock.calls).toEqual([NOT_READY])
      },
    )

    const DURING_RENDER: Array<[string, (harness: Harness) => void]> = [
      ...LAGS,
      [
        'the preview replaces its pipeline',
        (harness) => {
          harness.pipelineRef.current = harness.holdLook({
            renderToHiddenCanvas: vi.fn(async () => encodingCanvas()),
          })
        },
      ],
      [
        'the preview releases its pipeline',
        (harness) => {
          harness.pipelineRef.current = null
        },
      ],
    ]

    it.each(DURING_RENDER)(
      'never encodes a hidden-canvas render once %s while it renders',
      async (_, lag) => {
        const { clipboardWrite } = stubDelivery()
        const rendered = deferred<HTMLCanvasElement>()
        const canvas = encodingCanvas()
        const harness = setup({
          pipeline: { renderToHiddenCanvas: () => rendered.promise },
          result: previewSizeResult,
        })

        const pending = harness.actions().copyExportResult()
        lag(harness)
        rendered.resolve(canvas)
        await pending

        expect(canvas.toBlob).not.toHaveBeenCalled()
        expect(clipboardWrite).not.toHaveBeenCalled()
        expect(harness.toast.success).not.toHaveBeenCalled()
        expect(harness.toast.error.mock.calls).toEqual([NOT_READY])
      },
    )

    it.each(DURING_RENDER)(
      'never copies an encoded render once %s while it encodes',
      async (_, lag) => {
        const { clipboardWrite } = stubDelivery()
        const encoded = deferred<Blob | null>()
        const canvas = encodingCanvas(encoded.promise)
        const harness = setup({
          pipeline: { renderToHiddenCanvas: vi.fn(async () => canvas) },
          result: previewSizeResult,
        })

        const pending = harness.actions().copyExportResult()
        await vi.waitFor(() => expect(canvas.toBlob).toHaveBeenCalled())
        lag(harness)
        encoded.resolve(new Blob(['png'], { type: 'image/png' }))
        await pending

        expect(clipboardWrite).not.toHaveBeenCalled()
        expect(harness.toast.success).not.toHaveBeenCalled()
        expect(harness.toast.error.mock.calls).toEqual([NOT_READY])
      },
    )

    it('copies once the pipeline catches up with the store', async () => {
      const { clipboardWrite } = stubDelivery()
      const renderToHiddenCanvas = vi.fn(async () => encodingCanvas())
      const harness = setup({
        pipeline: { renderToHiddenCanvas },
        result: previewSizeResult,
      })
      harness.held.intent = { ...intent, userExposureEv: 0.4 }
      await harness.actions().copyExportResult()
      expect(clipboardWrite).not.toHaveBeenCalled()

      // The preview's effects run: the pipeline takes the stored look.
      harness.held.intent = harness.getColorIntent()
      harness.held.lut = harness.getLutData()
      await harness.actions().copyExportResult()

      expect(renderToHiddenCanvas).toHaveBeenCalledTimes(1)
      expect(clipboardWrite).toHaveBeenCalledTimes(1)
      expect(harness.toast.success).toHaveBeenCalledWith(
        'Preview-size image copied',
      )
    })

    it('reports a store edit during the render as a stale delivery', async () => {
      const { clipboardWrite } = stubDelivery()
      const rendered = deferred<HTMLCanvasElement>()
      const canvas = encodingCanvas()
      const harness = setup({
        pipeline: { renderToHiddenCanvas: () => rendered.promise },
        result: previewSizeResult,
      })

      const pending = harness.actions().copyExportResult()
      harness.setIntent({ ...intent, userExposureEv: 0.4 })
      rendered.resolve(canvas)
      await pending

      expect(canvas.toBlob).not.toHaveBeenCalled()
      expect(clipboardWrite).not.toHaveBeenCalled()
      expect(harness.toast.error.mock.calls).toEqual([
        [
          'Copy failed',
          {
            description:
              'This export no longer matches the photo. Export again to deliver it.',
          },
        ],
      ])
    })
  })

  it('delivers a current result after export released the preview', async () => {
    const delivery = stubDelivery()
    const harness = setup({
      pipeline: null,
      result: (session) =>
        createResult({
          session,
          output: blobOutput(),
          copyCapability: {
            mode: 'preview-size',
            reasonCode: 'full-resolution-copy-unsupported',
          },
        }),
    })

    await harness.actions().downloadExportResult()
    await harness.actions().shareExportResult()

    expect(delivery.click).toHaveBeenCalledTimes(1)
    expect(delivery.share).toHaveBeenCalledTimes(1)
    expect(harness.toast.error).not.toHaveBeenCalled()
  })
})

describe('useExportResultActions refusal copy', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    localStorage.clear()
    document.documentElement.lang = 'en'
  })

  function refuseCopyAndShare(wrapper?: ComponentType<PropsWithChildren>) {
    stubDelivery()
    // A browser that can neither share files nor copy the result.
    vi.stubGlobal('navigator', {})
    const harness = setup({
      wrapper,
      result: (session) =>
        createResult({
          session,
          output: blobOutput(),
          copyCapability: {
            mode: 'unavailable',
            reasonCode: 'clipboard-unsupported',
          },
        }),
    })
    return harness
  }

  it('describes a copy or share refusal by its code', async () => {
    const harness = refuseCopyAndShare()

    await harness.actions().copyExportResult()
    await harness.actions().shareExportResult()

    expect(harness.toast.error.mock.calls).toEqual([
      [
        'Copy failed',
        {
          description: 'Clipboard image copy is not supported in this browser.',
        },
      ],
      [
        'Share failed',
        { description: 'This browser cannot share JPEG files.' },
      ],
    ])
  })

  it('describes a preview copy that is not ready', async () => {
    stubDelivery()
    const harness = setup({
      pipeline: null,
      result: (session) =>
        createResult({
          session,
          output: blobOutput(),
          copyCapability: {
            mode: 'preview-size',
            reasonCode: 'full-resolution-copy-unsupported',
          },
        }),
    })

    await harness.actions().copyExportResult()

    expect(harness.toast.error).toHaveBeenCalledWith('Copy failed', {
      description: 'Preview image is not ready to copy.',
    })
  })
})

describe('useExportResultActions notification copy', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    localStorage.clear()
    document.documentElement.lang = 'en'
  })

  /** Throws whatever it is given, as a runtime that throws a non-Error does. */
  function fail(value: unknown): never {
    throw value
  }

  type Scenario = (wrapper?: ComponentType<PropsWithChildren>) => Promise<{
    success: unknown[][]
    error: unknown[][]
  }>

  function copyAs(
    kind: ExportResultKind,
    copyCapability: ExportCopyCapability,
    { encodes = true }: { encodes?: boolean } = {},
  ): Scenario {
    return async (wrapper) => {
      stubDelivery()
      // A browser that cannot encode the render hands `toBlob` no blob.
      const rendered = {
        toBlob: vi.fn((callback: BlobCallback) => {
          callback(encodes ? new Blob(['png'], { type: 'image/png' }) : null)
        }),
      } as unknown as HTMLCanvasElement
      const harness = setup({
        wrapper,
        pipeline: { renderToHiddenCanvas: async () => rendered },
        result: (session) =>
          createResult({
            session,
            kind,
            output: blobOutput(),
            copyCapability,
          }),
      })
      await harness.actions().copyExportResult()
      return {
        success: harness.toast.success.mock.calls,
        error: harness.toast.error.mock.calls,
      }
    }
  }

  function deliverWith(
    prepare: (
      delivery: ReturnType<typeof stubDelivery>,
      harness: Harness,
    ) => void,
    action: (actions: ReturnType<Harness['actions']>) => Promise<void>,
  ): Scenario {
    return async (wrapper) => {
      const delivery = stubDelivery()
      const harness = setup({
        wrapper,
        result: (session) => ({
          ...createResult({ session, output: blobOutput() }),
          manifest: { manifest_version: 1 } as unknown as RenderManifest,
        }),
      })
      prepare(delivery, harness)
      await action(harness.actions())
      return {
        success: harness.toast.success.mock.calls,
        error: harness.toast.error.mock.calls,
      }
    }
  }

  const SCENARIOS: Record<string, Scenario> = {
    'full-resolution copy': copyAs('full-resolution', {
      mode: 'full-resolution',
    }),
    'HQ preview copy': copyAs('hq-preview', { mode: 'hq-preview' }),
    'preview-size copy': copyAs('full-resolution', {
      mode: 'preview-size',
      reasonCode: 'full-resolution-copy-unsupported',
    }),
    'preview-size copy the browser cannot encode': copyAs(
      'full-resolution',
      {
        mode: 'preview-size',
        reasonCode: 'full-resolution-copy-unsupported',
      },
      { encodes: false },
    ),
    'download failure': deliverWith(
      (delivery) => {
        delivery.createObjectURL.mockImplementation(() =>
          fail(new Error('Object URL quota exceeded')),
        )
      },
      (actions) => actions.downloadExportResult(),
    ),
    'download failure without a message': deliverWith(
      (delivery) => {
        delivery.createObjectURL.mockImplementation(() => fail('revoked'))
      },
      (actions) => actions.downloadExportResult(),
    ),
    'manifest failure without a message': deliverWith(
      (delivery) => {
        delivery.createObjectURL.mockImplementation(() => fail('revoked'))
      },
      (actions) => actions.downloadExportManifest(),
    ),
    'share failure without a message': deliverWith(
      (delivery) => {
        delivery.share.mockRejectedValue('denied')
      },
      (actions) => actions.shareExportResult(),
    ),
    'copy failure without a message': deliverWith(
      (delivery) => {
        delivery.clipboardWrite.mockRejectedValue('denied')
      },
      (actions) => actions.copyExportResult(),
    ),
    'stale download': deliverWith(
      (_delivery, harness) => {
        harness.setIntent({ ...intent, userContrast: 10 })
      },
      (actions) => actions.downloadExportResult(),
    ),
    'stale manifest download': deliverWith(
      (_delivery, harness) => {
        harness.setIntent({ ...intent, userContrast: 10 })
      },
      (actions) => actions.downloadExportManifest(),
    ),
    'stale share': deliverWith(
      (_delivery, harness) => {
        harness.setIntent({ ...intent, userContrast: 10 })
      },
      (actions) => actions.shareExportResult(),
    ),
    'stale copy': deliverWith(
      (_delivery, harness) => {
        harness.setIntent({ ...intent, userContrast: 10 })
      },
      (actions) => actions.copyExportResult(),
    ),
    'cancelled share': deliverWith(
      (delivery) => {
        delivery.share.mockRejectedValue(
          new DOMException('Share canceled', 'AbortError'),
        )
      },
      (actions) => actions.shareExportResult(),
    ),
    'delivery after unmount': deliverWith(
      (_delivery, harness) => {
        harness.isMountedRef.current = false
      },
      (actions) => actions.downloadExportResult(),
    ),
  }

  async function notifyAll(wrapper?: ComponentType<PropsWithChildren>) {
    const shown: Record<string, unknown[][]> = {}
    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      const { success, error } = await scenario(wrapper)
      shown[name] = [
        ...success.map((call) => ['success', ...call]),
        ...error.map((call) => ['error', ...call]),
      ]
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }
    return shown
  }

  const STALE =
    'This export no longer matches the photo. Export again to deliver it.'

  it('keeps every English notification', async () => {
    expect(await notifyAll()).toEqual({
      'full-resolution copy': [['success', 'Full-resolution image copied']],
      'HQ preview copy': [['success', 'HQ preview image copied']],
      'preview-size copy': [['success', 'Preview-size image copied']],
      'preview-size copy the browser cannot encode': [
        ['error', 'Copy failed', { description: 'Preview image copy failed.' }],
      ],
      'download failure': [
        [
          'error',
          'Download failed',
          { description: 'Object URL quota exceeded' },
        ],
      ],
      'download failure without a message': [
        [
          'error',
          'Download failed',
          { description: 'Download action failed.' },
        ],
      ],
      'manifest failure without a message': [
        [
          'error',
          'Manifest download failed',
          { description: 'Manifest download failed.' },
        ],
      ],
      'share failure without a message': [
        ['error', 'Share failed', { description: 'Share action failed.' }],
      ],
      'copy failure without a message': [
        ['error', 'Copy failed', { description: 'Copy action failed.' }],
      ],
      'stale download': [['error', 'Download failed', { description: STALE }]],
      'stale manifest download': [
        ['error', 'Manifest download failed', { description: STALE }],
      ],
      'stale share': [['error', 'Share failed', { description: STALE }]],
      'stale copy': [['error', 'Copy failed', { description: STALE }]],
      'cancelled share': [],
      'delivery after unmount': [],
    })
  })
})

describe('useExportResultActions after a locale change', () => {
  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    localStorage.clear()
    await act(() => i18n.changeLanguage('en'))
    document.documentElement.lang = 'en'
  })

  /** What the language menu does while a delivery waits. */
  async function switchLocale(locale: 'en' | 'zh-CN') {
    localStorage.setItem('lumaforge.locale', locale)
    await act(() => i18n.changeLanguage(locale))
  }

  it('refuses a delivery that went stale in the locale current when it is refused', async () => {
    stubDelivery()
    const paused = createPausedOutput()
    const harness = setup({
      wrapper: I18nProvider,
      result: (session) => createResult({ session, output: paused.output }),
    })
    const pending = harness.actions().downloadExportResult()
    await switchLocale('zh-CN')
    harness.setIntent({ ...intent, userContrast: 10 })

    paused.release()
    await pending

    expect(harness.toast.error.mock.calls).toEqual([
      [
        '下载失败',
        { description: '此导出已与照片不一致。请重新导出后再交付。' },
      ],
    ])
  })
})
