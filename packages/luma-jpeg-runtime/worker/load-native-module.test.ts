import {
  loadNativeJpegEncoderFactoryWithImporter,
  nativeJpegAssetUrl,
} from './load-native-module'
import type { NativeJpegModule } from './native-adapter'

class FakeNativeEncoder {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly quality: number,
  ) {}

  writeRows() {}

  finish() {
    return new Uint8Array()
  }

  drainChunks() {
    return []
  }

  abort() {}
}

describe('nativeJpegAssetUrl', () => {
  it('resolves native assets next to built worker assets', () => {
    expect(
      nativeJpegAssetUrl(
        'luma_jpeg.wasm',
        'https://example.test/assets/runtime.worker-abc123.js',
      ),
    ).toBe('https://example.test/native/luma_jpeg.wasm')
  })

  it('resolves native assets from package dist during direct worker tests', () => {
    expect(
      nativeJpegAssetUrl(
        'luma_jpeg.wasm',
        'https://example.test/worker/load-native-module.ts',
      ),
    ).toBe('https://example.test/dist/native/luma_jpeg.wasm')
  })
})

describe('loadNativeJpegEncoderFactoryWithImporter', () => {
  it('throws an unavailable error when the native module import fails', async () => {
    await expect(
      loadNativeJpegEncoderFactoryWithImporter(async () => {
        throw new Error('missing native asset')
      }, 'https://example.test/worker/load-native-module.ts'),
    ).rejects.toThrow('JPEG_NATIVE_RUNTIME_UNAVAILABLE')
  })

  it('throws an unavailable error when native module initialization fails', async () => {
    const initializationError = new Error('missing wasm asset')

    await expect(
      loadNativeJpegEncoderFactoryWithImporter(
        async () => ({
          default: async (options) => {
            expect(options?.locateFile?.('luma_jpeg.wasm')).toBe(
              'https://example.test/dist/native/luma_jpeg.wasm',
            )
            throw initializationError
          },
        }),
        'https://example.test/worker/load-native-module.ts',
      ),
    ).rejects.toMatchObject({
      message: 'JPEG_NATIVE_RUNTIME_UNAVAILABLE',
      cause: initializationError,
    })
  })

  it('passes the resolved wasm asset through locateFile', async () => {
    let locatedWasm = ''

    const factory = await loadNativeJpegEncoderFactoryWithImporter(
      async () => ({
        default: async (options) => {
          locatedWasm = options?.locateFile?.('luma_jpeg.wasm') ?? ''
          return {
            LumaJpegEncoder: FakeNativeEncoder,
          } satisfies NativeJpegModule
        },
      }),
      'https://example.test/worker/load-native-module.ts',
    )

    const encoder = factory({ width: 1, height: 1, quality: 0.92 })

    expect(locatedWasm).toBe('https://example.test/dist/native/luma_jpeg.wasm')
    await expect(encoder.finish()).resolves.toEqual([])
  })
})
