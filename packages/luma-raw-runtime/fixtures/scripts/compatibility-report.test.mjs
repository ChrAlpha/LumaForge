// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  buildProcessedWindowRequest,
  classifyEntry,
  normalizeCapability,
  stageError,
  stageOk,
} from './compatibility-report.mjs'

const supportedCapability = {
  supported: true,
  strategy: 'libraw-processed-window',
  width: 4032,
  height: 3024,
  rawWidth: 4048,
  rawHeight: 3040,
  reasons: [],
  sensor: {
    layout: 'bayer',
    cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
  },
  orientation: {
    code: 1,
    supported: true,
    outputWidth: 4032,
    outputHeight: 3024,
  },
  visibleCrop: { x: 8, y: 8, width: 4032, height: 3024 },
  windows: { librawProcessed: true, rawMosaic: true },
}

describe('compatibility report classification', () => {
  it('classifies supported when processed export stages are available', () => {
    expect(
      classifyEntry({
        stages: {
          open: stageOk(1),
          thumbnail: stageError(new Error('no thumbnail'), 2),
          quick: stageOk(3),
          boundedHq: stageOk(4),
          exportCapability: stageOk(5),
          processedWindow: stageOk(6),
        },
        capability: supportedCapability,
      }),
    ).toBe('supported')
  })

  it('classifies preview-only when full-resolution export is blocked', () => {
    expect(
      classifyEntry({
        stages: {
          open: stageOk(1),
          thumbnail: stageOk(2),
          quick: stageOk(3),
          boundedHq: stageError(new Error('bounded HQ unavailable'), 4),
          exportCapability: stageOk(5),
          processedWindow: stageError(new Error('processed window failed'), 6),
        },
        capability: {
          ...supportedCapability,
          supported: false,
          reasons: ['processed-window-unavailable'],
          windows: { librawProcessed: false, rawMosaic: true },
        },
      }),
    ).toBe('preview-only')
  })

  it('classifies metadata-only when open succeeds but preview and export stages fail', () => {
    expect(
      classifyEntry({
        stages: {
          open: stageOk(1),
          thumbnail: stageError(new Error('thumbnail failed'), 2),
          quick: stageError(new Error('quick failed'), 3),
          boundedHq: stageError(new Error('bounded HQ failed'), 4),
          exportCapability: stageError(new Error('capability failed'), 5),
          processedWindow: stageError(new Error('processed window failed'), 6),
        },
        capability: supportedCapability,
      }),
    ).toBe('metadata-only')
  })

  it('classifies open-failed when the open stage fails', () => {
    const error = new Error('cannot open RAW')
    error.code = 'RAW_OPEN_FAILED'

    expect(
      classifyEntry({
        stages: {
          open: stageError(error, 1),
        },
      }),
    ).toBe('open-failed')
  })

  it('normalizes capability without image payloads', () => {
    expect(
      normalizeCapability({
        ...supportedCapability,
        image: { data: new Uint8Array([1, 2, 3]) },
        pixels: new Float32Array([1]),
      }),
    ).toEqual({
      supported: supportedCapability.supported,
      strategy: supportedCapability.strategy,
      reasons: supportedCapability.reasons,
      sensor: supportedCapability.sensor,
      orientation: supportedCapability.orientation,
      visibleCrop: supportedCapability.visibleCrop,
      windows: supportedCapability.windows,
    })
  })

  it('builds centered processed-window requests with zero halo', () => {
    expect(buildProcessedWindowRequest({ width: 4032, height: 3024 })).toEqual({
      outputRect: { x: 1984, y: 1480, width: 64, height: 64 },
      halo: { left: 0, top: 0, right: 0, bottom: 0 },
    })
    expect(buildProcessedWindowRequest({ width: 40, height: 32 })).toEqual({
      outputRect: { x: 0, y: 0, width: 40, height: 32 },
      halo: { left: 0, top: 0, right: 0, bottom: 0 },
    })
  })
})
