import { mat3Identity } from '@lumaforge/luma-color-runtime'
import type {
  LumaRawExportCapability,
  LumaRawProcessedWindowRequest,
} from '@lumaforge/luma-raw-runtime'
import { describe, expect, it, vi } from 'vitest'

import { runFullResolutionJpegExport } from './full-res-export'
import {
  IDENTITY_RAW_RENDER_EXPOSURE_STEP,
  makeCapability,
  makeProcessedWindow,
  neutralToneSteps,
} from './full-res-export-test-fixtures'
import { createWasmJpegRowSink } from './jpeg/wasm-row-sink'

describe('runFullResolutionJpegExport', () => {
  it('throws FULL_RES_EXPORT_UNSUPPORTED_SOURCE before opening writer or reading windows', async () => {
    const readProcessedWindow = vi.fn()
    const createSession = vi.fn(() => ({
      writeRows: vi.fn(),
      close: vi.fn(),
      abort: vi.fn(),
    }))
    const jpegSink = {
      createSession,
    }

    await expect(
      runFullResolutionJpegExport({
        capability: makeCapability({ supported: false }),
        graph: {
          supported: true,
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          lutProfile: null,
          steps: [
            { kind: 'input-linear-prophoto' },
            IDENTITY_RAW_RENDER_EXPOSURE_STEP,
            ...neutralToneSteps(),
            { kind: 'output-srgb' },
          ],
        },
        readProcessedWindow,
        jpegSink,
      }),
    ).rejects.toThrow('FULL_RES_EXPORT_UNSUPPORTED_SOURCE')

    expect(readProcessedWindow).not.toHaveBeenCalled()
    expect(createSession).not.toHaveBeenCalled()
  })

  it.each([
    ['missing color facts', { color: undefined }],
    [
      'raw-mosaic strategy',
      {
        strategy: 'raw-mosaic-window',
        windows: { librawProcessed: false, rawMosaic: true },
      },
    ],
    [
      'missing processed windows',
      {
        windows: { librawProcessed: false, rawMosaic: true },
      },
    ],
    [
      'unsupported working space',
      {
        color: {
          whiteBalance: [1, 1, 1, 1],
          cameraToWorkingRgb: [1, 0, 0, 0, 1, 0, 0, 0, 1],
          workingSpace: 'display-srgb-preview',
        },
      },
    ],
    [
      'runtime camera white balance not applied',
      {
        color: {
          workingSpace: 'linear-prophoto-rgb',
          librawOutputColor: 'prophoto',
          gamma: 'linear',
          cameraWhiteBalanceAppliedByRuntime: false,
          cameraMatrixAppliedByRuntime: true,
        },
      },
    ],
    [
      'runtime camera matrix not applied',
      {
        color: {
          workingSpace: 'linear-prophoto-rgb',
          librawOutputColor: 'prophoto',
          gamma: 'linear',
          cameraWhiteBalanceAppliedByRuntime: true,
          cameraMatrixAppliedByRuntime: false,
        },
      },
    ],
  ] as Array<[string, Partial<LumaRawExportCapability>]>)(
    'fails closed before scheduling for %s',
    async (_name, overrides) => {
      const readProcessedWindow = vi.fn()
      const createSession = vi.fn(() => ({
        writeRows: vi.fn(),
        close: vi.fn(),
        abort: vi.fn(),
      }))

      await expect(
        runFullResolutionJpegExport({
          capability: makeCapability(overrides),
          graph: {
            supported: true,
            outputGamut: 'srgb-rec709',
            outputTransfer: 'srgb',
            lutProfile: null,
            steps: [
              { kind: 'input-linear-prophoto' },
              IDENTITY_RAW_RENDER_EXPOSURE_STEP,
              ...neutralToneSteps(),
              { kind: 'output-srgb' },
            ],
          },
          readProcessedWindow,
          jpegSink: {
            createSession,
          },
        }),
      ).rejects.toThrow('FULL_RES_EXPORT_UNSUPPORTED_SOURCE')

      expect(readProcessedWindow).not.toHaveBeenCalled()
      expect(createSession).not.toHaveBeenCalled()
    },
  )

  it.each([Infinity, -Infinity, Number.NaN, 0, -1])(
    'fails closed for invalid preferred row count %s before reading processed windows',
    async (preferredRows) => {
      const readProcessedWindow = vi.fn()
      const writer = {
        writeRows: vi.fn(),
        close: vi.fn(),
        abort: vi.fn(async () => undefined),
      }

      await expect(
        runFullResolutionJpegExport({
          capability: makeCapability(),
          graph: {
            supported: true,
            outputGamut: 'srgb-rec709',
            outputTransfer: 'srgb',
            lutProfile: null,
            steps: [
              { kind: 'input-linear-prophoto' },
              IDENTITY_RAW_RENDER_EXPOSURE_STEP,
              ...neutralToneSteps(),
              { kind: 'output-srgb' },
            ],
          },
          preferredRows,
          readProcessedWindow,
          writerFactory: () => writer,
        }),
      ).rejects.toThrow('FULL_RES_EXPORT_INVALID_PREFERRED_ROWS')

      expect(readProcessedWindow).not.toHaveBeenCalled()
      expect(writer.writeRows).not.toHaveBeenCalled()
      expect(writer.abort).not.toHaveBeenCalled()
    },
  )

  it.each([Infinity, -Infinity, Number.NaN, 0, -1])(
    'fails closed for invalid concurrency %s before reading processed windows',
    async (concurrency) => {
      const readProcessedWindow = vi.fn()
      const writer = {
        writeRows: vi.fn(),
        close: vi.fn(),
        abort: vi.fn(async () => undefined),
      }

      await expect(
        runFullResolutionJpegExport({
          capability: makeCapability(),
          graph: {
            supported: true,
            outputGamut: 'srgb-rec709',
            outputTransfer: 'srgb',
            lutProfile: null,
            steps: [
              { kind: 'input-linear-prophoto' },
              IDENTITY_RAW_RENDER_EXPOSURE_STEP,
              ...neutralToneSteps(),
              { kind: 'output-srgb' },
            ],
          },
          concurrency,
          readProcessedWindow,
          writerFactory: () => writer,
        }),
      ).rejects.toThrow('FULL_RES_EXPORT_INVALID_CONCURRENCY')

      expect(readProcessedWindow).not.toHaveBeenCalled()
      expect(writer.writeRows).not.toHaveBeenCalled()
      expect(writer.abort).not.toHaveBeenCalled()
    },
  )

  it('rejects processed windows whose rect does not match the requested output strip', async () => {
    const readProcessedWindow = vi.fn(
      (request: LumaRawProcessedWindowRequest) =>
        Promise.resolve(
          makeProcessedWindow({
            ...request,
            outputRect: { ...request.outputRect, y: request.outputRect.y + 1 },
          }),
        ),
    )
    const writer = {
      writeRows: vi.fn(),
      close: vi.fn(),
      abort: vi.fn(async () => undefined),
    }

    await expect(
      runFullResolutionJpegExport({
        capability: makeCapability(),
        graph: {
          supported: true,
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          lutProfile: null,
          steps: [
            { kind: 'input-linear-prophoto' },
            IDENTITY_RAW_RENDER_EXPOSURE_STEP,
            ...neutralToneSteps(),
            { kind: 'output-srgb' },
          ],
        },
        preferredRows: 2,
        readProcessedWindow,
        writerFactory: () => writer,
      }),
    ).rejects.toThrow('FULL_RES_EXPORT_INVALID_PROCESSED_WINDOW')

    expect(writer.writeRows).not.toHaveBeenCalled()
  })

  it('surfaces a browser-build error when JPEG runtime initialization fails', async () => {
    const readProcessedWindow = vi.fn()

    await expect(
      runFullResolutionJpegExport({
        capability: makeCapability(),
        graph: {
          supported: true,
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          lutProfile: null,
          steps: [
            { kind: 'input-linear-prophoto' },
            IDENTITY_RAW_RENDER_EXPOSURE_STEP,
            ...neutralToneSteps(),
            { kind: 'output-srgb' },
          ],
        },
        readProcessedWindow,
        jpegSink: createWasmJpegRowSink(() => {
          throw new Error('JPEG_RUNTIME_UNAVAILABLE')
        }),
      }),
    ).rejects.toMatchObject({
      message:
        'Full-resolution JPEG export is not available in this browser build.',
    })

    expect(readProcessedWindow).not.toHaveBeenCalled()
  })

  it('aborts the writer if strip export fails after writer creation', async () => {
    const writer = {
      writeRows: vi.fn(),
      close: vi.fn(),
      abort: vi.fn(async () => undefined),
    }

    await expect(
      runFullResolutionJpegExport({
        capability: makeCapability(),
        graph: {
          supported: true,
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          lutProfile: null,
          steps: [
            { kind: 'input-linear-prophoto' },
            IDENTITY_RAW_RENDER_EXPOSURE_STEP,
            ...neutralToneSteps(),
            { kind: 'output-srgb' },
          ],
        },
        readProcessedWindow: vi
          .fn()
          .mockRejectedValue(new Error('read failed')),
        writerFactory: () => writer,
      }),
    ).rejects.toThrow('read failed')

    expect(writer.abort).toHaveBeenCalledTimes(1)
  })

  it('fails closed for malformed supported graphs instead of falling back to the simple path', async () => {
    const writer = {
      writeRows: vi.fn(),
      close: vi.fn(),
      abort: vi.fn(async () => undefined),
    }

    await expect(
      runFullResolutionJpegExport({
        capability: makeCapability(),
        graph: {
          supported: true,
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          lutProfile: null,
          steps: [
            { kind: 'input-linear-prophoto' },
            IDENTITY_RAW_RENDER_EXPOSURE_STEP,
            ...neutralToneSteps(),
            {
              kind: 'lut-output-to-srgb',
              matrix: mat3Identity(),
              transfer: 'srgb',
              range: 'full',
              role: 'scene-creative',
              intensity: 0.5,
            },
            { kind: 'output-srgb' },
          ],
        },
        readProcessedWindow: vi.fn(),
        writerFactory: () => writer,
      }),
    ).rejects.toThrow('FULL_RES_EXPORT_UNSUPPORTED_PIPELINE')

    expect(writer.writeRows).not.toHaveBeenCalled()
    expect(writer.abort).not.toHaveBeenCalled()
  })

  it('fails closed for malformed but complete supported graphs with duplicate steps', async () => {
    const writer = {
      writeRows: vi.fn(),
      close: vi.fn(),
      abort: vi.fn(async () => undefined),
    }

    await expect(
      runFullResolutionJpegExport({
        capability: makeCapability(),
        graph: {
          supported: true,
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          lutProfile: null,
          steps: [
            { kind: 'input-linear-prophoto' },
            IDENTITY_RAW_RENDER_EXPOSURE_STEP,
            ...neutralToneSteps(),
            {
              kind: 'gamut-to-lut-input',
              matrix: mat3Identity(),
              gamut: 'prophoto-rgb',
            },
            {
              kind: 'encode-lut-transfer',
              transfer: 'srgb',
              range: 'full',
            },
            {
              kind: 'encode-lut-transfer',
              transfer: 'srgb',
              range: 'full',
            },
            {
              kind: 'lut3d',
              size: 2,
              data: new Float32Array(24),
              domainMin: [0, 0, 0],
              domainMax: [1, 1, 1],
            },
            {
              kind: 'lut-output-to-srgb',
              matrix: mat3Identity(),
              transfer: 'srgb',
              range: 'full',
              role: 'scene-creative',
              intensity: 0.5,
            },
            { kind: 'output-srgb' },
          ],
        },
        readProcessedWindow: vi.fn(),
        writerFactory: () => writer,
      }),
    ).rejects.toThrow('FULL_RES_EXPORT_UNSUPPORTED_PIPELINE')

    expect(writer.writeRows).not.toHaveBeenCalled()
    expect(writer.abort).not.toHaveBeenCalled()
  })
})
