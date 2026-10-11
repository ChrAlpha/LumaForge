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
  previewCopyCanvas = null,
  pipeline = null,
  wrapper,
}: {
  session?: ImageSession
  result: (session: ImageSession) => ExportResult
  previewCopyCanvas?: HTMLCanvasElement | null
  pipeline?: { renderToHiddenCanvas: () => Promise<HTMLCanvasElement> } | null
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
  const refs = {
    getSession,
    getColorIntent: () => store.get(intentAtom),
    getLutData: () => store.get(lutAtom),
    exportGraphVersionRef: { current: 3 },
    exportAbortControllerRef: { current: null as AbortController | null },
    isMountedRef: { current: true },
    pipelineRef: { current: pipeline },
    previewCopyCanvasRef: { current: previewCopyCanvas },
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

/** Every way the request a result answers can stop being the current one. */
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
    'the session is reset',
    (harness) => {
      harness.setSession(null)
    },
  ],
  [
    'the source file is replaced',
    (harness) =>
      withSession(harness, (session) => ({
        ...session,
        sourceFile: {
          ...session.sourceFile,
          file: new File(['other'], 'frame.dng', { lastModified: 2_000 }),
        },
      })),
  ],
  ['the result is cleared', (harness) => withResult(harness, undefined)],
  [
    'a later attempt replaces the result',
    (harness) =>
      withResult(harness, {
        ...harness.stored,
        identity: captureExportResultIdentity({
          resultKind: harness.stored.kind ?? 'full-resolution',
          attemptId: 'attempt-2',
          sessionId: harness.getSession()!.id,
          sourceFile,
          intent,
          lut: makeLut(),
          rawRenderExposure: exposure,
          geometry: null,
        }),
      }),
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
    'a later attempt claims the export slot and ends',
    (harness) => {
      claimExportSlot(
        harness.exportAbortControllerRef,
        new AbortController(),
        'attempt-2',
      )
      harness.exportAbortControllerRef.current = null
    },
  ],
  [
    'a controller no claim recorded holds the export slot',
    (harness) => {
      harness.exportAbortControllerRef.current = new AbortController()
    },
  ],
  [
    'the user color changes',
    (harness) => {
      harness.setIntent({ ...intent, userExposureEv: 0.4 })
    },
  ],
  [
    'the look strength changes',
    (harness) => {
      harness.setIntent({ ...intent, intensity: 0.38 })
    },
  ],
  [
    'the LUT table is replaced',
    (harness) => {
      harness.setLut(makeLut({ data: lutTable.slice() }))
    },
  ],
  [
    'the LUT contract changes',
    (harness) => {
      harness.setLut(
        makeLut({
          profileResolution: { kind: 'unknown' },
        }),
      )
    },
  ],
  [
    'the Transform intent is pending',
    (harness) =>
      withSession(harness, (session) => ({
        ...session,
        transform: {
          sourceId: session.transform.sourceId,
          intent: { ...session.transform.intent, upright: 'auto' },
          capture: session.transform.capture,
          issuedRequests: session.transform.issuedRequests,
          request: session.transform.request,
          accepted: session.transform.accepted,
        },
      })),
  ],
  [
    'the committed geometry changes',
    (harness) =>
      withSession(harness, (session) => ({
        ...session,
        exportGeometry: {
          matrix: [1, 0, 0.01, 0, 1, 0, 0, 0, 1],
          constrainCrop: true,
        },
      })),
  ],
  [
    'the workflow unmounts',
    (harness) => {
      harness.isMountedRef.current = false
    },
  ],
]

const ACTIONS = ['download', 'share', 'copy'] as const

