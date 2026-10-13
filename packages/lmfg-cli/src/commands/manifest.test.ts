// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { computeManifestSha256 } from '@lumaforge/render-engine/manifest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createCliHarness } from '../e2e/fixture'
import { EXIT_CODES } from '../protocol/exit-codes'
import { resolveRenderEnvironment } from '../runtime/versions'
import { parseRenderParams } from '../schemas/params'
import { ManifestVerifyResultSchema } from '../schemas/results'
import { buildColorGraph, requireSupportedGraph } from '../services/color-graph'
import { buildRenderManifest } from '../services/manifest'

let dir: string
let cli: ReturnType<typeof createCliHarness>
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lmfg-manifest-cmd-'))
  cli = createCliHarness(dir)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

type Json = Record<string, any>
type Kind = 'preview' | 'candidate' | 'export'

const environment = resolveRenderEnvironment('desktop')
const exposure = { ev: 0, multiplier: 1, source: 'identity' as const }
const SOURCE = { width: 6000, height: 4000 }

/** A keystone whose horizon crosses the frame at x = 0.5: w = 1 - 2x. */
const FOLDING = [1, 0, 0, 0, 1, 0, -2, 0, 1]
/** Zooming out by 0.5 about the centre keeps exactly half of each side. */
const HALF_ZOOM = [0.5, 0, 0.25, 0, 0.5, 0.25, 0, 0, 1]

/**
 * A manifest the current writer seals, then edited as JSON and sealed again,
 * so every case below is correctly sealed and structurally complete.
 */
function sealed(kind: Kind, edit: (manifest: Json) => void = () => {}): Json {
  const params = parseRenderParams({ contrast: 5 })
  const manifest = JSON.parse(
    JSON.stringify(
      buildRenderManifest({
        kind,
        source: {
          sha256: 'a'.repeat(64),
          byte_size: 10,
          filename: 'x.dng',
          decoded_dimensions: SOURCE,
        },
        lut: null,
        graph: requireSupportedGraph(buildColorGraph(params, null, exposure)),
        params,
        exposure,
        policy:
          kind === 'export'
            ? { kind: 'export-full', row_slice: 512, concurrency: 1 }
            : {
                kind: kind === 'preview' ? 'preview-quick' : 'candidate',
                row_slice: 256,
                concurrency: 1,
                max_pixels: 2_000_000,
              },
        environment,
        output: {
          ...SOURCE,
          quality: 92,
          filename: 'final.jpg',
          sha256: 'b'.repeat(64),
        },
        parentManifestSha256: null,
        producedAt: new Date('2026-09-05T00:00:00Z'),
      }),
    ),
  ) as Json
  edit(manifest)
  manifest.manifest_sha256 = computeManifestSha256(manifest)
  return manifest
}

function withGeometry(
  matrix: number[],
  constrainCrop: boolean,
  output: { width: number; height: number },
): (manifest: Json) => void {
  return (m) => {
    m.render_params.geometry = {
      matrix,
      constrain_crop: constrainCrop,
      output,
    }
    m.output.dimensions = output
  }
}

async function verify(manifest: unknown) {
  const path = join(dir, 'm.json')
  await writeFile(path, JSON.stringify(manifest))
  return cli.run('manifest', 'verify', path)
}

