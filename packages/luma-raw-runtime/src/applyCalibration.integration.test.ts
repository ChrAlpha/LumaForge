/// <reference types="node" />

import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadNativeModuleForNode } from '@lumaforge/luma-native-artifacts/load-for-node'
import { beforeAll, describe, expect, it } from 'vitest'

interface NativeImage {
  data: Uint16Array
  width: number
  height: number
}

interface NativeProcessor {
  loadBuffer: (data: Uint8Array) => unknown
  openWithSettings: (settings: unknown) => unknown
  applyCalibration: (params: {
    xyzToCamera: number[]
    toneCurveLut?: number[]
  }) => void
  decodeHq: (options?: { maxOutputPixels?: number } | undefined) => NativeImage
  readMetadata: () => Record<string, unknown>
  delete?: () => void
}

interface NativeModule {
  LumaRawProcessor: new () => NativeProcessor
}

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// The CI native job builds into dist/native; the test runs those artifacts.
const nativeDir = join(packageDir, 'dist', 'native')
const nativeJsPath = join(nativeDir, 'desktop', 'luma_raw.js')
const nativeWasmPath = join(nativeDir, 'desktop', 'luma_raw.wasm')
const publicRawFixturePath = join(
  packageDir,
  'fixtures',
  '.cache',
  'public',
  'raw-pixls-iphone-se.dng',
)

const artifactsAvailable =
  existsSync(nativeJsPath) &&
  existsSync(nativeWasmPath) &&
  existsSync(publicRawFixturePath)
const skipReason = artifactsAvailable
  ? ''
  : 'native artifacts or public RAW fixture missing — run pnpm build:native:desktop and pnpm fixtures:fetch-public'

// Strict-export settings matching applyStrictExportProcessingSettings in
// libraw_wrapper.cpp. applyCalibration() requires use_camera_matrix=1 to
// route LibRaw through the convert_to_rgb branch that consumes the injected
// rgb_cam (the spike audit verified this).
const strictExportSettings = {
  halfSize: false,
  useCameraWb: true,
  useAutoWb: false,
  outputColor: 4,
  outputBps: 16,
  noAutoBright: true,
  useCameraMatrix: 1,
  bright: 1,
  highlight: 2,
  userQual: 0,
  gamm: [1, 1, 1, 1, 0, 0],
}

// Two distinct, well-conditioned XYZ-to-Camera 3x3 matrices (row-major). A
// is an Adobe-like Bayer DCP first-illuminant matrix; B is the same scene
// with channels permuted to guarantee a very different rgb_cam. Same numerics
// the spike used so the L2 floor stays meaningful.
const MATRIX_A = [0.7, 0.2, 0.1, 0.3, 0.85, -0.15, -0.05, 0.1, 0.95]
const MATRIX_B = [0.4, 0.5, 0.1, 0.1, 0.6, 0.3, 0.05, 0.25, 0.7]

async function loadNativeModule(): Promise<NativeModule> {
  return (await loadNativeModuleForNode({
    kind: 'raw',
    nativeDir,
  })) as unknown as NativeModule
}

function l2Distance(a: Uint16Array, b: Uint16Array): number {
  if (a.length !== b.length) {
    throw new Error(`length mismatch: ${a.length} vs ${b.length}`)
  }
  let sum = 0
  for (let i = 0; i < a.length; ++i) {
    const d = a[i] - b[i]
    sum += d * d
  }
  return Math.sqrt(sum)
}

function bytesEqual(a: Uint16Array, b: Uint16Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; ++i) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function rethrowEmscriptenException(error: unknown, label: string): never {
  // Emscripten C++ exceptions surface as { excPtr, constructor, stacks }
  // without an immediate message; pull the formatted message off the native
  // exception table so a failing assertion shows useful detail rather than
  // an opaque pointer.
  const exception = error as
    | { excPtr?: number; constructor?: { name?: string }; message?: string }
    | undefined
  if (exception?.excPtr !== undefined) {
    const native = globalThis as unknown as {
      Module?: { getExceptionMessage?: (ptr: number) => unknown }
    }
    const message = native.Module?.getExceptionMessage?.(exception.excPtr)
    throw new Error(
      `${label} native exception (excPtr=${exception.excPtr}): ${JSON.stringify(message) ?? exception.constructor?.name}`,
    )
  }
  throw error
}

