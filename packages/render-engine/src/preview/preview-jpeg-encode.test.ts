/// <reference types="node" />
// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'

import { encodePreviewFrameToJpeg } from './preview-jpeg-encode'

describe('encodePreviewFrameToJpeg', () => {
  it('keeps the write failure when the awaited abort rejects too', async () => {
    const writeError = new Error('WRITE_FAILED')
    const abort = vi.fn(async () => {
      throw new Error('ABORT_FAILED')
    })
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      await expect(
        encodePreviewFrameToJpeg(
          () => ({
            writeRows: async () => {
              throw writeError
            },
            finish: async () => new Uint8Array(0),
            abort,
          }),
          { rgba: new Uint8Array(2 * 2 * 4), width: 2, height: 2 },
        ),
      ).rejects.toBe(writeError)
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      process.off('unhandledRejection', unhandled)
    }
    expect(abort).toHaveBeenCalledTimes(1)
    expect(unhandled).not.toHaveBeenCalled()
  })
})
