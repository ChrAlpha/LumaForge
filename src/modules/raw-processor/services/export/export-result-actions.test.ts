import type { ColorGraphIntent, LUTData } from '@lumaforge/luma-color-runtime'
import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import type {
  ExportOutputResult,
  FileBackedOutputResult,
} from '@lumaforge/render-engine/export'
import { createBlobOutputResult } from '@lumaforge/render-engine/export'
import type { RenderManifest } from '@lumaforge/render-engine/manifest'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import { createMemoryFileBackedOutputResult } from '~/lib/export/output-sink'

import type { ExportResult, ExportResultKind } from '../../model/export-result'
import { createExportResult } from '../../model/export-result'
import type { ImageSession } from '../../model/session'
import { createImageSession } from '../../model/session-factory'
import type {
  ExportDeliveryGuard,
  ExportDeliveryLiveState,
  ExportDeliveryRefusal,
} from './export-result-actions'
import {
  checkExportDelivery,
  copyCanvasToClipboard,
  copyExportResultToClipboard,
  downloadExportManifest,
  downloadExportResult,
  ExportActionUnavailableError,
  ExportDeliveryStaleError,
  openExportDelivery,
  resolveExportCopyCapability,
  resolveExportShareButtonCapability,
  resolveExportShareCapability,
  shareExportResult,
  unavailableExportCopy,
  unavailableExportShare,
} from './export-result-actions'
import { captureExportResultIdentity } from './export-result-identity'
import { claimExportSlot, readExportSlotAttempt } from './export-state'

function createResult({
  output = createBlobOutputResult({
    blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    filename: 'frame_neutral_fullres.jpg',
  }),
}: {
  output?: ExportOutputResult
} = {}) {
  return createExportResult({
    output,
    filename: 'frame_neutral_fullres.jpg',
    width: 6048,
    height: 4024,
    now: () => 123,
    copyCapability: {
      mode: 'full-resolution',
    },
  })
}

function createClipboardItem(items: Record<string, Blob>): ClipboardItem {
  return {
    presentationStyle: 'unspecified',
    types: Object.keys(items),
    getType: vi.fn(async (type: string) => {
      const blob = items[type]
      if (!blob) {
        throw new Error(`Clipboard item does not include ${type}.`)
      }

      return blob
    }),
  }
}

function createClipboardItemMock(supports: (type: string) => boolean) {
  const ClipboardItemMock = Object.assign(
    vi.fn((items: Record<string, Blob>): ClipboardItem => {
      return createClipboardItem(items)
    }),
    { supports: vi.fn(supports) },
  )

  return ClipboardItemMock as typeof ClipboardItemMock & {
    new (items: Record<string, Blob>): ClipboardItem
  }
}

