import type { RenderManifest } from '@lumaforge/render-engine/manifest'
import { describe, expect, it, vi } from 'vitest'

import type { ExportOutputResult } from '~/lib/export/output-sink'
import {
  createBlobOutputResult,
  createMemoryFileBackedOutputResult,
} from '~/lib/export/output-sink'

import { createExportResult } from '../../model/export-result'
import {
  copyCanvasToClipboard,
  copyExportResultToClipboard,
  downloadExportManifest,
  downloadExportResult,
  resolveExportCopyCapability,
  resolveExportShareButtonCapability,
  resolveExportShareCapability,
  shareExportResult,
} from './export-result-actions'

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
      label: 'Copy full-resolution image',
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
      reason: 'This browser cannot share JPEG files.',
    })
    expect(navigatorLike.canShare).not.toHaveBeenCalled()
  })

  it('marks share unavailable when file sharing is unsupported', () => {
    const result = createResult()
    const navigatorLike = {} as Navigator

    expect(resolveExportShareCapability(result, navigatorLike)).toEqual({
      available: false,
      reason: 'This browser cannot share JPEG files.',
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
      label: 'Copy full-resolution image',
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
      label: 'Copy preview-size image',
      reason: 'This browser cannot copy full-resolution JPEG files.',
    })
  })

  it('marks copy unavailable without async clipboard write support', () => {
    expect(resolveExportCopyCapability({ navigator: {} })).toEqual({
      mode: 'unavailable',
      reason: 'Clipboard image copy is not supported in this browser.',
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
})
