import { createNativeJpegEncoderFactory } from './native-adapter'

// Mirrors the native encoder: finish returns no bytes, and each call's
// output waits in drainChunks.
class FakeNativeEncoder {
  rows: Uint8Array[] = []
  aborted = false
  deleted = false
  private pending: Array<{
    bytes: Uint8Array
    byteOffset: number
    final: boolean
  }> = []
  private offset = 0

  constructor(
    readonly width: number,
    readonly height: number,
    readonly quality: number,
  ) {}

  private emit(bytes: number[], final: boolean) {
    this.pending.push({
      bytes: new Uint8Array(bytes),
      byteOffset: this.offset,
      final,
    })
    this.offset += bytes.length
  }

  writeRows(rows: Uint8Array, rowCount: number) {
    this.rows.push(new Uint8Array(rows))
    this.emit([rowCount], false)
    return rowCount
  }

  finish() {
    this.emit([255, 217], true)
    return new Uint8Array()
  }

  drainChunks() {
    return this.pending.splice(0)
  }

  abort() {
    this.aborted = true
  }

  delete() {
    this.deleted = true
  }
}

describe('createNativeJpegEncoderFactory', () => {
  it('returns the chunks each call drained and deletes the encoder after finish', async () => {
    let deleted = false
    const factory = createNativeJpegEncoderFactory({
      LumaJpegEncoder: class extends FakeNativeEncoder {
        delete() {
          deleted = true
          super.delete()
        }
      },
    })
    const encoder = factory({ width: 1, height: 2, quality: 0.92 })

    await expect(
      encoder.writeRows(new Uint8Array([255, 0, 0]), 1),
    ).resolves.toEqual([
      { bytes: new Uint8Array([1]), byteOffset: 0, final: false },
    ])
    await expect(encoder.finish()).resolves.toEqual([
      { bytes: new Uint8Array([255, 217]), byteOffset: 1, final: true },
    ])
    expect(deleted).toBe(true)
    await expect(
      encoder.writeRows(new Uint8Array([255, 0, 0]), 1),
    ).rejects.toThrow('JPEG_RUNTIME_FINISHED')
    await expect(encoder.finish()).rejects.toThrow('JPEG_RUNTIME_FINISHED')
  })

  it('streams the whole finish output of an artifact without drainChunks as one final chunk', async () => {
    const whole = new Uint8Array([255, 216, 255, 217])
    const factory = createNativeJpegEncoderFactory({
      LumaJpegEncoder: class {
        writeRows() {}
        finish() {
          return whole
        }
        abort() {}
      },
    })
    const encoder = factory({ width: 1, height: 1, quality: 0.92 })

    await expect(
      encoder.writeRows(new Uint8Array([255, 0, 0]), 1),
    ).resolves.toEqual([])
    await expect(encoder.finish()).resolves.toEqual([
      { bytes: whole, byteOffset: 0, final: true },
    ])
  })

  it('aborts the native encoder', async () => {
    let deleted = false
    const factory = createNativeJpegEncoderFactory({
      LumaJpegEncoder: class extends FakeNativeEncoder {
        delete() {
          deleted = true
          super.delete()
        }
      },
    })
    const encoder = factory({ width: 1, height: 1, quality: 0.92 })
    encoder.abort()
    expect(deleted).toBe(true)
    await expect(
      encoder.writeRows(new Uint8Array([0, 0, 0]), 1),
    ).rejects.toThrow('JPEG_RUNTIME_ABORTED')
  })

  it('normalizes native exception helper messages into errors', async () => {
    const nativeException = { excPtr: 1 }
    let decrementedException: unknown
    const factory = createNativeJpegEncoderFactory({
      LumaJpegEncoder: class extends FakeNativeEncoder {
        writeRows(): never {
          throw nativeException
        }
      },
      getExceptionMessage(error) {
        expect(error).toBe(nativeException)
        return ['std::runtime_error', 'JPEG_ROW_COUNT_EXCEEDED']
      },
      decrementExceptionRefcount(error) {
        decrementedException = error
      },
    })
    const encoder = factory({ width: 1, height: 1, quality: 0.92 })

    await expect(
      encoder.writeRows(new Uint8Array([0, 0, 0]), 1),
    ).rejects.toThrow('JPEG_ROW_COUNT_EXCEEDED')
    expect(decrementedException).toBe(nativeException)
  })

  it('normalizes native constructor exceptions', () => {
    const nativeException = { excPtr: 2 }
    let decrementedException: unknown
    const factory = createNativeJpegEncoderFactory({
      LumaJpegEncoder: class extends FakeNativeEncoder {
        constructor(width: number, height: number, quality: number) {
          super(width, height, quality)
          throw nativeException
        }
      },
      getExceptionMessage(error) {
        expect(error).toBe(nativeException)
        return ['std::runtime_error', 'JPEG_INVALID_DIMENSIONS']
      },
      decrementExceptionRefcount(error) {
        decrementedException = error
      },
    })

    expect(() => factory({ width: 1, height: 1, quality: 0.92 })).toThrow(
      'JPEG_INVALID_DIMENSIONS',
    )
    expect(decrementedException).toBe(nativeException)
  })

  it('deletes and marks the wrapper aborted when native writeRows fails', async () => {
    const nativeException = { excPtr: 3 }
    let deleted = false
    const factory = createNativeJpegEncoderFactory({
      LumaJpegEncoder: class extends FakeNativeEncoder {
        writeRows(): never {
          throw nativeException
        }

        delete() {
          deleted = true
          super.delete()
        }
      },
      getExceptionMessage() {
        return ['std::runtime_error', 'JPEG_ROW_COUNT_EXCEEDED']
      },
    })
    const encoder = factory({ width: 1, height: 1, quality: 0.92 })

    await expect(
      encoder.writeRows(new Uint8Array([0, 0, 0]), 1),
    ).rejects.toThrow('JPEG_ROW_COUNT_EXCEEDED')
    expect(deleted).toBe(true)
    await expect(
      encoder.writeRows(new Uint8Array([0, 0, 0]), 1),
    ).rejects.toThrow('JPEG_RUNTIME_ABORTED')
    await expect(encoder.finish()).rejects.toThrow('JPEG_RUNTIME_ABORTED')
  })

  it('deletes and marks the wrapper finished when native finish fails', async () => {
    const nativeException = { excPtr: 4 }
    let deleted = false
    const factory = createNativeJpegEncoderFactory({
      LumaJpegEncoder: class extends FakeNativeEncoder {
        finish(): never {
          throw nativeException
        }

        delete() {
          deleted = true
          super.delete()
        }
      },
      getExceptionMessage() {
        return ['std::runtime_error', 'JPEG_INCOMPLETE_IMAGE']
      },
    })
    const encoder = factory({ width: 1, height: 1, quality: 0.92 })

    await expect(encoder.finish()).rejects.toThrow('JPEG_INCOMPLETE_IMAGE')
    expect(deleted).toBe(true)
    await expect(
      encoder.writeRows(new Uint8Array([0, 0, 0]), 1),
    ).rejects.toThrow('JPEG_RUNTIME_FINISHED')
    await expect(encoder.finish()).rejects.toThrow('JPEG_RUNTIME_FINISHED')
  })

  it('deletes and normalizes when native abort fails', () => {
    const nativeException = { excPtr: 5 }
    let deleted = false
    const factory = createNativeJpegEncoderFactory({
      LumaJpegEncoder: class extends FakeNativeEncoder {
        abort() {
          throw nativeException
        }

        delete() {
          deleted = true
          super.delete()
        }
      },
      getExceptionMessage() {
        return ['std::runtime_error', 'JPEG_ABORT_FAILED']
      },
    })
    const encoder = factory({ width: 1, height: 1, quality: 0.92 })

    expect(() => encoder.abort()).toThrow('JPEG_ABORT_FAILED')
    expect(deleted).toBe(true)
  })
})