describe('export result actions', () => {
  it('checks delivery against the complete live color intent', () => {
    expectTypeOf<
      ExportDeliveryLiveState['intent']
    >().toEqualTypeOf<ColorGraphIntent>()
  })

  it('creates a blob-backed export result without eagerly constructing a share file', () => {
    const OriginalFile = File
    const fileConstructions: Array<{
      parts: BlobPart[]
      filename: string
    }> = []

    class InstrumentedFile extends OriginalFile {
      constructor(
        parts: BlobPart[],
        filename: string,
        options?: FilePropertyBag,
      ) {
        fileConstructions.push({ parts, filename })
        super(parts, filename, options)
      }
    }

    vi.stubGlobal('File', InstrumentedFile)

    try {
      const result = createResult()

      expect(result.filename).toBe('frame_neutral_fullres.jpg')
      expect(result.width).toBe(6048)
      expect(result.height).toBe(4024)
      expect(result.size).toBe(4)
      expect(result.createdAt).toBe(123)
      expect(result.output.kind).toBe('blob')
      expect('blob' in result).toBe(false)
      expect('file' in result).toBe(false)
      expect(fileConstructions).toHaveLength(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('downloads the stored full-resolution blob only when the action is called', async () => {
    vi.useFakeTimers()
    const result = createResult()
    const click = vi.fn()
    const remove = vi.fn()
    const append = vi.fn()
    const link = { href: '', download: '', click, remove }
    const documentLike = {
      createElement: vi.fn(() => link),
      body: { append },
    } as unknown as Document
    const urlLike = {
      createObjectURL: vi.fn(() => 'blob:export'),
      revokeObjectURL: vi.fn(),
    } as unknown as typeof URL

    try {
      await downloadExportResult(result, {
        document: documentLike,
        URL: urlLike,
      })

      if (result.output.kind !== 'blob') {
        throw new Error('expected blob-backed result')
      }
      expect(urlLike.createObjectURL).toHaveBeenCalledWith(result.output.blob)
      expect(link.href).toBe('blob:export')
      expect(link.download).toBe('frame_neutral_fullres.jpg')
      expect(append).toHaveBeenCalledWith(link)
      expect(click).toHaveBeenCalledTimes(1)
      expect(remove).toHaveBeenCalledTimes(1)
      expect(urlLike.revokeObjectURL).not.toHaveBeenCalled()

      vi.runOnlyPendingTimers()

      expect(urlLike.revokeObjectURL).toHaveBeenCalledWith('blob:export')
    } finally {
      vi.useRealTimers()
    }
  })

  it('downloads the sealed manifest as JSON named after the JPEG', async () => {
    vi.useFakeTimers()
    const manifest = {
      manifest_version: 1,
      kind: 'export',
      manifest_sha256: 'a'.repeat(64),
    } as unknown as RenderManifest
    const result = { ...createResult(), manifest }
    const click = vi.fn()
    const remove = vi.fn()
    const append = vi.fn()
    const link = { href: '', download: '', click, remove }
    const documentLike = {
      createElement: vi.fn(() => link),
      body: { append },
    } as unknown as Document
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:manifest')
    const urlLike = {
      createObjectURL,
      revokeObjectURL: vi.fn(),
    } as unknown as typeof URL
    const onMaterialize = vi.fn()

    try {
      await downloadExportManifest(result, {
        document: documentLike,
        URL: urlLike,
        onMaterialize,
      })

      const blob = createObjectURL.mock.calls[0]?.[0] as Blob | undefined
      expect(blob?.type).toBe('application/json')
      expect(blob?.size).toBe(JSON.stringify(manifest, null, 2).length)
      expect(link.download).toBe('frame_neutral_fullres.manifest.json')
      expect(click).toHaveBeenCalledTimes(1)
      expect(onMaterialize).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'manifest' }),
      )

      vi.runOnlyPendingTimers()

      expect(urlLike.revokeObjectURL).toHaveBeenCalledWith('blob:manifest')
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses to download a manifest that was never attached', async () => {
    await expect(downloadExportManifest(createResult())).rejects.toThrow(
      'EXPORT_MANIFEST_UNAVAILABLE',
    )
  })

  it('reports file-backed output materialization only inside user actions', async () => {
    vi.useFakeTimers()
    try {
      const openBlob = vi.fn(
        async () => new Blob(['jpeg-with-exif'], { type: 'image/jpeg' }),
      )
      const onMaterialize = vi.fn()
      const result = createResult({
        output: {
          kind: 'file-backed',
          exportId: 'export-1',
          filename: 'frame_neutral_fullres.jpg',
          byteLength: 4,
          mimeType: 'image/jpeg',
          openBlob,
        },
      })
      const click = vi.fn()
      const remove = vi.fn()
      const append = vi.fn()
      const link = { href: '', download: '', click, remove }
      const documentLike = {
        createElement: vi.fn(() => link),
        body: { append },
      } as unknown as Document
      const urlLike = {
        createObjectURL: vi.fn(() => 'blob:export'),
        revokeObjectURL: vi.fn(),
      } as unknown as typeof URL

      expect(openBlob).not.toHaveBeenCalled()

      await downloadExportResult(result, {
        document: documentLike,
        URL: urlLike,
        onMaterialize,
        now: () => '2026-05-03T00:00:00.000Z',
      })

      expect(openBlob).toHaveBeenCalledTimes(1)
      expect(onMaterialize).toHaveBeenCalledWith({
        action: 'download',
        outputKind: 'file-backed',
        filename: 'frame_neutral_fullres.jpg',
        byteLength: 14,
        materializedAt: '2026-05-03T00:00:00.000Z',
        cleanup: 'scheduled',
      })

      vi.runOnlyPendingTimers()
      expect(urlLike.revokeObjectURL).toHaveBeenCalledWith('blob:export')
    } finally {
      vi.useRealTimers()
    }
  })

  it('continues download when materialization diagnostics throws', async () => {
    vi.useFakeTimers()
    const result = createResult()
    const click = vi.fn()
    const remove = vi.fn()
    const append = vi.fn()
    const link = { href: '', download: '', click, remove }
    const documentLike = {
      createElement: vi.fn(() => link),
      body: { append },
    } as unknown as Document
    const urlLike = {
      createObjectURL: vi.fn(() => 'blob:export'),
      revokeObjectURL: vi.fn(),
    } as unknown as typeof URL

    try {
      await expect(
        downloadExportResult(result, {
          document: documentLike,
          URL: urlLike,
          onMaterialize: vi.fn(() => {
            throw new Error('diagnostics failed')
          }),
        }),
      ).resolves.toBeUndefined()

      expect(urlLike.createObjectURL).toHaveBeenCalledTimes(1)
      expect(click).toHaveBeenCalledTimes(1)
      vi.runOnlyPendingTimers()
      expect(urlLike.revokeObjectURL).toHaveBeenCalledWith('blob:export')
    } finally {
      vi.useRealTimers()
    }
  })

  it('continues share when materialization diagnostics throws', async () => {
    const result = createResult()
    const share = vi.fn().mockResolvedValue(undefined)
    const navigatorLike = {
      canShare: vi.fn((_data?: ShareData) => true),
      share,
    } as unknown as Navigator

    await expect(
      shareExportResult(result, navigatorLike, {
        onMaterialize: vi.fn(() => {
          throw new Error('diagnostics failed')
        }),
      }),
    ).resolves.toBeUndefined()

    expect(share).toHaveBeenCalledTimes(1)
  })

  it('continues copy when materialization diagnostics throws', async () => {
    const result = createResult()
    const write = vi.fn().mockResolvedValue(undefined)
    const ClipboardItemMock = createClipboardItemMock(() => false)
    const environment = {
      navigator: { clipboard: { write } },
      ClipboardItem: ClipboardItemMock,
    }

    await expect(
      copyExportResultToClipboard(result, environment, {
        onMaterialize: vi.fn(() => {
          throw new Error('diagnostics failed')
        }),
      }),
    ).resolves.toBeUndefined()

    expect(write).toHaveBeenCalledTimes(1)
  })

  it('does not materialize file-backed output while resolving share capability', () => {
    const openBlob = vi.fn(
      async () => new Blob(['jpeg'], { type: 'image/jpeg' }),
    )
    const result = createResult({
      output: {
        kind: 'file-backed',
        exportId: 'export-1',
        filename: 'frame_neutral_fullres.jpg',
        byteLength: 4,
        mimeType: 'image/jpeg',
        openBlob,
      },
    })
    const canShare = vi.fn((_data?: ShareData) => true)
    const navigatorLike = {
      canShare,
      share: vi.fn(),
    } as unknown as Navigator

    expect(resolveExportShareCapability(result, navigatorLike)).toEqual({
      available: true,
    })
    expect(openBlob).not.toHaveBeenCalled()
    const files = canShare.mock.calls[0]?.[0]?.files ?? []
    expect(files[0]).toBeInstanceOf(File)
    expect(files[0].size).toBe(0)
  })

  it('resolves the share button without constructing a probe file or calling canShare', () => {
    const OriginalFile = File
    const canShare = vi.fn((_data?: ShareData) => true)

    class InstrumentedFile extends OriginalFile {
      constructor(
        parts: BlobPart[],
        filename: string,
        options?: FilePropertyBag,
      ) {
        super(parts, filename, options)
        throw new Error('share button capability should not create a File')
      }
    }

    vi.stubGlobal('File', InstrumentedFile)

    try {
      expect(
        resolveExportShareButtonCapability({
          canShare,
          share: vi.fn(),
        } as unknown as Navigator),
      ).toEqual({ available: true })
      expect(canShare).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('enables share only when the browser can share the JPEG file', () => {
    const result = createResult()
    const canShare = vi.fn((_data?: ShareData) => true)
    const navigatorLike = {
      canShare,
      share: vi.fn(),
    } as unknown as Navigator

    expect(resolveExportShareCapability(result, navigatorLike)).toEqual({
      available: true,
    })
    const shareData = canShare.mock.calls[0]?.[0]
    expect(shareData).toBeDefined()
    const files = shareData?.files ?? []
    expect(files).toHaveLength(1)
    expect(files[0]).toBeInstanceOf(File)
    expect(files[0].name).toBe('frame_neutral_fullres.jpg')
    expect(files[0].type).toBe('image/jpeg')
    expect(files[0].size).toBe(0)
  })

  it('marks share unavailable when canShare exists but share is unsupported', () => {
    const result = createResult()
    const navigatorLike = {
      canShare: vi.fn(() => true),
    } as unknown as Navigator

    expect(resolveExportShareCapability(result, navigatorLike)).toEqual({
      available: false,
      reasonCode: 'share-unsupported',
    })
    expect(navigatorLike.canShare).not.toHaveBeenCalled()
  })

  it('marks share unavailable when file sharing is unsupported', () => {
    const result = createResult()
    const navigatorLike = {} as Navigator

    expect(resolveExportShareCapability(result, navigatorLike)).toEqual({
      available: false,
      reasonCode: 'share-unsupported',
    })
  })

  it('creates the full-resolution share file only from user action handlers', async () => {
    const result = createResult({
      output: createMemoryFileBackedOutputResult({
        exportId: 'export-1',
        filename: 'frame_neutral_fullres.jpg',
        mimeType: 'image/jpeg',
        bytes: new Uint8Array([1, 2, 3, 4]),
      }),
    })
    const canShare = vi.fn((_data?: ShareData) => true)
    const share = vi.fn().mockResolvedValue(undefined)
    const navigatorLike = {
      canShare,
      share,
    } as unknown as Navigator

    await shareExportResult(result, navigatorLike)

    const shareData = canShare.mock.calls[0]?.[0]
    expect(shareData).toBeDefined()
    const probeFiles = shareData?.files ?? []
    expect(probeFiles[0].size).toBe(0)

    const [{ files: sharedFiles, title }] = share.mock.calls[0]
    expect(title).toBe('frame_neutral_fullres.jpg')
    expect(sharedFiles).toHaveLength(1)
    expect(sharedFiles[0]).toBeInstanceOf(File)
    expect(sharedFiles[0].name).toBe('frame_neutral_fullres.jpg')
    expect(sharedFiles[0].type).toBe('image/jpeg')
    expect(sharedFiles[0].size).toBe(result.size)
    expect(share).toHaveBeenCalledWith({
      files: sharedFiles,
      title: 'frame_neutral_fullres.jpg',
    })
    expect(sharedFiles[0]).not.toBe((result as { file?: File }).file)
  })

  it('prefers full-resolution copy when JPEG clipboard write is supported', () => {
    const write = vi.fn()
    const ClipboardItemMock = createClipboardItemMock(
      (type) => type === 'image/jpeg',
    )
    const environment = {
      navigator: { clipboard: { write } },
      ClipboardItem: ClipboardItemMock,
    }

    expect(resolveExportCopyCapability(environment)).toEqual({
      mode: 'full-resolution',
    })
  })

  it('falls back to preview-size copy when JPEG clipboard write is unsupported but PNG clipboard write is available', () => {
    const write = vi.fn()
    const ClipboardItemMock = createClipboardItemMock(
      (type) => type === 'image/png',
    )
    const environment = {
      navigator: { clipboard: { write } },
      ClipboardItem: ClipboardItemMock,
    }

    expect(resolveExportCopyCapability(environment)).toEqual({
      mode: 'preview-size',
      reasonCode: 'full-resolution-copy-unsupported',
    })
  })

  it('marks copy unavailable without async clipboard write support', () => {
    expect(resolveExportCopyCapability({ navigator: {} })).toEqual({
      mode: 'unavailable',
      reasonCode: 'clipboard-unsupported',
    })
  })

  it('writes the full-resolution JPEG blob to clipboard when requested', async () => {
    const result = createResult()
    let clipboard: { write: (items: ClipboardItem[]) => Promise<void> }
    const write = vi.fn(function (
      this: unknown,
      _items: ClipboardItem[],
    ): Promise<void> {
      expect(this).toBe(clipboard)
      return Promise.resolve()
    })
    clipboard = { write }
    const ClipboardItemMock = createClipboardItemMock(() => false)
    const environment = {
      navigator: { clipboard },
      ClipboardItem: ClipboardItemMock,
    }

    await copyExportResultToClipboard(result, environment)

    if (result.output.kind !== 'blob') {
      throw new Error('expected blob-backed result')
    }
    expect(ClipboardItemMock).toHaveBeenCalledWith({
      'image/jpeg': result.output.blob,
    })
    expect(write).toHaveBeenCalledWith([
      ClipboardItemMock.mock.results[0].value,
    ])
  })

  it('writes a preview canvas as a PNG clipboard item', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const ClipboardItemMock = createClipboardItemMock(() => false)
    const pngBlob = new Blob(['png'], { type: 'image/png' })
    const canvas = {
      toBlob: vi.fn((callback: BlobCallback, type?: string) => {
        expect(type).toBe('image/png')
        callback(pngBlob)
      }),
    } as unknown as HTMLCanvasElement
    const environment = {
      navigator: { clipboard: { write } },
      ClipboardItem: ClipboardItemMock,
    }

    await copyCanvasToClipboard(canvas, environment)

    expect(canvas.toBlob).toHaveBeenCalledTimes(1)
    expect(ClipboardItemMock).toHaveBeenCalledWith({
      'image/png': pngBlob,
    })
    expect(write).toHaveBeenCalledWith([
      ClipboardItemMock.mock.results[0].value,
    ])
  })

  it('rejects preview canvas copy when canvas.toBlob returns null', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const ClipboardItemMock = createClipboardItemMock(() => false)
    const canvas = {
      toBlob: vi.fn((callback: BlobCallback) => {
        callback(null)
      }),
    } as unknown as HTMLCanvasElement
    const environment = {
      navigator: { clipboard: { write } },
      ClipboardItem: ClipboardItemMock,
    }

    await expect(copyCanvasToClipboard(canvas, environment)).rejects.toThrow(
      'Preview image copy failed.',
    )
    expect(ClipboardItemMock).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('names each copy and share refusal by its code alone', () => {
    expect(unavailableExportCopy('preview-copy-not-ready')).toEqual({
      mode: 'unavailable',
      reasonCode: 'preview-copy-not-ready',
    })
    expect(unavailableExportCopy('hq-preview-copy-unsupported')).toEqual({
      mode: 'unavailable',
      reasonCode: 'hq-preview-copy-unsupported',
    })
    expect(unavailableExportShare('no-result')).toEqual({
      available: false,
      reasonCode: 'no-result',
    })
    expect(resolveExportShareButtonCapability({} as Navigator)).toEqual({
      available: false,
      reasonCode: 'share-unsupported',
    })
    expect(unavailableExportCopy('clipboard-unsupported')).toEqual({
      mode: 'unavailable',
      reasonCode: 'clipboard-unsupported',
    })
  })

  it('fails an action the browser cannot carry out with its code', async () => {
    const share = shareExportResult(createResult(), {} as Navigator)
    await expect(share).rejects.toBeInstanceOf(ExportActionUnavailableError)
    await expect(share).rejects.toMatchObject({
      reasonCode: 'share-unsupported',
      message: 'share-unsupported',
    })

    const copy = copyExportResultToClipboard(createResult(), { navigator: {} })
    await expect(copy).rejects.toMatchObject({
      reasonCode: 'clipboard-unsupported',
      message: 'clipboard-unsupported',
    })
  })

  describe('delivery currency', () => {
    const sourceFile = new File(['raw'], 'frame.dng', { lastModified: 1_000 })
    const lutTable = new Float32Array(2 * 2 * 2 * 3).fill(0.5)
    const lut: LUTData = {
      size: 2,
      data: lutTable,
      domainMin: [0, 0, 0],
      domainMax: [1, 1, 1],
      title: 'Film',
      inputProfile: 'display-srgb',
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
    }
    const intent: ColorGraphIntent = {
      styleKind: 'custom',
      builtinPreset: null,
      intensity: 0.37,
      ...NEUTRAL_USER_COLOR_INTENT,
    }
    const geometry = {
      matrix: [0.999, -0.035, 0.018, 0.035, 0.999, -0.017, 0, 0, 1],
      constrainCrop: true,
    }

    function acceptedTransform(session: ImageSession) {
      const request = {
        captureKey: 'capture-1',
        requestId: 1,
        issued: 1,
        geometry,
      }
      return {
        ...session.transform!,
        intent: { ...session.transform!.intent, upright: 'auto' as const },
        capture: { key: 'capture-1', failed: false },
        issuedRequests: 1,
        request: { ...request, failure: null },
        accepted: request,
      }
    }

    function identified(
      session: ImageSession,
      kind: ExportResultKind,
      attemptId = 'attempt-1',
    ): ExportResult {
      return {
        ...createExportResult({
          output: createBlobOutputResult({
            blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
            filename: 'frame.jpg',
          }),
          kind,
          width: 800,
          height: 600,
          copyCapability: {
            mode: 'full-resolution',
          },
          identity: captureExportResultIdentity({
            resultKind: kind,
            attemptId,
            sessionId: session.id,
            sourceFile,
            intent,
            lut,
            rawRenderExposure: {
              ev: 0.5,
              multiplier: 2 ** 0.5,
              source: 'image-statistics',
            },
            geometry: session.exportGeometry ?? null,
          }),
        }),
      }
    }

    function live({
      kind = 'full-resolution',
      withGeometry = false,
    }: { kind?: ExportResultKind; withGeometry?: boolean } = {}) {
      const base = createImageSession(sourceFile)
      const session: ImageSession = withGeometry
        ? {
            ...base,
            exportGeometry: geometry,
            transform: acceptedTransform(base),
          }
        : base
      const result = identified(session, kind)
      const state: ExportDeliveryLiveState = {
        mounted: true,
        session: {
          ...session,
          exportState: { ...session.exportState, status: 'ready', result },
        },
        graphVersion: 7,
        exportAttempt: 'attempt-1',
        intent,
        lut,
      }
      return { state, result, session }
    }

    function withSession(
      state: ExportDeliveryLiveState,
      update: Partial<ImageSession>,
    ): ExportDeliveryLiveState {
      return {
        ...state,
        session: { ...state.session!, ...update } as ImageSession,
      }
    }

    it('opens a delivery of a current result, a Transform-applied one included', () => {
      for (const setup of [live(), live({ withGeometry: true })]) {
        const opened = openExportDelivery(setup.result, setup.state)
        expect(opened.kind).toBe('open')
        if (opened.kind !== 'open') continue
        expect(opened.ticket.identity).toBe(setup.result.identity)
        expect(checkExportDelivery(opened.ticket, setup.state)).toBeNull()
      }
    })

    it('refuses at the start what it cannot vouch for', () => {
      const { state, result, session } = live()
      const { identity: _identity, ...unidentified } = result
      const cases: Array<
        [ExportDeliveryRefusal, ExportResult, ExportDeliveryLiveState]
      > = [
        ['unidentified', unidentified, state],
        ['unidentified', { ...result, kind: 'hq-preview' }, state],
        ['unmounted', result, { ...state, mounted: false }],
        ['attempt-replaced', result, { ...state, exportAttempt: 'attempt-2' }],
        ['attempt-replaced', result, { ...state, exportAttempt: null }],
        [
          'result-replaced',
          result,
          withSession(state, {
            exportState: {
              ...state.session!.exportState,
              result: identified(session, 'full-resolution', 'attempt-2'),
            },
          }),
        ],
        [
          'transform-pending',
          result,
          withSession(state, {
            transform: {
              ...session.transform!,
              intent: { ...session.transform!.intent, upright: 'auto' },
            },
          }),
        ],
        [
          'input-changed',
          result,
          { ...state, intent: { ...intent, userTint: 4 } },
        ],
      ]
      for (const [refusal, candidate, candidateState] of cases) {
        expect(openExportDelivery(candidate, candidateState)).toEqual({
          kind: 'refused',
          refusal,
        })
      }
    })

    it('refuses an HQ preview result under any Transform, held geometry included', () => {
      const hq = live({ kind: 'hq-preview' })
      expect(openExportDelivery(hq.result, hq.state).kind).toBe('open')
      expect(
        openExportDelivery(
          hq.result,
          withSession(hq.state, { exportGeometry: geometry }),
        ),
      ).toEqual({ kind: 'refused', refusal: 'transform-pending' })
    })

    it('names what moved since the delivery opened', () => {
      const { state, result, session } = live({ withGeometry: true })
      const opened = openExportDelivery(result, state)
      if (opened.kind !== 'open') throw new Error('expected an open delivery')
      const { ticket } = opened
      const cases: Array<[ExportDeliveryRefusal, ExportDeliveryLiveState]> = [
        ['unmounted', { ...state, mounted: false }],
        ['graph-changed', { ...state, graphVersion: 8 }],
        ['attempt-replaced', { ...state, exportAttempt: 'attempt-2' }],
        ['attempt-replaced', { ...state, exportAttempt: null }],
        ['session-changed', { ...state, session: null }],
        ['session-changed', withSession(state, { id: 'session-2' })],
        [
          'session-changed',
          withSession(state, {
            sourceFile: { ...session.sourceFile, file: undefined },
          }),
        ],
        [
          'result-replaced',
          withSession(state, {
            exportState: { ...state.session!.exportState, result: undefined },
          }),
        ],
        [
          'transform-pending',
          withSession(state, {
            transform: { ...acceptedTransform(session), accepted: null },
          }),
        ],
        [
          'input-changed',
          withSession(state, {
            exportGeometry: { ...geometry, constrainCrop: false },
          }),
        ],
        ['input-changed', { ...state, intent: { ...intent, intensity: 0.4 } }],
        [
          'input-changed',
          { ...state, lut: { ...lut, data: lutTable.slice() } },
        ],
        ['input-changed', { ...state, lut: null }],
      ]
      for (const [refusal, moved] of cases) {
        expect(checkExportDelivery(ticket, moved)).toBe(refusal)
      }
    })

    it('stays current across view-only changes and a late seal', () => {
      const { state, result } = live()
      const opened = openExportDelivery(result, state)
      if (opened.kind !== 'open') throw new Error('expected an open delivery')

      const moved = withSession(state, {
        viewState: {
          ...state.session!.viewState,
          compareSplit: 0.1,
          zoom: 4,
          panX: 3,
          panY: -2,
          fitMode: 'custom',
        },
        exportState: {
          ...state.session!.exportState,
          result: { ...result, manifestState: { status: 'ready' } },
        },
      })
      expect(checkExportDelivery(opened.ticket, moved)).toBeNull()
    })

    describe('export slot attempts', () => {
      function deliverable(slot: { current: AbortController | null }) {
        const base = createImageSession(sourceFile)
        const result = createExportResult({
          output: createBlobOutputResult({
            blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
            filename: 'frame.jpg',
          }),
          kind: 'full-resolution',
          width: 800,
          height: 600,
          copyCapability: {
            mode: 'full-resolution',
          },
          identity: captureExportResultIdentity({
            resultKind: 'full-resolution',
            attemptId: 'attempt-a',
            sessionId: base.id,
            sourceFile,
            intent,
            lut,
            rawRenderExposure: null,
            geometry: null,
          }),
        })
        const readLive = (): ExportDeliveryLiveState => ({
          mounted: true,
          session: {
            ...base,
            exportState: { ...base.exportState, status: 'ready', result },
          },
          graphVersion: 1,
          exportAttempt: readExportSlotAttempt(slot),
          intent,
          lut,
        })
        return { result, readLive }
      }

      it('answers to the holder, and to the last claim once released', () => {
        const slot = { current: null as AbortController | null }
        expect(readExportSlotAttempt(slot)).toBeNull()
        const a = new AbortController()
        claimExportSlot(slot, a, 'attempt-a')
        expect(readExportSlotAttempt(slot)).toBe('attempt-a')
        slot.current = null
        expect(readExportSlotAttempt(slot)).toBe('attempt-a')
        claimExportSlot(slot, new AbortController(), 'attempt-b')
        slot.current = null
        expect(readExportSlotAttempt(slot)).toBe('attempt-b')
        slot.current = new AbortController()
        expect(readExportSlotAttempt(slot)).toBeNull()
      })

      it('delivers a result whose attempt released the slot as it ended', () => {
        const slot = { current: null as AbortController | null }
        claimExportSlot(slot, new AbortController(), 'attempt-a')
        slot.current = null
        const { result, readLive } = deliverable(slot)

        const opened = openExportDelivery(result, readLive())
        if (opened.kind !== 'open') throw new Error('expected an open delivery')
        expect(checkExportDelivery(opened.ticket, readLive())).toBeNull()
      })

      it('refuses a result once a later attempt holds the slot', () => {
        const slot = { current: null as AbortController | null }
        claimExportSlot(slot, new AbortController(), 'attempt-a')
        slot.current = null
        const { result, readLive } = deliverable(slot)
        // The later attempt has claimed the slot and is still sampling the
        // device, so the session still holds the earlier result.
        claimExportSlot(slot, new AbortController(), 'attempt-b')

        expect(openExportDelivery(result, readLive())).toEqual({
          kind: 'refused',
          refusal: 'attempt-replaced',
        })
      })

      it('refuses a result once a later attempt claimed and released the slot during delivery', () => {
        const slot = { current: null as AbortController | null }
        claimExportSlot(slot, new AbortController(), 'attempt-a')
        slot.current = null
        const { result, readLive } = deliverable(slot)
        const opened = openExportDelivery(result, readLive())
        if (opened.kind !== 'open') throw new Error('expected an open delivery')

        claimExportSlot(slot, new AbortController(), 'attempt-b')
        slot.current = null

        expect(checkExportDelivery(opened.ticket, readLive())).toBe(
          'attempt-replaced',
        )
      })
    })
  })

  describe('guarded delivery', () => {
    function pausedOutput() {
      let release!: () => void
      const opened = new Promise<Blob>((resolve) => {
        release = () => resolve(new Blob(['jpeg'], { type: 'image/jpeg' }))
      })
      const cleanup = vi.fn(async () => {})
      const output: FileBackedOutputResult = {
        kind: 'file-backed',
        exportId: 'export-1',
        filename: 'frame.jpg',
        byteLength: 4,
        mimeType: 'image/jpeg',
        openBlob: vi.fn(() => opened),
        cleanup,
      }
      return { output, cleanup, release: () => release() }
    }

    function flippableGuard() {
      let stale = false
      const guard: ExportDeliveryGuard = {
        assertCurrent() {
          if (stale) throw new ExportDeliveryStaleError('graph-changed')
        },
      }
      return { guard, goStale: () => (stale = true) }
    }

    it('downloads nothing when the result goes stale during materialization', async () => {
      const paused = pausedOutput()
      const { guard, goStale } = flippableGuard()
      const createObjectURL = vi.fn(() => 'blob:x')
      const revokeObjectURL = vi.fn()
      const click = vi.fn()
      const documentLike = {
        createElement: vi.fn(() => ({ click, remove: vi.fn() })),
        body: { append: vi.fn() },
      } as unknown as Document

      const pending = downloadExportResult(
        createResult({ output: paused.output }),
        {
          document: documentLike,
          URL: { createObjectURL, revokeObjectURL } as unknown as typeof URL,
          guard,
        },
      )
      goStale()
      paused.release()

      await expect(pending).rejects.toBeInstanceOf(ExportDeliveryStaleError)
      expect(createObjectURL).not.toHaveBeenCalled()
      expect(click).not.toHaveBeenCalled()
      // The stored output still belongs to its result; it is not deleted.
      expect(paused.cleanup).not.toHaveBeenCalled()
    })

    it('downloads nothing when the materialization diagnostics make the result stale', async () => {
      const paused = pausedOutput()
      const { guard, goStale } = flippableGuard()
      const createObjectURL = vi.fn(() => 'blob:x')
      const click = vi.fn()
      const documentLike = {
        createElement: vi.fn(() => ({ click, remove: vi.fn() })),
        body: { append: vi.fn() },
      } as unknown as Document
      const onMaterialize = vi.fn(() => {
        goStale()
      })

      const pending = downloadExportResult(
        createResult({ output: paused.output }),
        {
          document: documentLike,
          URL: {
            createObjectURL,
            revokeObjectURL: vi.fn(),
          } as unknown as typeof URL,
          guard,
          onMaterialize,
        },
      )
      paused.release()

      await expect(pending).rejects.toBeInstanceOf(ExportDeliveryStaleError)
      expect(onMaterialize).toHaveBeenCalledTimes(1)
      expect(createObjectURL).not.toHaveBeenCalled()
      expect(click).not.toHaveBeenCalled()
      expect(paused.cleanup).not.toHaveBeenCalled()
    })

    it('shares nothing when the result goes stale during materialization', async () => {
      const paused = pausedOutput()
      const { guard, goStale } = flippableGuard()
      const share = vi.fn().mockResolvedValue(undefined)
      const navigatorLike = {
        canShare: vi.fn(() => true),
        share,
      } as unknown as Navigator

      const pending = shareExportResult(
        createResult({ output: paused.output }),
        navigatorLike,
        undefined,
        guard,
      )
      goStale()
      paused.release()

      await expect(pending).rejects.toBeInstanceOf(ExportDeliveryStaleError)
      expect(share).not.toHaveBeenCalled()
      expect(paused.cleanup).not.toHaveBeenCalled()
    })

    it('copies nothing when the result goes stale during materialization', async () => {
      const paused = pausedOutput()
      const { guard, goStale } = flippableGuard()
      const write = vi.fn().mockResolvedValue(undefined)
      const ClipboardItem = createClipboardItemMock(() => true)

      const pending = copyExportResultToClipboard(
        createResult({ output: paused.output }),
        { navigator: { clipboard: { write } }, ClipboardItem },
        undefined,
        guard,
      )
      goStale()
      paused.release()

      await expect(pending).rejects.toBeInstanceOf(ExportDeliveryStaleError)
      expect(write).not.toHaveBeenCalled()
      expect(paused.cleanup).not.toHaveBeenCalled()
    })

    it('copies no canvas that went stale while it encoded', async () => {
      const { guard, goStale } = flippableGuard()
      const write = vi.fn().mockResolvedValue(undefined)
      const ClipboardItem = createClipboardItemMock(() => true)
      let encode!: () => void
      const canvas = {
        toBlob: vi.fn((callback: BlobCallback) => {
          encode = () => callback(new Blob(['png'], { type: 'image/png' }))
        }),
      } as unknown as HTMLCanvasElement

      const pending = copyCanvasToClipboard(
        canvas,
        { navigator: { clipboard: { write } }, ClipboardItem },
        guard,
      )
      goStale()
      encode()

      await expect(pending).rejects.toBeInstanceOf(ExportDeliveryStaleError)
      expect(write).not.toHaveBeenCalled()
    })

    it('downloads no manifest of a stale result', async () => {
      const { guard, goStale } = flippableGuard()
      const createObjectURL = vi.fn(() => 'blob:x')
      goStale()

      await expect(
        downloadExportManifest(
          {
            ...createResult(),
            manifest: { manifest_version: 1 } as unknown as RenderManifest,
          },
          {
            URL: {
              createObjectURL,
              revokeObjectURL: vi.fn(),
            } as unknown as typeof URL,
            guard,
          },
        ),
      ).rejects.toBeInstanceOf(ExportDeliveryStaleError)
      expect(createObjectURL).not.toHaveBeenCalled()
    })
  })
})
