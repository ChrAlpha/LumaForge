/// <reference types="node" />
// @vitest-environment node

import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  canonicalizeJson,
  computeManifestSha256,
  sealRenderManifest,
  verifyManifestSha256,
} from './canonicalize'
import type { RenderManifest } from './render-manifest'

function nodeSha256OfText(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

describe('canonicalizeJson', () => {
  it('orders object keys lexicographically at every level', () => {
    const a = canonicalizeJson({ b: 2, a: 1, nested: { y: 1, x: 2 } })
    const b = canonicalizeJson({ a: 1, b: 2, nested: { x: 2, y: 1 } })
    expect(a).toBe(b)
    expect(a).toBe('{"a":1,"b":2,"nested":{"x":2,"y":1}}')
  })

  it('preserves array order', () => {
    expect(canonicalizeJson([3, 1, 2])).toBe('[3,1,2]')
  })

  it('drops undefined-valued object fields entirely', () => {
    expect(canonicalizeJson({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}')
  })

  it('preserves explicit null', () => {
    expect(canonicalizeJson({ a: null })).toBe('{"a":null}')
  })

  it('escapes strings per JSON.stringify defaults', () => {
    expect(canonicalizeJson({ s: 'a "b" \n c' })).toBe(
      '{"s":"a \\"b\\" \\n c"}',
    )
  })

  it('serializes finite numbers as JSON defaults', () => {
    expect(canonicalizeJson({ n: 1, m: 1.5, neg: -0.25 })).toBe(
      '{"m":1.5,"n":1,"neg":-0.25}',
    )
  })

  it('throws on non-finite numbers', () => {
    expect(() => canonicalizeJson({ n: Number.NaN })).toThrow(/non-finite/)
    expect(() => canonicalizeJson({ n: Number.POSITIVE_INFINITY })).toThrow(
      /non-finite/,
    )
  })

  it('throws on BigInt', () => {
    expect(() => canonicalizeJson({ n: 1n })).toThrow(/BigInt/)
  })

  it('top-level undefined throws', () => {
    expect(() => canonicalizeJson(undefined)).toThrow(/undefined/)
  })

  it('produces the same hash as node:crypto for the canonical string', () => {
    const canonical = canonicalizeJson({ a: 1, b: { c: 2 } })
    expect(computeManifestSha256({ a: 1, b: { c: 2 } })).toBe(
      nodeSha256OfText(canonical),
    )
  })
})

describe('computeManifestSha256', () => {
  it('strips the manifest_sha256 field before hashing', () => {
    const without = { a: 1, b: 2 }
    const withHash = { a: 1, b: 2, manifest_sha256: 'should-be-stripped' }
    expect(computeManifestSha256(withHash)).toBe(computeManifestSha256(without))
  })

  it('changes when any other field changes', () => {
    expect(computeManifestSha256({ a: 1 })).not.toBe(
      computeManifestSha256({ a: 2 }),
    )
  })

  it('is stable under different field insertion orders', () => {
    const a = { b: 2, a: 1, c: { y: 1, x: 2 } }
    const b = { a: 1, c: { x: 2, y: 1 }, b: 2 }
    expect(computeManifestSha256(a)).toBe(computeManifestSha256(b))
  })
})

describe('sealRenderManifest / verifyManifestSha256 roundtrip', () => {
  function buildExampleManifest(): Omit<RenderManifest, 'manifest_sha256'> {
    return {
      manifest_version: 1,
      kind: 'preview',
      produced_at: '2026-06-13T12:00:00Z',
      parent_manifest_sha256: null,

      source_raw: {
        sha256:
          '9f3a2c0000000000000000000000000000000000000000000000000000000000',
        byte_size: 31_457_280,
        filename: 'DSC0042.ARW',
        decoded_dimensions: { width: 6000, height: 4000 },
      },

      calibration: {
        kind: 'catalog',
        catalog_id: 'lumaforge-profiles@v2026.06.10',
        profile_id: 'sony/ilce-7m4/adobe-standard',
        schema_version: '1.0.0',
        dcp_params_sha256:
          'bb22aa0000000000000000000000000000000000000000000000000000000000',
        white_neutral: [0.471, 1.0, 0.734],
        alpha: 0.62,
        converged: true,
      },

      lut: {
        kind: 'catalog',
        catalog_id: 'lumaforge-profiles@v2026.06.10',
        entry: 'panasonic/v-log-to-rec709',
        version: '1.2.0',
        sha256:
          'a1b2c30000000000000000000000000000000000000000000000000000000000',
        input_contract: { gamut: 'v-gamut', transfer: 'v-log', range: 'full' },
        output_contract: {
          gamut: 'rec709',
          transfer: 'bt1886',
          range: 'full',
          role: 'combined-look-output',
        },
      },

      color_graph: {
        fingerprint:
          'deadbe0000000000000000000000000000000000000000000000000000000000',
        descriptor: { steps: ['exposure', 'lut'] },
      },

      render_params: {
        exposure_ev: 0.3,
        color_balance: { temp_k: 5600, tint: -2 },
      },

      output: {
        format: 'jpeg',
        dimensions: { width: 1024, height: 683 },
        color_space: 'srgb',
        quality: 85,
        filename: 'preview-001.jpg',
        sha256:
          'ee11ee0000000000000000000000000000000000000000000000000000000000',
      },

      policy: {
        kind: 'preview-quick',
        row_slice: 512,
        concurrency: 1,
      },

      environment: {
        render_engine: '0.1.0',
        luma_color_runtime: '0.1.0',
        luma_raw_runtime: '0.1.0',
        luma_jpeg_runtime: '0.1.0',
        native_artifacts: {
          build_id: 'raw-2026-06-10/jpeg-2026-06-10',
          variant: 'desktop',
        },
      },
    }
  }

  it('seals + verifies a complete RenderManifest example', () => {
    const sealed = sealRenderManifest(buildExampleManifest())
    expect(sealed.manifest_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(verifyManifestSha256(sealed)).toBe(true)
  })

  it('survives a JSON roundtrip', () => {
    const sealed = sealRenderManifest(buildExampleManifest())
    const reparsed = JSON.parse(JSON.stringify(sealed))
    expect(verifyManifestSha256(reparsed)).toBe(true)
  })

  it('preserves unknown fields in the hash (forward compatibility)', () => {
    // Readers must hash the FULL parsed object including
    // fields they don't recognize. A writer that adds a new field gets a
    // different hash; that hash still verifies for a reader that ignores
    // the new field, as long as the reader hashes what's on disk.
    const sealedV1 = sealRenderManifest(buildExampleManifest())
    const v2WithExtra = {
      ...sealedV1,
      future_unknown_field: 'hello from v2',
      manifest_sha256: '',
    }
    delete (v2WithExtra as { manifest_sha256?: string }).manifest_sha256
    const sealedV2 = sealRenderManifest(
      v2WithExtra as Omit<RenderManifest, 'manifest_sha256'>,
    )

    // The two hashes differ — the unknown field is part of the canonical
    // form, so it authenticates.
    expect(sealedV2.manifest_sha256).not.toBe(sealedV1.manifest_sha256)
    // And the V2-sealed manifest still verifies (because the verifier
    // hashes whatever is on disk).
    expect(verifyManifestSha256(sealedV2)).toBe(true)
  })

  it('detects tampering of any field', () => {
    const sealed = sealRenderManifest(buildExampleManifest())
    const tampered = {
      ...sealed,
      render_params: { ...sealed.render_params, exposure_ev: 99.9 },
    }
    expect(verifyManifestSha256(tampered)).toBe(false)
  })

  it('detects tampering of an unknown field (the forward-compat guarantee)', () => {
    const v2 = {
      ...sealRenderManifest(buildExampleManifest()),
      future_unknown_field: 'original',
    } as Record<string, unknown>
    delete v2.manifest_sha256
    const sealedV2 = sealRenderManifest(
      v2 as Omit<RenderManifest, 'manifest_sha256'>,
    )
    const tampered = { ...sealedV2, future_unknown_field: 'mutated' }
    expect(verifyManifestSha256(tampered)).toBe(false)
  })

  it('rejects a manifest with no manifest_sha256 field', () => {
    const unsealed = buildExampleManifest() as object
    expect(verifyManifestSha256(unsealed)).toBe(false)
  })

  it('rejects a manifest_sha256 of the wrong shape', () => {
    expect(verifyManifestSha256({ manifest_sha256: 123 })).toBe(false)
    expect(verifyManifestSha256(null)).toBe(false)
    expect(verifyManifestSha256('not-an-object')).toBe(false)
  })
})
