// @vitest-environment node
import {
  NEUTRAL_SELECTIVE_COLOR,
  resolveExportColorGraph,
} from '@lumaforge/luma-color-runtime'
import { describe, expect, it } from 'vitest'

import { INVALID_EXPORT_GEOMETRY } from '../export/geometry/export-geometry'
import { createRenderManifest } from './create-render-manifest'
import { checkRecordedExportGeometry } from './export-geometry'
import { parseRenderManifest } from './parse-render-manifest'
import type {
  GeometryParams,
  PolicyChoice,
  RenderManifest,
  RenderManifestKind,
} from './render-manifest'
import { projectManifestRenderParams } from './render-params'

const rawRenderExposure = { ev: 0, source: 'dng-baseline' as const }

const resolved = resolveExportColorGraph({
  styleKind: 'none',
  intensity: 1,
  builtinPreset: null,
  lut: null,
  selectiveColor: NEUTRAL_SELECTIVE_COLOR,
  rawRenderExposure: { ...rawRenderExposure, multiplier: 1 },
})
if (!resolved.supported) throw new Error(resolved.message)
const graph = resolved

type Size = { width: number; height: number }

const POLICY: Record<RenderManifestKind, PolicyChoice> = {
  export: { kind: 'export-full', row_slice: 512, concurrency: 1 },
  preview: {
    kind: 'preview-quick',
    row_slice: 256,
    concurrency: 1,
    max_pixels: 2_000_000,
  },
  candidate: {
    kind: 'candidate',
    row_slice: 256,
    concurrency: 1,
    max_pixels: 2_000_000,
  },
}

/**
 * A manifest as the current writers seal it, with the decoded source, the
 * recorded geometry and the recorded output chosen independently.
 */
function manifestOf(input: {
  kind?: RenderManifestKind
  source: Size
  geometry?: GeometryParams
  output: Size
}): RenderManifest {
  const kind = input.kind ?? 'export'
  const manifest = createRenderManifest({
    kind,
    source_raw: {
      sha256: 'a'.repeat(64),
      byte_size: 10,
      filename: 'x.dng',
      decoded_dimensions: input.source,
    },
    lut: null,
    graph,
    render_params: projectManifestRenderParams({
      userColor: {},
      intensity: 1,
      rawRenderExposure,
      geometry: input.geometry,
    }),
    policy: POLICY[kind],
    environment: {
      render_engine: '0.1.0',
      luma_color_runtime: '0.1.1',
      luma_raw_runtime: '0.1.1',
      luma_jpeg_runtime: '0.1.1',
      native_artifacts: { build_id: 'unknown', variant: 'desktop' },
    },
    output: {
      ...input.output,
      quality: 92,
      filename: 'final.jpg',
      sha256: 'b'.repeat(64),
    },
    parent_manifest_sha256: null,
    produced_at: '2026-09-05T00:00:00.000Z',
  })
  // Every fixture is structurally valid: what this reader refuses, the
  // structural reader accepts.
  const parsed = parseRenderManifest(JSON.parse(JSON.stringify(manifest)))
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
  return parsed.manifest
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry)
    Object.freeze(value)
  }
  return value
}

