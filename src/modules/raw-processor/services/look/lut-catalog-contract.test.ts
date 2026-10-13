import { describe, expect, it } from 'vitest'

import { parseReleaseCatalog } from '~/lib/profiles/catalog'

import {
  DEFAULT_LUMAFORGE_PROFILE_SOURCE,
  ONLINE_LUT_MAX_JSON_BYTES,
} from './online-lut-sources'

// Cross-repo boundary contract.
//
// The calibration mass-ingestion grew the flat channels/stable/catalog.json
// past the bounded LUT fetch budget (online-lut-sources defaultMaxJsonBytes,
// 1 MB), which broke online LUT sources with a `size-limit` error. The
// producer now publishes a LUT-scoped catalog, mirroring the scoped
// calibration root:
//   lumaforge-profiles/src/release/lut-catalog.ts → buildLutCatalogDocument
//   key: releases/<tag>/luts/catalog.json + channels/<ch>/luts/catalog.json
// It is the same release-catalog document shape, filtered to `kind: "lut"`,
// and the producer fails its build closed if the scoped document ever exceeds
// the 1 MB client budget (LUT_CATALOG_MAX_BYTES). The mirrored producer-side
// assertions live in lumaforge-profiles/test/s3-build.test.ts.
//
// If this test breaks, the two repos' LUT catalog standard has drifted.
const SOURCE_URL =
  'https://luma-prof.example.com/channels/stable/luts/catalog.json'

const LUT_ENTRY = {
  id: 'org.lumaforge.lut.3110-film-a-logc3-rec709',
  kind: 'lut',
  format: 'cube',
  version: '1.0.0',
  title: '3110 Film A',
  license: 'CC0-1.0',
  redistributionAllowed: true,
  targets: {},
  primaryAsset: {
    role: 'cube-lut',
    mediaType: 'application/x-cube-lut',
    size: 1401558,
    sha256: 'd34da52b88ca3ff7d5de6de00eb9ff182716043c55b5cd260a5c6e5816ef98cc',
    url: 'https://luma-prof.example.com/blobs/sha256/d3/4d/d34da52b88ca3ff7d5de6de00eb9ff182716043c55b5cd260a5c6e5816ef98cc.cube',
  },
  entryUrl:
    'https://luma-prof.example.com/releases/v2026.06.09/entries/org.lumaforge.lut.3110-film-a-logc3-rec709.json',
  family: 'arri-look-library',
}

const CALIBRATION_ENTRY = {
  id: 'org.lumaforge.camera.nikon-z-7-adobe-standard',
  kind: 'camera-profile',
  format: 'dcp',
  version: '1.0.0',
  title: 'NIKON Z 7 Adobe Standard',
  license: 'CC0-1.0',
  redistributionAllowed: true,
  targets: { cameraMakers: ['Nikon'], cameraModels: ['NIKON Z 7'] },
  primaryAsset: {
    role: 'dcp',
    mediaType: 'application/x-adobe-dng-camera-profile',
    size: 120686,
    sha256: 'f1380b923a9e3986115cf0d9f4249be5e8cbe9aff35e7414e71c370ed4fb9ae6',
    url: 'https://luma-prof.example.com/blobs/sha256/f1/38/f1380b923a9e3986115cf0d9f4249be5e8cbe9aff35e7414e71c370ed4fb9ae6.dcp',
  },
  entryUrl:
    'https://luma-prof.example.com/releases/v2026.06.09/entries/org.lumaforge.camera.nikon-z-7-adobe-standard.json',
}

function buildS3LutCatalog(entries: unknown[]) {
  return {
    schemaVersion: 1,
    id: 'org.lumaforge.profiles',
    title: 'LumaForge Profiles',
    description: '',
    tag: 'v2026.06.09',
    generatedAt: '2026-06-09T00:00:00.000Z',
    publicBaseUrl: 'https://luma-prof.example.com',
    entries,
  }
}

describe('lut catalog cross-repo contract (lumaforge-profiles build-s3)', () => {
  it('keeps the default LUT source on the scoped LUT catalog, not the full catalog', () => {
    // The full channels/stable/catalog.json carries thousands of calibration
    // entries and exceeds the bounded LUT fetch; the default LUT source must
    // stay channel-pinned on the producer's scoped luts/catalog.json.
    // The `luts/catalog.json` path segment mirrors the producer's
    // LUT_CATALOG_RELATIVE_PATH and the channels/<ch>/luts/catalog.json key
    // locked in lumaforge-profiles test/s3-publisher.test.ts.
    expect(DEFAULT_LUMAFORGE_PROFILE_SOURCE.url).toBe(
      'https://luma-prof.ichr.me/channels/stable/luts/catalog.json',
    )
    expect(DEFAULT_LUMAFORGE_PROFILE_SOURCE.type).toBe('catalog')
  })

  it('locks the 1 MB fetch budget the producer build fails closed against', () => {
    // Mirrors LUT_CATALOG_MAX_BYTES in lumaforge-profiles
    // src/release/lut-catalog.ts (locked there by test/s3-build.test.ts).
    // Changing either side alone breaks that side's contract test.
    expect(ONLINE_LUT_MAX_JSON_BYTES).toBe(1_000_000)
  })

  it('parses the producer LUT-scoped catalog entry shape', () => {
    const result = parseReleaseCatalog(
      buildS3LutCatalog([LUT_ENTRY]),
      SOURCE_URL,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const [entry] = result.value
    expect(entry).toMatchObject({
      id: 'org.lumaforge.lut.3110-film-a-logc3-rec709',
      title: '3110 Film A',
      sourceType: 'catalog-entry',
      sourceUrl: LUT_ENTRY.entryUrl,
      family: 'arri-look-library',
      cube: {
        url: LUT_ENTRY.primaryAsset.url,
        sha256: LUT_ENTRY.primaryAsset.sha256,
        bytes: LUT_ENTRY.primaryAsset.size,
      },
    })
  })

  it('still tolerates a mixed catalog by keeping only its LUT entries', () => {
    const result = parseReleaseCatalog(
      buildS3LutCatalog([CALIBRATION_ENTRY, LUT_ENTRY]),
      SOURCE_URL,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.map((entry) => entry.id)).toEqual([LUT_ENTRY.id])
  })
})