function run(harness: Harness, action: (typeof ACTIONS)[number]) {
  const actions = harness.actions()
  return action === 'download'
    ? actions.downloadExportResult()
    : action === 'share'
      ? actions.shareExportResult()
      : actions.copyExportResult()
}

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

  describe.each(ACTIONS)('%s of a completed result', (action) => {
    it.each(STALE_CHANGES)(
      'delivers nothing when %s while the output materializes',
      async (_change, change) => {
        const delivery = stubDelivery()
        const paused = createPausedOutput()
        const harness = setup({
          result: (session) => createResult({ session, output: paused.output }),
        })

        const pending = run(harness, action)
        expect(paused.openBlob).toHaveBeenCalledTimes(1)
        change(harness)
        paused.release()
        await pending

        expect(delivery.createObjectURL).not.toHaveBeenCalled()
        expect(delivery.click).not.toHaveBeenCalled()
        expect(delivery.share).not.toHaveBeenCalled()
        expect(delivery.clipboardWrite).not.toHaveBeenCalled()
        expect(harness.toast.success).not.toHaveBeenCalled()
      },
    )

    it('still delivers across view-only changes and a late manifest seal', async () => {
      const delivery = stubDelivery()
      const paused = createPausedOutput()
      const harness = setup({
        result: (session) => createResult({ session, output: paused.output }),
      })

      const pending = run(harness, action)
      withSession(harness, (session) => ({
        ...session,
        viewState: { ...session.viewState, compareSplit: 0.2, zoom: 3 },
        exportState: {
          ...session.exportState,
          result: { ...harness.stored, manifestState: { status: 'ready' } },
        },
      }))
      // Fields the color graph never reads, such as a view left on an old
      // record, are not part of the request.
      harness.setIntent({
        ...intent,
        viewMode: 'split',
        compareSplit: 0.2,
      } as unknown as ColorGraphIntent)
      harness.setLut(makeLut())
      paused.release()
      await pending

      expect(
        delivery.click.mock.calls.length +
          delivery.share.mock.calls.length +
          delivery.clipboardWrite.mock.calls.length,
      ).toBe(1)
      expect(harness.toast.error).not.toHaveBeenCalled()
    })

    it('refuses a result while a later attempt already holds the slot', async () => {
      const delivery = stubDelivery()
      const paused = createPausedOutput()
      const harness = setup({
        result: (session) => createResult({ session, output: paused.output }),
      })
      // The later attempt has claimed the slot but not yet cleared the
      // result, as while it samples the device before it plans.
      claimExportSlot(
        harness.exportAbortControllerRef,
        new AbortController(),
        'attempt-2',
      )

      await run(harness, action)

      expect(paused.openBlob).not.toHaveBeenCalled()
      expect(delivery.createObjectURL).not.toHaveBeenCalled()
      expect(delivery.click).not.toHaveBeenCalled()
      expect(delivery.share).not.toHaveBeenCalled()
      expect(delivery.clipboardWrite).not.toHaveBeenCalled()
      expect(harness.toast.error).toHaveBeenCalledTimes(1)
    })

    it('delivers while the attempt that produced it still holds the slot', async () => {
      const delivery = stubDelivery()
      const harness = setup({
        result: (session) => createResult({ session, output: blobOutput() }),
      })
      claimExportSlot(
        harness.exportAbortControllerRef,
        new AbortController(),
        'attempt-1',
      )

      await run(harness, action)

      expect(
        delivery.click.mock.calls.length +
          delivery.share.mock.calls.length +
          delivery.clipboardWrite.mock.calls.length,
      ).toBe(1)
      expect(harness.toast.error).not.toHaveBeenCalled()
    })

    it('refuses a result that does not record its request', async () => {
      const delivery = stubDelivery()
      const paused = createPausedOutput()
      const harness = setup({
        result: (session) => createResult({ session, output: paused.output }),
      })
      // Strip the identity to simulate a malformed result
      const malformed = harness.getSession()!.exportState.result!
      const { identity: _identity, ...unidentified } = malformed
      withResult(harness, unidentified as unknown as ExportResult)

      await run(harness, action)

      expect(paused.openBlob).not.toHaveBeenCalled()
      expect(delivery.click).not.toHaveBeenCalled()
      expect(delivery.share).not.toHaveBeenCalled()
      expect(delivery.clipboardWrite).not.toHaveBeenCalled()
      expect(harness.toast.error).toHaveBeenCalledTimes(1)
    })
  })

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

  it('does not copy a preview snapshot replaced while it encodes', async () => {
    const { clipboardWrite } = stubDelivery()
    const encoded = deferred<Blob | null>()
    const snapshot = {
      toBlob: vi.fn((callback: BlobCallback) => {
        void encoded.promise.then(callback)
      }),
    } as unknown as HTMLCanvasElement
    const harness = setup({
      previewCopyCanvas: snapshot,
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
    harness.previewCopyCanvasRef.current = null
    encoded.resolve(new Blob(['png'], { type: 'image/png' }))
    await pending

    expect(clipboardWrite).not.toHaveBeenCalled()
    expect(harness.toast.success).not.toHaveBeenCalled()
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

  it('delivers a current result after export released the preview', async () => {
    const delivery = stubDelivery()
    const snapshot = {
      toBlob: vi.fn((callback: BlobCallback) => {
        callback(new Blob(['png'], { type: 'image/png' }))
      }),
    } as unknown as HTMLCanvasElement
    const harness = setup({
      previewCopyCanvas: snapshot,
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
    await harness.actions().copyExportResult()

    expect(delivery.click).toHaveBeenCalledTimes(1)
    expect(delivery.share).toHaveBeenCalledTimes(1)
    expect(delivery.clipboardWrite).toHaveBeenCalledTimes(1)
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

  it('shows a copy or share refusal in the current locale', async () => {
    localStorage.setItem('lumaforge.locale', 'zh-CN')
    const harness = refuseCopyAndShare(I18nProvider)

    await harness.actions().copyExportResult()
    await harness.actions().shareExportResult()

    expect(harness.toast.error.mock.calls).toEqual([
      ['复制失败', { description: '此浏览器不支持复制图像到剪贴板。' }],
      ['分享失败', { description: '此浏览器无法分享 JPEG 文件。' }],
    ])
  })

  it('shows a preview copy that is not ready in the current locale', async () => {
    localStorage.setItem('lumaforge.locale', 'zh-CN')
    stubDelivery()
    const harness = setup({
      wrapper: I18nProvider,
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

    expect(harness.toast.error).toHaveBeenCalledWith('复制失败', {
      description: '预览图像尚未就绪，无法复制。',
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
      // A browser that cannot encode the snapshot hands `toBlob` no blob.
      const snapshot = {
        toBlob: vi.fn((callback: BlobCallback) => {
          callback(encodes ? new Blob(['png'], { type: 'image/png' }) : null)
        }),
      } as unknown as HTMLCanvasElement
      const harness = setup({
        wrapper,
        previewCopyCanvas: snapshot,
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
  const STALE_ZH = '此导出已与照片不一致。请重新导出后再交付。'

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

  it('shows every notification in the current locale and runtime detail as given', async () => {
    localStorage.setItem('lumaforge.locale', 'zh-CN')

    expect(await notifyAll(I18nProvider)).toEqual({
      'full-resolution copy': [['success', '已复制全分辨率图像']],
      'HQ preview copy': [['success', '已复制 HQ 预览图像']],
      'preview-size copy': [['success', '已复制预览尺寸图像']],
      'preview-size copy the browser cannot encode': [
        ['error', '复制失败', { description: '预览图像复制失败。' }],
      ],
      'download failure': [
        ['error', '下载失败', { description: 'Object URL quota exceeded' }],
      ],
      'download failure without a message': [
        ['error', '下载失败', { description: '下载操作失败。' }],
      ],
      'manifest failure without a message': [
        ['error', '清单下载失败', { description: '清单下载失败。' }],
      ],
      'share failure without a message': [
        ['error', '分享失败', { description: '分享操作失败。' }],
      ],
      'copy failure without a message': [
        ['error', '复制失败', { description: '复制操作失败。' }],
      ],
      'stale download': [['error', '下载失败', { description: STALE_ZH }]],
      'stale manifest download': [
        ['error', '清单下载失败', { description: STALE_ZH }],
      ],
      'stale share': [['error', '分享失败', { description: STALE_ZH }]],
      'stale copy': [['error', '复制失败', { description: STALE_ZH }]],
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

  function setupFor(copyCapability: ExportCopyCapability) {
    const delivery = stubDelivery()
    let resolveWrite!: () => void
    let rejectWrite!: (reason: unknown) => void
    delivery.clipboardWrite.mockReturnValue(
      new Promise<void>((resolve, reject) => {
        resolveWrite = resolve
        rejectWrite = reject
      }),
    )
    const harness = setup({
      wrapper: I18nProvider,
      result: (session) =>
        createResult({ session, output: blobOutput(), copyCapability }),
    })
    return { harness, resolveWrite, rejectWrite }
  }

  it('confirms a copy in the locale current when it completes', async () => {
    const { harness, resolveWrite } = setupFor({ mode: 'full-resolution' })
    const pending = harness.actions().copyExportResult()
    await switchLocale('zh-CN')

    resolveWrite()
    await pending

    expect(harness.toast.success.mock.calls).toEqual([['已复制全分辨率图像']])
    expect(harness.toast.error).not.toHaveBeenCalled()
  })

  it('reports a failed copy in the locale current when it fails', async () => {
    const { harness, rejectWrite } = setupFor({ mode: 'full-resolution' })
    const pending = harness.actions().copyExportResult()
    await switchLocale('zh-CN')

    rejectWrite('denied')
    await pending

    expect(harness.toast.error.mock.calls).toEqual([
      ['复制失败', { description: '复制操作失败。' }],
    ])
  })

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

  it('refuses a copy the browser cannot encode in the locale current when it fails', async () => {
    stubDelivery()
    let encode!: BlobCallback
    const snapshot = {
      toBlob: vi.fn((callback: BlobCallback) => {
        encode = callback
      }),
    } as unknown as HTMLCanvasElement
    const harness = setup({
      wrapper: I18nProvider,
      previewCopyCanvas: snapshot,
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
    await switchLocale('zh-CN')

    encode(null)
    await pending

    expect(harness.toast.error.mock.calls).toEqual([
      ['复制失败', { description: '预览图像复制失败。' }],
    ])
  })
})