describe('lmfg manifest verify', () => {
  it('reports an executable export geometry as checked, not only as sealed', async () => {
    const half = { width: 3000, height: 2000 }
    const run = await verify(
      sealed('export', withGeometry(HALF_ZOOM, true, half)),
    )
    expect(run.code, run.stdout).toBe(EXIT_CODES.ok)
    const result = ManifestVerifyResultSchema.parse(run.envelope.result)
    expect(result).toMatchObject({
      valid: true,
      structural_valid: true,
      geometry_executable: true,
      geometry_refusal: null,
      kind: 'export',
      issues: [],
    })
  })

  it('checks the source frame an export without a geometry delivers', async () => {
    const run = await verify(sealed('export'))
    expect(run.code, run.stdout).toBe(EXIT_CODES.ok)
    expect(ManifestVerifyResultSchema.parse(run.envelope.result)).toMatchObject(
      {
        valid: true,
        structural_valid: true,
        geometry_executable: true,
        geometry_refusal: null,
      },
    )
  })

  it.each(['preview', 'candidate'] as const)(
    'has no geometry to check for a %s that records none',
    async (kind) => {
      const run = await verify(sealed(kind))
      expect(run.code, run.stdout).toBe(EXIT_CODES.ok)
      expect(
        ManifestVerifyResultSchema.parse(run.envelope.result),
      ).toMatchObject({
        valid: true,
        structural_valid: true,
        geometry_executable: null,
        geometry_refusal: null,
      })
    },
  )

  /** The failure envelope: manifest.invalid, exit 1, with the result as details. */
  function refusedResult(run: Awaited<ReturnType<typeof verify>>) {
    expect(run.code, run.stdout).toBe(EXIT_CODES.failure)
    const envelope = run.envelope as Json
    expect(envelope.ok).toBe(false)
    expect(envelope.error.code).toBe('manifest.invalid')
    return ManifestVerifyResultSchema.parse(envelope.error.details)
  }

  it('refuses a correctly sealed export whose geometry folds the frame', async () => {
    const output = { width: 3000, height: 2000 }
    const result = refusedResult(
      await verify(sealed('export', withGeometry(FOLDING, false, output))),
    )
    expect(result).toMatchObject({
      valid: false,
      structural_valid: true,
      geometry_executable: false,
      kind: 'export',
      geometry_refusal: {
        reason: 'unplannable-geometry',
        source: SOURCE,
        cause: expect.any(String),
      },
    })
    expect(result.issues).toEqual([
      expect.stringMatching(/^render_params\.geometry: /),
    ])
    expect(result.issues.join(' ')).not.toMatch(/manifest_sha256/)
  })

  it('refuses a correctly sealed export whose output is not the source frame', async () => {
    const recorded = { width: 3000, height: 2000 }
    const result = refusedResult(
      await verify(
        sealed('export', (m) => {
          m.output.dimensions = recorded
        }),
      ),
    )
    expect(result).toMatchObject({
      valid: false,
      structural_valid: true,
      geometry_executable: false,
      geometry_refusal: {
        reason: 'output-mismatch',
        delivered_by: 'source',
        recorded,
        delivered: SOURCE,
      },
    })
    expect(result.issues).toEqual([
      expect.stringMatching(/^output\.dimensions: /),
    ])
  })

  it('refuses a correctly sealed export whose geometry output is not the planned frame', async () => {
    const recorded = { width: 2999, height: 2000 }
    const result = refusedResult(
      await verify(sealed('export', withGeometry(HALF_ZOOM, true, recorded))),
    )
    expect(result).toMatchObject({
      valid: false,
      structural_valid: true,
      geometry_executable: false,
      geometry_refusal: {
        reason: 'geometry-output-mismatch',
        source: SOURCE,
        recorded,
        planned: { width: 3000, height: 2000 },
      },
    })
    expect(result.issues).toEqual([
      expect.stringMatching(/^render_params\.geometry\.output: /),
    ])
  })

  it('refuses a correctly sealed export whose output is not its geometry output', async () => {
    const planned = { width: 3000, height: 2000 }
    const result = refusedResult(
      await verify(
        sealed('export', (m) => {
          withGeometry(HALF_ZOOM, true, planned)(m)
          m.output.dimensions = SOURCE
        }),
      ),
    )
    expect(result.geometry_refusal).toEqual({
      reason: 'output-mismatch',
      delivered_by: 'geometry',
      recorded: SOURCE,
      delivered: planned,
    })
    expect(result.geometry_executable).toBe(false)
    expect(result.structural_valid).toBe(true)
  })

  it.each(['preview', 'candidate'] as const)(
    'refuses a correctly sealed %s that records a geometry',
    async (kind) => {
      const result = refusedResult(
        await verify(
          sealed(kind, (m) => {
            m.render_params.geometry = {
              matrix: HALF_ZOOM,
              constrain_crop: true,
              output: { width: 3000, height: 2000 },
            }
          }),
        ),
      )
      expect(result).toMatchObject({
        valid: false,
        structural_valid: true,
        geometry_executable: false,
        geometry_refusal: { reason: 'non-export-geometry', kind },
      })
    },
  )

  it('leaves geometry unchecked when the seal fails, and says so', async () => {
    const tampered = sealed('export', withGeometry(FOLDING, false, SOURCE))
    tampered.render_params.exposure_ev = 9
    const result = refusedResult(await verify(tampered))
    expect(result).toMatchObject({
      valid: false,
      structural_valid: false,
      geometry_executable: null,
      geometry_refusal: null,
    })
    expect(result.issues[0]).toMatch(/^manifest_sha256: /)
  })

  it('leaves geometry unchecked for a file that is not JSON', async () => {
    const path = join(dir, 'm.json')
    await writeFile(path, '{')
    const result = refusedResult(await cli.run('manifest', 'verify', path))
    expect(result).toMatchObject({
      valid: false,
      structural_valid: false,
      geometry_executable: null,
      geometry_refusal: null,
      manifest_sha256: null,
      kind: null,
    })
  })
})
