// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { LumaRawDecodeSession } from '@lumaforge/luma-raw-runtime'
import type { RenderManifest } from '@lumaforge/render-engine'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createCliHarness,
  describeWithFixture,
  FIXTURE_PATH,
} from '../e2e/fixture'
import { decodeFrame } from '../services/preview'
import { readJson } from '../workspace/atomic-fs'

describe('decoded frame source identity', () => {
  it.each([500_000, 3_000_000])(
    'resolves full oriented dimensions before decoding at %i pixels',
    async (maxPixels) => {
      const probeExportCapability = vi.fn(async () => ({
        width: 5520,
        height: 8280,
      }))
      const decode = vi.fn(async () => {
        expect(probeExportCapability).toHaveBeenCalledExactlyOnceWith(signal)
        return { data: new Uint16Array(18), width: 2, height: 3 }
      })
      const session = {
        probe: { width: 8280, height: 5520 },
        probeExportCapability,
        decodeQuick: decode,
        decodeBoundedHq: decode,
      } as unknown as LumaRawDecodeSession
      const signal = new AbortController().signal
      const frame = await decodeFrame(session, maxPixels, signal)
      expect(frame).toMatchObject({
        width: 2,
        height: 3,
        sourceDimensions: { width: 5520, height: 8280 },
        decode: maxPixels <= 2_500_000 ? 'quick' : 'bounded-hq',
      })
    },
  )

  it.each([
    { width: 5520, height: 8280 },
    { width: 0, height: 0 },
  ])(
    'keeps preview decoding available for unsupported export with %o',
    async (dimensions) => {
      const frame = { data: new Uint16Array(18), width: 2, height: 3 }
      const session = {
        probe: { width: 8280, height: 5520 },
        probeExportCapability: async () => ({
          supported: false,
          reasons: ['processed-window-unavailable'],
          ...dimensions,
        }),
        decodeQuick: async () => frame,
      } as unknown as LumaRawDecodeSession
      await expect(decodeFrame(session, 500_000)).resolves.toMatchObject({
        ...frame,
        sourceDimensions:
          dimensions.width > 0 ? dimensions : { width: 8280, height: 5520 },
      })
    },
  )
})

describeWithFixture('oriented source manifest identity', () => {
  let cwd: string
  let sourcePath: string
  let cli: ReturnType<typeof createCliHarness>

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'lmfg-oriented-source-'))
    cli = createCliHarness(cwd)
    sourcePath = join(cwd, 'portrait.dng')
    const bytes = await readFile(FIXTURE_PATH)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const littleEndian = view.getUint16(0) === 0x4949
    expect(view.getUint16(2, littleEndian)).toBe(42)
    const ifd = view.getUint32(4, littleEndian)
    const count = view.getUint16(ifd, littleEndian)
    let orientationOffset = -1
    for (let index = 0; index < count; index += 1) {
      const offset = ifd + 2 + index * 12
      if (view.getUint16(offset, littleEndian) !== 274) continue
      expect(view.getUint16(offset + 2, littleEndian)).toBe(3)
      expect(view.getUint32(offset + 4, littleEndian)).toBe(1)
      orientationOffset = offset + 8
      break
    }
    expect(orientationOffset).toBeGreaterThan(0)
    view.setUint16(orientationOffset, 6, littleEndian)
    await writeFile(sourcePath, bytes)
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it.each([500_000, 3_000_000])(
    'keeps preview, candidate, and export source identity equal without session inspection at %i pixels',
    async (maxPixels) => {
      const initialized = await cli.run(
        'session',
        'init',
        '--source',
        sourcePath,
      )
      expect(initialized.code, initialized.stdout).toBe(0)
      const sessionId = initialized.envelope.result!.id as string
      const inspected = await cli.run('inspect', sourcePath)
      expect(inspected.code, inspected.stdout).toBe(0)
      expect(inspected.envelope.result).toMatchObject({
        session_id: null,
        metadata: { width: 4032, height: 3024 },
        decoded_dimensions: { width: 3024, height: 4032 },
      })
      const status = await cli.run('session', 'status', '--session', sessionId)
      expect(status.envelope.result!.decoded_dimensions).toBeNull()

      const preview = await cli.run(
        'render',
        'preview',
        '--session',
        sessionId,
        '--max-pixels',
        String(maxPixels),
      )
      expect(preview.code, preview.stdout).toBe(0)
      const candidates = await cli.run(
        'render',
        'candidate',
        '--session',
        sessionId,
        '--max-pixels',
        String(maxPixels),
        '--concurrency',
        '1',
        '--plan-json',
        JSON.stringify({ candidates: [{ params: { contrast: 12 } }] }),
      )
      expect(candidates.code, candidates.stdout).toBe(0)
      const exported = await cli.run(
        'render',
        'export',
        '--session',
        sessionId,
        '--iteration',
        'iter_0001',
        '--candidate',
        'cand_0001',
      )
      expect(exported.code, exported.stdout).toBe(0)
      const candidate = (
        candidates.envelope.result!.candidates as Array<{
          manifest_uri: string
        }>
      )[0]
      const [previewManifest, candidateManifest, exportManifest] =
        await Promise.all(
          [
            preview.envelope.result!.manifest_uri as string,
            candidate.manifest_uri,
            exported.envelope.result!.manifest_uri as string,
          ].map((uri) => readJson<RenderManifest>(fileURLToPath(uri))),
        )
      expect(exportManifest.source_raw.decoded_dimensions).toEqual({
        width: 3024,
        height: 4032,
      })
      expect(exported.envelope.result!.output).toMatchObject({
        width: 3024,
        height: 4032,
      })
      expect(previewManifest.source_raw).toEqual(exportManifest.source_raw)
      expect(candidateManifest.source_raw).toEqual(exportManifest.source_raw)
      expect(previewManifest.output.dimensions.width).toBeLessThan(
        previewManifest.output.dimensions.height,
      )
      expect(candidateManifest.output.dimensions.width).toBeLessThan(
        candidateManifest.output.dimensions.height,
      )
      expect(exportManifest.parent_manifest_sha256).toBe(
        candidateManifest.manifest_sha256,
      )
      expect(exportManifest.color_graph).toEqual(candidateManifest.color_graph)
    },
    120_000,
  )
})
