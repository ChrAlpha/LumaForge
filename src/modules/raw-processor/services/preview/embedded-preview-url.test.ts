import { describe, expect, it, vi } from 'vitest'

import type { ImageSession } from '../../model/session'
import { createTestSession } from '../../test-support/builders'
import {
  clearEmbeddedPreviewUrlFromSession,
  createEmbeddedPreviewObjectUrl,
  revokeEmbeddedPreviewObjectUrls,
} from './embedded-preview-url'

function createSession(
  embeddedPreview: ImageSession['previewBundle']['embeddedPreview'] = {
    status: 'ready',
    objectUrl: 'blob:embedded',
    width: 1600,
    height: 1200,
    mimeType: 'image/jpeg',
  },
  displaySource: ImageSession['previewBundle']['displaySource'] = 'embedded',
): ImageSession {
  return createTestSession({
    id: 'session-embedded-preview',
    previewBundle: { embeddedPreview, displaySource },
  })
}

describe('embedded preview URL lifecycle', () => {
  it('copies preview bytes into a fresh ArrayBuffer before creating the object URL', () => {
    const source = new Uint8Array([1, 2, 3, 4])
    const blobParts: BlobPart[][] = []
    class InstrumentedBlob extends Blob {
      constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
        blobParts.push(parts ?? [])
        super(parts, options)
      }
    }
    const createObjectURL = vi.fn(() => 'blob:embedded')

    const objectUrl = createEmbeddedPreviewObjectUrl(
      {
        data: source,
        mimeType: 'image/jpeg',
      },
      {
        Blob: InstrumentedBlob,
        URL: { createObjectURL },
      },
    )

    expect(objectUrl).toBe('blob:embedded')
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    expect(blobParts).toHaveLength(1)
    expect(blobParts[0]).toHaveLength(1)
    expect(blobParts[0]?.[0]).toBeInstanceOf(ArrayBuffer)
    expect(blobParts[0]?.[0]).not.toBe(source.buffer)
    expect(new Uint8Array(blobParts[0]?.[0] as ArrayBuffer)).toEqual(source)
  })

  it('revokes unique object URLs only once', () => {
    const revokeObjectURL = vi.fn()

    revokeEmbeddedPreviewObjectUrls(
      ['blob:first', 'blob:first', null, undefined, 'blob:second'],
      {
        URL: { revokeObjectURL },
      },
    )

    expect(revokeObjectURL).toHaveBeenCalledTimes(2)
    expect(revokeObjectURL).toHaveBeenNthCalledWith(1, 'blob:first')
    expect(revokeObjectURL).toHaveBeenNthCalledWith(2, 'blob:second')
  })

  it('clears embedded preview URL state and recomputes display source', () => {
    const session = createSession()

    const next = clearEmbeddedPreviewUrlFromSession(session)

    expect(next).not.toBe(session)
    expect(next.previewBundle.embeddedPreview).toEqual({ status: 'idle' })
    expect(next.previewBundle.displaySource).toBe('none')
  })

  it('keeps quick preview selected after clearing embedded preview URL state', () => {
    const session = createSession(
      {
        status: 'ready',
        objectUrl: 'blob:embedded',
        width: 1600,
        height: 1200,
        mimeType: 'image/jpeg',
      },
      'quick',
    )
    const quickReadySession: ImageSession = {
      ...session,
      previewBundle: {
        ...session.previewBundle,
        quickDecodePreview: {
          status: 'ready',
          width: 800,
          height: 600,
        },
      },
    }

    const next = clearEmbeddedPreviewUrlFromSession(quickReadySession)

    expect(next.previewBundle.embeddedPreview).toEqual({ status: 'idle' })
    expect(next.previewBundle.displaySource).toBe('quick')
  })

  it('returns the same session when no embedded object URL exists', () => {
    const session = createSession({ status: 'idle' }, 'none')

    expect(clearEmbeddedPreviewUrlFromSession(session)).toBe(session)
  })
})