/** Source-normalized to output-normalized: a turn of `degrees` about the centre. */
function rotation(degrees: number): number[] {
  const angle = (degrees * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return [
    cos,
    -sin,
    0.5 - 0.5 * cos + 0.5 * sin,
    sin,
    cos,
    0.5 - 0.5 * sin - 0.5 * cos,
    0,
    0,
    1,
  ]
}

/** Source-normalized to output-normalized: a uniform zoom about the centre. */
function zoom(factor: number): number[] {
  const offset = 0.5 - 0.5 * factor
  return [factor, 0, offset, 0, factor, offset, 0, 0, 1]
}

/** A keystone whose horizon stays outside the frame: w = 1 + 0.2x. */
const KEYSTONE = [1, 0, 0, 0, 1, 0, 0.2, 0, 1]

/** A keystone whose horizon crosses the frame at x = 0.5: w = 1 - 2x. */
const FOLDING = [1, 0, 0, 0, 1, 0, -2, 0, 1]

describe('checkRecordedExportGeometry', () => {
  // Expected frames are derived by hand, not by the planner:
  //   - a 30 degree turn in normalized space keeps the centred square of side
  //     1 / (cos 30 + sin 30) = 0.7320508...;
  //   - zooming out by 0.5 keeps exactly half of each side;
  //   - the keystone w = 1 + 0.2x keeps the centred square whose far corner
  //     b satisfies b / (1 - 0.2b) = 1, so side 2b - 1 = 2/3;
  //   - an unconstrained crop delivers the source frame whatever it maps.
  it.each([
    {
      name: 'a constrained 30 degree turn on a landscape source',
      source: { width: 6000, height: 4000 },
      matrix: rotation(30),
      constrainCrop: true,
      output: { width: 4392, height: 2928 },
    },
    {
      name: 'a constrained 30 degree turn on a portrait source',
      source: { width: 3000, height: 4500 },
      matrix: rotation(-30),
      constrainCrop: true,
      output: { width: 2196, height: 3294 },
    },
    {
      name: 'a half zoom-out on an odd-sized source, rounding half up',
      source: { width: 4001, height: 2999 },
      matrix: zoom(0.5),
      constrainCrop: true,
      output: { width: 2001, height: 1500 },
    },
    {
      name: 'a constrained keystone',
      source: { width: 6000, height: 4000 },
      matrix: KEYSTONE,
      constrainCrop: true,
      output: { width: 4000, height: 2667 },
    },
    {
      name: 'an unconstrained keystone',
      source: { width: 6000, height: 4000 },
      matrix: KEYSTONE,
      constrainCrop: false,
      output: { width: 6000, height: 4000 },
    },
    {
      name: 'a zoom-in that needs no crop',
      source: { width: 5472, height: 3648 },
      matrix: zoom(2),
      constrainCrop: true,
      output: { width: 5472, height: 3648 },
    },
  ])(
    'accepts $name and returns the frame it delivers',
    ({ source, matrix, constrainCrop, output }) => {
      const manifest = deepFreeze(
        manifestOf({
          source,
          geometry: { matrix, constrain_crop: constrainCrop, output },
          output,
        }),
      )
      const check = checkRecordedExportGeometry(manifest)
      expect(check).toEqual({
        ok: true,
        frame: {
          source,
          output,
          geometry: { matrix, constrainCrop },
        },
      })
      // The frame is the reader's own copy, not a view into the manifest.
      if (!check.ok || !check.frame?.geometry) throw new Error('unreachable')
      expect(check.frame.geometry.matrix).not.toBe(
        manifest.render_params.geometry!.matrix,
      )
      expect(check.frame.source).not.toBe(
        manifest.source_raw.decoded_dimensions,
      )
      expect(check.frame.output).not.toBe(manifest.output.dimensions)
    },
  )

  it('accepts an export without a geometry that delivers its source frame', () => {
    const source = { width: 6000, height: 4000 }
    const manifest = deepFreeze(manifestOf({ source, output: source }))
    expect(checkRecordedExportGeometry(manifest)).toEqual({
      ok: true,
      frame: { source, output: source, geometry: null },
    })
  })

  it.each([
    {
      name: 'a geometry whose horizon crosses the frame',
      matrix: FOLDING,
      constrainCrop: false,
    },
    {
      name: 'a constrained crop that folds the frame',
      matrix: FOLDING,
      constrainCrop: true,
    },
    {
      name: 'a constrained crop that retains less than the minimum',
      matrix: zoom(0.05),
      constrainCrop: true,
    },
  ])(
    'refuses $name with the planner cause, though it is structurally valid',
    ({ matrix, constrainCrop }) => {
      const source = { width: 6000, height: 4000 }
      const output = { width: 3000, height: 2000 }
      const check = checkRecordedExportGeometry(
        manifestOf({
          source,
          geometry: { matrix, constrain_crop: constrainCrop, output },
          output,
        }),
      )
      expect(check).toEqual({
        ok: false,
        refusal: {
          reason: 'unplannable-geometry',
          source,
          cause: expect.any(Error),
        },
      })
      if (check.ok || check.refusal.reason !== 'unplannable-geometry')
        throw new Error('unreachable')
      expect(check.refusal.cause.message).toBe(INVALID_EXPORT_GEOMETRY)
    },
  )

  it('accepts the smallest retained crop the planner keeps', () => {
    // Zooming out by 0.1 keeps a tenth of each side, above the planner's
    // minimum; 4001 x 0.1 and 2999 x 0.1 round to 400 and 300.
    const source = { width: 4001, height: 2999 }
    const output = { width: 400, height: 300 }
    const check = checkRecordedExportGeometry(
      manifestOf({
        source,
        geometry: { matrix: zoom(0.1), constrain_crop: true, output },
        output,
      }),
    )
    expect(check.ok).toBe(true)
  })

  const source = { width: 6000, height: 4000 }
  const planned = { width: 4392, height: 2928 }

  it.each([
    { name: 'its width', recorded: { width: 4393, height: 2928 } },
    { name: 'its height', recorded: { width: 4392, height: 2927 } },
    { name: 'both sides', recorded: { width: 2928, height: 4392 } },
  ])(
    'refuses a recorded geometry output that differs from the plan in $name',
    ({ recorded }) => {
      const check = checkRecordedExportGeometry(
        manifestOf({
          source,
          geometry: {
            matrix: rotation(30),
            constrain_crop: true,
            output: recorded,
          },
          output: recorded,
        }),
      )
      expect(check).toEqual({
        ok: false,
        refusal: {
          reason: 'geometry-output-mismatch',
          source,
          recorded,
          planned,
        },
      })
    },
  )

  it.each([
    { name: 'its width', recorded: { width: 4391, height: 2928 } },
    { name: 'its height', recorded: { width: 4392, height: 2929 } },
    { name: 'the source frame', recorded: source },
  ])(
    'refuses an output that differs from the planned geometry frame in $name',
    ({ recorded }) => {
      const check = checkRecordedExportGeometry(
        manifestOf({
          source,
          geometry: {
            matrix: rotation(30),
            constrain_crop: true,
            output: planned,
          },
          output: recorded,
        }),
      )
      expect(check).toEqual({
        ok: false,
        refusal: {
          reason: 'output-mismatch',
          deliveredBy: 'geometry',
          recorded,
          delivered: planned,
        },
      })
    },
  )

  it.each([
    { name: 'its width', recorded: { width: 5999, height: 4000 } },
    { name: 'its height', recorded: { width: 6000, height: 4001 } },
    { name: 'its orientation', recorded: { width: 4000, height: 6000 } },
  ])(
    'refuses an export without a geometry whose output differs from the source in $name',
    ({ recorded }) => {
      const check = checkRecordedExportGeometry(
        manifestOf({ source, output: recorded }),
      )
      expect(check).toEqual({
        ok: false,
        refusal: {
          reason: 'output-mismatch',
          deliveredBy: 'source',
          recorded,
          delivered: source,
        },
      })
    },
  )

  it.each(['preview', 'candidate'] as const)(
    'refuses a %s manifest that records a geometry, before planning it',
    (kind) => {
      // Even an unplannable geometry is refused as one a non-export records.
      const output = { width: 1600, height: 1067 }
      const check = checkRecordedExportGeometry(
        manifestOf({
          kind,
          source: { width: 1600, height: 1067 },
          geometry: { matrix: FOLDING, constrain_crop: true, output },
          output,
        }),
      )
      expect(check).toEqual({
        ok: false,
        refusal: { reason: 'non-export-geometry', kind },
      })
    },
  )

  it.each(['preview', 'candidate'] as const)(
    'has no export frame to check for a %s manifest without a geometry',
    (kind) => {
      // A bounded render records its own decoded frame; nothing is compared.
      const check = checkRecordedExportGeometry(
        manifestOf({
          kind,
          source: { width: 1600, height: 1067 },
          output: { width: 1200, height: 800 },
        }),
      )
      expect(check).toEqual({ ok: true, frame: null })
    },
  )
})
