import type { ExportColorGraphDescriptor } from '@lumaforge/luma-color-runtime'
import type { LumaRawExportCapability } from '@lumaforge/luma-raw-runtime'
import { describe, expect, it, vi } from 'vitest'

import type { ProcessedExportRefusal } from './exportability'
import { assessProcessedExport } from './exportability'
import { runFullResolutionJpegExport } from './full-res-export'

function makeCapability(
  overrides: Partial<LumaRawExportCapability> = {},
): LumaRawExportCapability {
  return {
    supported: true,
    strategy: 'libraw-processed-window',
    width: 4032,
    height: 3024,
    rawWidth: 4032,
    rawHeight: 3024,
    blackLevel: 0,
    whiteLevel: 4095,
    color: {
      workingSpace: 'linear-prophoto-rgb',
      librawOutputColor: 'prophoto',
      gamma: 'linear',
      cameraWhiteBalanceAppliedByRuntime: true,
      cameraMatrixAppliedByRuntime: true,
    },
    sensor: {
      layout: 'bayer',
      cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
    },
    windows: { librawProcessed: true },
    reasons: [],
    ...overrides,
  }
}

const runtimeColor = {
  workingSpace: 'linear-prophoto-rgb',
  librawOutputColor: 'prophoto',
  gamma: 'linear',
  cameraWhiteBalanceAppliedByRuntime: true,
  cameraMatrixAppliedByRuntime: true,
} as const

// Each row is a capability the executor must refuse, with every refusal the
// assessment reports for it.
const refusedCapabilities: Array<
  [string, Record<string, unknown>, ProcessedExportRefusal[]]
> = [
  ['an unsupported source', { supported: false }, ['source-unsupported']],
  [
    'a non-boolean supported flag',
    { supported: 'true' },
    ['source-unsupported'],
  ],
  ['a zero width', { width: 0 }, ['invalid-dimensions']],
  ['a negative height', { height: -1 }, ['invalid-dimensions']],
  ['a fractional width', { width: 4032.5 }, ['invalid-dimensions']],
  ['a non-finite height', { height: Number.NaN }, ['invalid-dimensions']],
  ['a string width', { width: '4032' }, ['invalid-dimensions']],
  [
    'a missing strategy',
    { strategy: undefined },
    ['strategy-not-processed-window'],
  ],
  [
    'processed windows not available',
    { windows: { librawProcessed: false } },
    ['processed-windows-unavailable'],
  ],
  [
    'missing window facts',
    { windows: undefined },
    ['processed-windows-unavailable'],
  ],
  ['missing color facts', { color: undefined }, ['color-facts-missing']],
  ['null color facts', { color: null }, ['color-facts-missing']],
  [
    'a display working space',
    {
      color: {
        whiteBalance: [1, 1, 1, 1],
        cameraToWorkingRgb: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        workingSpace: 'display-srgb-preview',
      },
    },
    [
      'working-space-not-linear-prophoto',
      'white-balance-not-applied-by-runtime',
      'camera-matrix-not-applied-by-runtime',
    ],
  ],
  [
    'legacy color facts without runtime application',
    {
      color: {
        whiteBalance: [1, 1, 1, 1],
        cameraToWorkingRgb: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        workingSpace: 'linear-prophoto-rgb',
      },
    },
    [
      'white-balance-not-applied-by-runtime',
      'camera-matrix-not-applied-by-runtime',
    ],
  ],
  [
    'runtime white balance not applied',
    { color: { ...runtimeColor, cameraWhiteBalanceAppliedByRuntime: false } },
    ['white-balance-not-applied-by-runtime'],
  ],
  [
    'runtime camera matrix not applied',
    { color: { ...runtimeColor, cameraMatrixAppliedByRuntime: false } },
    ['camera-matrix-not-applied-by-runtime'],
  ],
  [
    'truthy but non-boolean application flags',
    {
      color: {
        ...runtimeColor,
        cameraWhiteBalanceAppliedByRuntime: 1,
        cameraMatrixAppliedByRuntime: 'yes',
      },
    },
    [
      'white-balance-not-applied-by-runtime',
      'camera-matrix-not-applied-by-runtime',
    ],
  ],
  [
    'several independent gaps',
    {
      supported: false,
      width: 0,
      strategy: undefined,
      color: undefined,
    },
    [
      'source-unsupported',
      'invalid-dimensions',
      'strategy-not-processed-window',
      'color-facts-missing',
    ],
  ],
]

const unsupportedGraph: ExportColorGraphDescriptor = {
  supported: false,
  reason: 'unsupported-pipeline',
  message: 'not under test',
  steps: [],
}

describe('assessProcessedExport', () => {
  it('admits a supported processed-window source with runtime color facts', () => {
    expect(assessProcessedExport(makeCapability())).toEqual({
      exportable: true,
      width: 4032,
      height: 3024,
      reasons: [],
    })
  })

  it.each(refusedCapabilities)('refuses %s', (_name, overrides, reasons) => {
    expect(
      assessProcessedExport(
        makeCapability(overrides as Partial<LumaRawExportCapability>),
      ),
    ).toEqual({ exportable: false, reasons })
  })

  it('does not depend on the runtime-reported reasons list', () => {
    expect(
      assessProcessedExport(
        makeCapability({ reasons: ['processed-window-unavailable'] }),
      ).exportable,
    ).toBe(true)
  })
})

describe('runFullResolutionJpegExport source gate', () => {
  it.each(refusedCapabilities)(
    'refuses %s before reading a window or opening a sink',
    async (_name, overrides) => {
      const readProcessedWindow = vi.fn()
      const createSession = vi.fn()

      await expect(
        runFullResolutionJpegExport({
          capability: makeCapability(
            overrides as Partial<LumaRawExportCapability>,
          ),
          graph: unsupportedGraph,
          readProcessedWindow,
          jpegSink: { createSession },
        }),
      ).rejects.toThrow('FULL_RES_EXPORT_UNSUPPORTED_SOURCE')

      expect(readProcessedWindow).not.toHaveBeenCalled()
      expect(createSession).not.toHaveBeenCalled()
    },
  )

  it('lets an admitted source through to the pipeline check', async () => {
    const readProcessedWindow = vi.fn()

    await expect(
      runFullResolutionJpegExport({
        capability: makeCapability(),
        graph: unsupportedGraph,
        readProcessedWindow,
        jpegSink: { createSession: vi.fn() },
      }),
    ).rejects.toThrow('FULL_RES_EXPORT_UNSUPPORTED_PIPELINE')

    expect(readProcessedWindow).not.toHaveBeenCalled()
  })
})
