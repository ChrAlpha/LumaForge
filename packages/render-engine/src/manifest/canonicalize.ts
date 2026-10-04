// Canonical-JSON + manifest_sha256.
//
// Canonical form rules:
//   1. Object keys sorted lexicographically at every nesting level.
//   2. Numbers serialized via JSON.stringify defaults (IEEE 754 doubles).
//   3. Strings JSON-escaped via default JSON.stringify.
//   4. No trailing newlines, no whitespace.
//   5. `undefined`-valued fields are OMITTED, never serialized as null.
//      Explicit `null` is preserved (e.g. `parent_manifest_sha256`).
//
// Reader contract: recompute the canonical hash over the FULL parsed JSON
// object — including fields the consumer's typed interface doesn't
// recognize — so future-added fields authenticate forward-compatibly.

import type { RenderManifest } from './render-manifest'
import { createStreamingSha256 } from './streaming-sha256'

const MANIFEST_SHA256_KEY = 'manifest_sha256'

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

/**
 * Produce the canonical JSON string per the rules above. The output is a
 * UTF-8-encodable string suitable for hashing.
 *
 * Non-finite numbers (NaN, Infinity) and BigInts throw — JSON cannot
 * represent them, so silently coercing would lose round-trip safety.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) {
    throw new TypeError(
      'canonicalizeJson: top-level undefined is not representable',
    )
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `canonicalizeJson: non-finite number is not representable: ${String(value)}`,
      )
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'bigint') {
    throw new TypeError('canonicalizeJson: BigInt is not representable in JSON')
  }
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (const item of value) {
      // Arrays preserve order; undefined holes become null per JSON.stringify
      // convention (we follow JSON's array semantics here).
      parts.push(item === undefined ? 'null' : canonicalizeJson(item))
    }
    return `[${parts.join(',')}]`
  }
  if (typeof value === 'object') {
    const obj = value as { [key: string]: unknown }
    const keys = Object.keys(obj).sort()
    const parts: string[] = []
    for (const key of keys) {
      const v = obj[key]
      if (v === undefined) continue
      parts.push(`${JSON.stringify(key)}:${canonicalizeJson(v)}`)
    }
    return `{${parts.join(',')}}`
  }
  throw new TypeError(
    `canonicalizeJson: unsupported value type ${typeof value}`,
  )
}

// ---------------------------------------------------------------------------
// manifest_sha256 computation + verification
// ---------------------------------------------------------------------------

const TEXT_ENCODER = new TextEncoder()

function sha256HexOfString(input: string): string {
  return createStreamingSha256().update(TEXT_ENCODER.encode(input)).digestHex()
}

/**
 * The canonical hash of `manifest`, computed over a copy with the
 * `manifest_sha256` field removed (whether or not it was present).
 *
 * Accepts a manifest-shaped object (the typed `RenderManifest`) OR an
 * already-parsed JSON object that may carry unknown fields (forward
 * compatibility). Readers must hash the FULL parsed object
 * including unknown fields before projecting onto a typed interface.
 */
export function computeManifestSha256(manifest: object): string {
  const stripped: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(manifest)) {
    if (key === MANIFEST_SHA256_KEY) continue
    stripped[key] = value
  }
  return sha256HexOfString(canonicalizeJson(stripped))
}

/**
 * Given a `RenderManifest` shape WITHOUT the `manifest_sha256` field
 * populated, return a sealed copy with `manifest_sha256` set to the
 * computed value.
 *
 * Callers MUST pass a manifest that is complete except for
 * `manifest_sha256`. Passing a previously-sealed manifest is allowed; the
 * old hash is recomputed.
 */
export function sealRenderManifest(
  unsealed: Omit<RenderManifest, 'manifest_sha256'> &
    Partial<Pick<RenderManifest, 'manifest_sha256'>>,
): RenderManifest {
  const sha256 = computeManifestSha256(unsealed)
  return { ...unsealed, manifest_sha256: sha256 } as RenderManifest
}

/**
 * Verify the `manifest_sha256` field of a parsed manifest. Returns `true`
 * iff the recomputed canonical hash matches the embedded one.
 *
 * Accepts `unknown` so callers can call it on freshly-parsed JSON before
 * projecting onto their typed interface (the recommended order).
 */
export function verifyManifestSha256(manifest: unknown): boolean {
  if (typeof manifest !== 'object' || manifest === null) return false
  const obj = manifest as Record<string, unknown>
  const claimed = obj[MANIFEST_SHA256_KEY]
  if (typeof claimed !== 'string') return false
  const recomputed = computeManifestSha256(obj)
  return recomputed === claimed
}

export const __TEST_ONLY__ = { sha256HexOfString }
