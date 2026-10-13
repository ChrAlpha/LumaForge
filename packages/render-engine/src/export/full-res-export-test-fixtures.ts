// Pure builders for executor tests: a processed-window capability, synthetic
// processed windows, JPEG outputs, and the resolved neutral color graph.
// Nothing here runs the executor, so expectations stay independent of the
// code under test.

import type {
  ExportColorGraphInput,
  ExportColorGraphStep,
  SupportedExportColorGraphDescriptor,
} from '@lumaforge/luma-color-runtime'
import {
  NEUTRAL_USER_COLOR_INTENT,
  resolveExportColorGraph,
} from '@lumaforge/luma-color-runtime'
import type {
  LumaRawExportCapability,
  LumaRawProcessedWindow,
  LumaRawProcessedWindowRequest,
} from '@lumaforge/luma-raw-runtime'

import { createBlobOutputResult } from './jpeg/output-result'

export function makeCapability(
  overrides: Partial<LumaRawExportCapability> = {},
): LumaRawExportCapability {
  return {
    supported: overrides.supported ?? true,
    strategy: overrides.strategy ?? 'libraw-processed-window',
    width: overrides.width ?? 4,
    height: overrides.height ?? 4,
    rawWidth: overrides.rawWidth ?? 4,
    rawHeight: overrides.rawHeight ?? 4,
    visibleCrop:
      'visibleCrop' in overrides
        ? overrides.visibleCrop
        : { x: 0, y: 0, width: 4, height: 4 },
    cfa: overrides.cfa ?? { pattern: 'rggb', xPhase: 0, yPhase: 0 },
    blackLevel: overrides.blackLevel ?? 0,
    whiteLevel: overrides.whiteLevel ?? 255,
    orientation:
      'orientation' in overrides
        ? overrides.orientation
        : { code: 1, supported: true },
    color:
      'color' in overrides
        ? overrides.color
        : {
            workingSpace: 'linear-prophoto-rgb',
            librawOutputColor: 'prophoto',
            gamma: 'linear',
            cameraWhiteBalanceAppliedByRuntime: true,
            cameraMatrixAppliedByRuntime: true,
          },
    sensor: overrides.sensor ?? {
      layout: 'bayer',
      colorCount: 3,
      cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
      phaseIsWindowLocal: false,
    },
    levels: overrides.levels,
    windows: overrides.windows ?? { librawProcessed: true, rawMosaic: false },
    diagnostics: overrides.diagnostics ?? {
      hasRawImage: true,
      hasColor3Image: false,
      hasColor4Image: false,
      hasXTransTable: false,
    },
    reasons: overrides.reasons ?? [],
  }
}

export function makeProcessedWindow(
  request: LumaRawProcessedWindowRequest,
  value = 32768,
): LumaRawProcessedWindow {
  return {
    rect: request.outputRect,
    workingSpace: 'linear-prophoto-rgb',
    data: new Uint16Array(
      request.outputRect.width * request.outputRect.height * 3,
    ).fill(value),
    width: request.outputRect.width,
    height: request.outputRect.height,
    stride: request.outputRect.width * 3,
    normalized: false,
    orientationApplied: true,
    colorApplied: true,
    warnings: [],
  }
}

export function makePatternedProcessedWindow(
  request: LumaRawProcessedWindowRequest,
): LumaRawProcessedWindow {
  const window = makeProcessedWindow(request, 0)

  for (let row = 0; row < window.height; row += 1) {
    for (let column = 0; column < window.width; column += 1) {
      const index = (row * window.width + column) * 3
      const absoluteRow = request.outputRect.y + row
      const absoluteColumn = request.outputRect.x + column
      window.data[index] =
        10000 + ((absoluteRow * 97 + absoluteColumn * 1009) % 40000)
      window.data[index + 1] =
        12000 + ((absoluteRow * 193 + absoluteColumn * 701) % 38000)
      window.data[index + 2] =
        14000 + ((absoluteRow * 389 + absoluteColumn * 431) % 36000)
    }
  }

  return window
}

export function concatByteRows(rows: Uint8Array[]) {
  const output = new Uint8Array(
    rows.reduce((total, row) => total + row.length, 0),
  )
  let offset = 0

  for (const row of rows) {
    output.set(row, offset)
    offset += row.length
  }

  return output
}

export function makeJpegOutput(parts: BlobPart[] = []) {
  return createBlobOutputResult({
    filename: 'test.jpg',
    blob: new Blob(parts, { type: 'image/jpeg' }),
  })
}

export function makeRgbRampLut() {
  const lut = new Float32Array(2 * 2 * 2 * 3)

  for (let blue = 0; blue < 2; blue += 1) {
    for (let green = 0; green < 2; green += 1) {
      for (let red = 0; red < 2; red += 1) {
        const index = ((blue * 2 + green) * 2 + red) * 3
        lut[index] = red
        lut[index + 1] = green
        lut[index + 2] = blue
      }
    }
  }

  return lut
}

/** The graph export resolves for an untouched photo with no look, plus `overrides`. */
export function neutralGraph(
  overrides: Partial<ExportColorGraphInput> = {},
): SupportedExportColorGraphDescriptor {
  const graph = resolveExportColorGraph({
    ...NEUTRAL_USER_COLOR_INTENT,
    styleKind: 'none',
    builtinPreset: null,
    intensity: 1,
    lut: null,
    ...overrides,
  })
  if (!graph.supported) throw new Error(graph.message)
  return graph
}

/** The scene steps of `neutralGraph(overrides)`, which a LUT stage follows. */
export function neutralSceneSteps(
  overrides: Partial<ExportColorGraphInput> = {},
): ExportColorGraphStep[] {
  return neutralGraph(overrides).steps.slice(0, -1)
}