function decodeWithMatrix(
  processor: NativeProcessor,
  rawBytes: Uint8Array,
  matrix: number[],
  toneCurveLut?: number[],
) {
  // Re-open every pass so successive calls start from clean
  // metadata-derived state and the result is deterministic — matches the
  // spike harness so the L2 numbers are directly comparable.
  try {
    processor.loadBuffer(rawBytes)
    processor.openWithSettings(strictExportSettings)
  } catch (error) {
    rethrowEmscriptenException(error, 'open')
  }
  try {
    processor.applyCalibration(
      toneCurveLut
        ? { xyzToCamera: matrix, toneCurveLut }
        : { xyzToCamera: matrix },
    )
  } catch (error) {
    rethrowEmscriptenException(error, 'applyCalibration')
  }
  try {
    // Omit maxOutputPixels so the wrapper returns the full processed image
    // (the iPhone SE DNG is 4032x3024 = ~12MP, well under any practical cap
    // and matching what the spike audit reported as L2 baseline).
    return processor.decodeHq()
  } catch (error) {
    rethrowEmscriptenException(error, 'decodeHq')
  }
}

describe.skipIf(!artifactsAvailable)(
  'native applyCalibration integration',
  () => {
    let modulePromise: Promise<NativeModule>
    let rawBytes: Uint8Array

    beforeAll(async () => {
      if (!artifactsAvailable) return
      await Promise.all([
        stat(nativeJsPath),
        stat(nativeWasmPath),
        stat(publicRawFixturePath),
      ])
      rawBytes = new Uint8Array(await readFile(publicRawFixturePath))
      modulePromise = loadNativeModule()
    }, 60_000)

    it('matrix A and matrix B produce different RGB output (gate 1)', async () => {
      if (!artifactsAvailable) {
        console.warn(skipReason)
        return
      }

      const module = await modulePromise
      const processor = new module.LumaRawProcessor()

      try {
        const a = decodeWithMatrix(processor, rawBytes, MATRIX_A)
        const b = decodeWithMatrix(processor, rawBytes, MATRIX_B)

        expect(a.width).toBe(b.width)
        expect(a.height).toBe(b.height)

        const ab = l2Distance(a.data, b.data)
        // eslint-disable-next-line no-console
        console.log(
          `[applyCalibration] L2(A,B) = ${ab.toFixed(2)} over ${a.data.length} samples (${a.width}x${a.height})`,
        )
        // Threshold matches the spike: a 3x3 permutation that touches all
        // channels yields L2 in the millions over a multi-megapixel
        // 16-bit RGB frame; conservative floor of 1_000 clears noise but
        // flags identical outputs hard.
        expect(ab).toBeGreaterThan(1_000)
      } finally {
        processor.delete?.()
      }
    }, 180_000)

    it('the same matrix re-applied produces bit-identical output (gate 2)', async () => {
      if (!artifactsAvailable) {
        console.warn(skipReason)
        return
      }

      const module = await modulePromise
      const processor = new module.LumaRawProcessor()

      try {
        const a1 = decodeWithMatrix(processor, rawBytes, MATRIX_A)
        // Run B in between so we know the matrix actually changed state
        // and the second A re-establishes it.
        decodeWithMatrix(processor, rawBytes, MATRIX_B)
        const a2 = decodeWithMatrix(processor, rawBytes, MATRIX_A)

        const aa = l2Distance(a1.data, a2.data)
        // eslint-disable-next-line no-console
        console.log(`[applyCalibration] L2(A,A') = ${aa}`)
        expect(aa).toBe(0)
        expect(bytesEqual(a1.data, a2.data)).toBe(true)
      } finally {
        processor.delete?.()
      }
    }, 180_000)

    it('accepts a tone-curve LUT through the protocol without rejecting (gate 3, deferred apply)', async () => {
      if (!artifactsAvailable) {
        console.warn(skipReason)
        return
      }

      const module = await modulePromise
      const processor = new module.LumaRawProcessor()

      try {
        // The tone-curve LUT path is accepted by the native wrapper but
        // not yet applied as a post-process pass (PHASE 1 LIMITATION
        // documented in applyCalibration). Decode output must therefore
        // match the matrix-only result for the same XYZ-to-Camera matrix.
        // When phase 2 lands the per-pixel LUT pass, this assertion
        // flips to "differs from matrix-only by > epsilon".
        const lut = Array.from(
          { length: 4096 },
          (_, index) =>
            // Identity ramp — even if the LUT were applied it would be a
            // no-op, so this test does not block on the deferred behavior.
            index / (4096 - 1),
        )

        const matrixOnly = decodeWithMatrix(processor, rawBytes, MATRIX_A)
        const withCurve = decodeWithMatrix(processor, rawBytes, MATRIX_A, lut)

        expect(matrixOnly.width).toBe(withCurve.width)
        expect(matrixOnly.height).toBe(withCurve.height)
        // Phase 1: LUT is stashed, never applied; output is identical.
        const equal = bytesEqual(matrixOnly.data, withCurve.data)
        // eslint-disable-next-line no-console
        console.log(
          `[applyCalibration] tone-curve LUT accepted: outputs bytes-equal = ${equal}`,
        )
        expect(equal).toBe(true)
      } finally {
        processor.delete?.()
      }
    }, 180_000)
  },
)
