import { Buffer } from 'node:buffer'

import type { Page } from '@playwright/test'

import { createCube, sha256 } from './files'

export const AUDIT_CATALOG_URL = 'https://example.com/catalog.json'
export const AUDIT_LOOK_TITLE = 'Audit Rec.709 Print'

/**
 * A one-LUT catalog on example.com whose entry declares its contract: an
 * S-Log3 input and a legal-range Rec.709 display output.
 */
export async function serveAuditCatalog(page: Page) {
  const cube = createCube('Catalog Fixture')
  const primaryAsset = {
    url: 'https://example.com/audit-rec709.cube',
    role: 'cube-lut',
    mediaType: 'application/x-cube-lut',
    sha256: sha256(cube),
    size: Buffer.byteLength(cube),
    title: AUDIT_LOOK_TITLE,
  }
  // Catalogs may still ship preview assets; the entries render without them.
  const previewAsset = {
    url: 'https://example.com/previews/audit-rec709.png',
    role: 'preview-image',
    mediaType: 'image/png',
    size: 68,
    title: AUDIT_LOOK_TITLE,
    width: 1,
    height: 1,
  }
  const row = {
    id: 'audit-rec709',
    kind: 'lut',
    version: '1.0.0',
    title: AUDIT_LOOK_TITLE,
    family: 'Print Film',
    license: 'CC0-1.0',
    redistributionAllowed: true,
    primaryAsset,
    previewAsset,
    entryUrl: 'https://example.com/entries/audit-rec709.json',
  }
  const entry = {
    ...row,
    schemaVersion: 1,
    format: 'cube',
    lut: {
      intent: 'combined-look-output',
      input: { gamut: 's-gamut3-cine', transfer: 's-log3', range: 'full' },
      output: { gamut: 'rec709', transfer: 'gamma24', range: 'legal' },
    },
  }
  await page.route(AUDIT_CATALOG_URL, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ schemaVersion: 1, entries: [row] }),
    }),
  )
  await page.route(row.entryUrl, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(entry),
    }),
  )
  await page.route(primaryAsset.url, (route) =>
    route.fulfill({ contentType: 'text/plain', body: cube }),
  )
}
