import type { RenderManifest } from '@lumaforge/render-engine/manifest'
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ExportResult } from '../../../model/export-result'
import { useExportResultActions } from './useExportResultActions'

function createPreviewSizeResult(): ExportResult {
  return {
    kind: 'full-resolution',
    output: {
      kind: 'blob',
      filename: 'frame.jpg',
      byteLength: 4,
      mimeType: 'image/jpeg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    },
    filename: 'frame.jpg',
    width: 800,
    height: 600,
    size: 4,
    createdAt: 1,
    copyCapability: {
      mode: 'preview-size',
      label: 'Copy preview-size image',
      reason: 'JPEG clipboard unavailable.',
    },
  }
}

describe('useExportResultActions', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('copies preview-size exports from a rendered hidden canvas', async () => {
    const clipboardWrite = vi.fn().mockResolvedValue(undefined)
    class FakeClipboardItem {
      static supports(type: string) {
        return type === 'image/png'
      }

      constructor(public readonly items: Record<string, Blob>) {}
    }
    vi.stubGlobal('navigator', { clipboard: { write: clipboardWrite } })
    vi.stubGlobal('ClipboardItem', FakeClipboardItem)

    const fakeCanvas = {
      toBlob: vi.fn((callback: BlobCallback, type?: string) => {
        callback(new Blob(['png'], { type: type ?? 'image/png' }))
      }),
    } as unknown as HTMLCanvasElement
    const renderToHiddenCanvas = vi.fn().mockResolvedValue(fakeCanvas)
    const toastMessages: string[] = []

    const { result } = renderHook(() =>
      useExportResultActions({
        sessionRef: {
          current: {
            exportState: { result: createPreviewSizeResult() },
          },
        },
        pipelineRef: {
          current: { renderToHiddenCanvas },
        },
        previewCopyCanvasRef: { current: null },
        previewSize: { width: 640, height: 480 },
        scheduleToast: (notify) => {
          notify()
        },
        toast: {
          success: (message) => {
            toastMessages.push(message)
          },
          error: vi.fn(),
        },
      }),
    )

    await result.current.copyExportResult()

    expect(renderToHiddenCanvas).toHaveBeenCalledWith({
      width: 640,
      height: 480,
    })
    expect(fakeCanvas.toBlob).toHaveBeenCalledWith(
      expect.any(Function),
      'image/png',
    )
    expect(clipboardWrite).toHaveBeenCalledTimes(1)
    expect(toastMessages).toEqual(['Preview-size image copied'])
  })
  it('downloads the attached manifest and stays silent when none exists', async () => {
    const createObjectURL = vi.fn(() => 'blob:manifest')
    const revokeObjectURL = vi.fn()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.stubGlobal(
      'URL',
      Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }),
    )
    const manifest = {
      manifest_version: 1,
      kind: 'export',
      manifest_sha256: 'b'.repeat(64),
    } as unknown as RenderManifest
    const sessionRef = {
      current: {
        exportState: { result: createPreviewSizeResult() },
      },
    }
    const toastError = vi.fn()

    const { result } = renderHook(() =>
      useExportResultActions({
        sessionRef,
        pipelineRef: { current: null },
        previewCopyCanvasRef: { current: null },
        previewSize: { width: 640, height: 480 },
        scheduleToast: (notify) => {
          notify()
        },
        toast: { success: vi.fn(), error: toastError },
      }),
    )

    await result.current.downloadExportManifest()
    expect(createObjectURL).not.toHaveBeenCalled()

    sessionRef.current = {
      exportState: {
        result: { ...createPreviewSizeResult(), manifest },
      },
    }
    await result.current.downloadExportManifest()

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(toastError).not.toHaveBeenCalled()
  })
})
