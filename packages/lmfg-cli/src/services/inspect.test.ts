// @vitest-environment node
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { LmfgRuntime } from '../runtime/node-runtime'
import { createLmfgRuntime } from '../runtime/node-runtime'
import type { LoadedSource } from '../runtime/source-loader'
import { loadSourceFile } from '../runtime/source-loader'
import {
  describeWithFixture,
  FIXTURE_PATH,
} from '../test-support/describe-with-fixture'
import { inspectSource } from './inspect'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lmfg-inspect-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describeWithFixture('inspectSource', () => {
  it('reports metadata, capability, exposure, and writes the embedded preview', async () => {
    const runtime = createLmfgRuntime({ memoryProfile: 'desktop' })
    try {
      const source = await loadSourceFile(FIXTURE_PATH, dir)
      const previewPath = join(dir, 'embedded-preview.jpg')
      const result = await inspectSource({
        runtime,
        source,
        sessionId: null,
        embeddedPreviewPath: previewPath,
      })
      expect(result.metadata.make).toMatch(/apple/i)
      expect(result.decoded_dimensions).toEqual({ width: 4032, height: 3024 })
      expect(result.export_capability).toMatchObject({
        supported: true,
        strategy: 'libraw-processed-window',
      })
      expect(result.raw_render_exposure.source).toBe('dng-baseline')
      expect(result.embedded_preview?.uri).toMatch(/^file:\/\//)
      expect((await stat(previewPath)).size).toBeGreaterThan(1000)
    } finally {
      runtime.dispose()
    }
  }, 60_000)
})

const SOURCE = {
  absolutePath: '/photos/frame.dng',
  filename: 'frame.dng',
  byteSize: 1024,
  sha256: 'a'.repeat(64),
  input: {},
} as unknown as LoadedSource

/** A capability the processed-window export admits. */
const ADMITTED = {
  supported: true,
  strategy: 'libraw-processed-window',
  width: 64,
  height: 48,
  rawWidth: 64,
  rawHeight: 48,
  cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
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
    colorCount: 3,
    cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
    phaseIsWindowLocal: false,
  },
  windows: { librawProcessed: true },
  diagnostics: {
    hasRawImage: true,
    hasColor3Image: false,
    hasColor4Image: false,
    hasXTransTable: false,
  },
  reasons: [],
} as const

function fakeRuntime(capability: unknown): LmfgRuntime {
  const session = {
    probe: { width: 64, height: 48, supportLevel: 'official' },
    extractEmbeddedPreview: async () => null,
    probeExportCapability: async () => capability,
    decodeQuick: async () => ({
      data: new Uint16Array(4 * 3 * 3).fill(13107),
      width: 4,
      height: 3,
      source: 'quick',
      metadata: {},
    }),
    dispose: () => {},
  }
  return {
    memoryProfile: 'desktop',
    raw: async () => ({ openSession: async () => session }),
    jpeg: async () => ({}),
    dispose: () => {},
  } as unknown as LmfgRuntime
}

async function inspectCapability(capability: unknown) {
  const result = await inspectSource({
    runtime: fakeRuntime(capability),
    source: SOURCE,
    sessionId: null,
    embeddedPreviewPath: null,
  })
  return result.export_capability
}

describe('inspectSource export capability', () => {
  it('reports an admitted capability as supported with no reasons', async () => {
    expect(await inspectCapability(ADMITTED)).toEqual({
      supported: true,
      strategy: 'libraw-processed-window',
      width: 64,
      height: 48,
      reasons: [],
    })
  })

  it('refuses a supported source whose color facts are missing', async () => {
    const { color: _color, ...withoutColor } = ADMITTED
    expect(await inspectCapability(withoutColor)).toEqual({
      supported: false,
      strategy: 'libraw-processed-window',
      width: 64,
      height: 48,
      reasons: ['color-facts-missing'],
    })
  })

  it('refuses a supported source whose color facts are not runtime-applied linear ProPhoto', async () => {
    expect(
      await inspectCapability({
        ...ADMITTED,
        color: {
          ...ADMITTED.color,
          workingSpace: 'linear-srgb',
          cameraWhiteBalanceAppliedByRuntime: false,
          cameraMatrixAppliedByRuntime: false,
        },
      }),
    ).toEqual({
      supported: false,
      strategy: 'libraw-processed-window',
      width: 64,
      height: 48,
      reasons: [
        'working-space-not-linear-prophoto',
        'white-balance-not-applied-by-runtime',
        'camera-matrix-not-applied-by-runtime',
      ],
    })
  })

  it('refuses a supported source with invalid dimensions and keeps the measured ones', async () => {
    expect(
      await inspectCapability({ ...ADMITTED, width: 0, height: 48 }),
    ).toEqual({
      supported: false,
      strategy: 'libraw-processed-window',
      width: 0,
      height: 48,
      reasons: ['invalid-dimensions'],
    })
  })

  it('refuses a supported source whose processed windows are unavailable', async () => {
    expect(
      await inspectCapability({
        ...ADMITTED,
        windows: { librawProcessed: false },
      }),
    ).toEqual({
      supported: false,
      strategy: 'libraw-processed-window',
      width: 64,
      height: 48,
      reasons: ['processed-windows-unavailable'],
    })
  })

  it('keeps the runtime reasons ahead of the assessment refusals', async () => {
    expect(
      await inspectCapability({
        ...ADMITTED,
        supported: false,
        strategy: undefined,
        windows: { librawProcessed: false },
        reasons: ['libraw-cropbox-window-unavailable'],
      }),
    ).toEqual({
      supported: false,
      strategy: null,
      width: 64,
      height: 48,
      reasons: [
        'libraw-cropbox-window-unavailable',
        'source-unsupported',
        'strategy-not-processed-window',
        'processed-windows-unavailable',
      ],
    })
  })

  it('reports runtime reasons on a capability the assessment admits', async () => {
    expect(
      await inspectCapability({
        ...ADMITTED,
        reasons: ['jpeg-runtime-unavailable'],
      }),
    ).toEqual({
      supported: true,
      strategy: 'libraw-processed-window',
      width: 64,
      height: 48,
      reasons: ['jpeg-runtime-unavailable'],
    })
  })
})
