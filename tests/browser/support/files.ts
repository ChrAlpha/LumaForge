import type { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import type { Download, Page } from '@playwright/test'
import { expect } from '@playwright/test'

import { verifyManifestSha256 } from '../../../packages/render-engine/src/manifest/canonicalize'
import { downloadButton, exportButton, isMobile } from './lab'

/** The app writes every JPEG at this quality, full resolution or HQ. */
export const EXPORT_JPEG_QUALITY_PERCENT = 92

/**
 * A .cube at the smallest size the LUT parser accepts; `map` shapes every
 * channel and leaves it unchanged by default.
 */
export function createCube(
  title: string,
  map = (value: number) => value,
  size = 17,
) {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`]
  const step = 1 / (size - 1)
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        lines.push(
          `${map(r * step).toFixed(6)} ${map(g * step).toFixed(6)} ${map(b * step).toFixed(6)}`,
        )
      }
    }
  }
  return lines.join('\n')
}

/** Libjpeg's baseline luminance table, in natural order. */
const LIBJPEG_LUMINANCE_TABLE = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16,
  24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109,
  103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
]
/** Zigzag position -> natural index, the order DQT stores a table in. */
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40,
  48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29,
  22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54,
  47, 55, 62, 63,
]

/** The libjpeg quality whose scaled luminance table this one is, if any. */
function libjpegQuality(table: number[]) {
  for (let quality = 1; quality <= 100; quality += 1) {
    const scale = quality < 50 ? 5000 / quality : 200 - quality * 2
    const matches = ZIGZAG.every((natural, position) => {
      const expected = Math.min(
        255,
        Math.max(
          1,
          Math.floor((LIBJPEG_LUMINANCE_TABLE[natural]! * scale + 50) / 100),
        ),
      )
      return table[position] === expected
    })
    if (matches) return quality
  }
  return null
}

/** Frame size and luminance quantization read from the JPEG's markers. */
function readJpegFacts(bytes: Buffer) {
  expect(bytes.readUInt16BE(0), 'a JPEG starts with SOI').toBe(0xFFD8)
  let offset = 2
  let width = 0
  let height = 0
  let luminance: number[] | null = null
  while (offset + 4 <= bytes.length) {
    expect(bytes[offset], `JPEG marker at ${offset}`).toBe(0xFF)
    const marker = bytes[offset + 1]!
    const length = bytes.readUInt16BE(offset + 2)
    if (marker === 0xDB) {
      let table = offset + 4
      while (table < offset + 2 + length) {
        const precision = bytes[table]! >> 4
        const id = bytes[table]! & 0x0F
        const values: number[] = []
        for (let index = 0; index < 64; index += 1) {
          values.push(
            precision
              ? bytes.readUInt16BE(table + 1 + index * 2)
              : bytes[table + 1 + index]!,
          )
        }
        if (id === 0) luminance = values
        table += 1 + 64 * (precision ? 2 : 1)
      }
    }
    if (marker >= 0xC0 && marker <= 0xC2) {
      height = bytes.readUInt16BE(offset + 5)
      width = bytes.readUInt16BE(offset + 7)
    }
    if (marker === 0xDA) break
    offset += 2 + length
  }
  expect(width, 'the JPEG has a frame header').toBeGreaterThan(0)
  return {
    width,
    height,
    quality: luminance ? libjpegQuality(luminance) : null,
  }
}

export type JpegFile = {
  name: string
  path: string
  bytes: Buffer
  sha256: string
  width: number
  height: number
  quality: number | null
}

export function sha256(bytes: Buffer | string) {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function readJpegDownload(download: Download): Promise<JpegFile> {
  const path = await download.path()
  expect(path, 'the download lands on disk').toBeTruthy()
  const bytes = await readFile(path!)
  return {
    name: download.suggestedFilename(),
    path: path!,
    bytes,
    sha256: sha256(bytes),
    ...readJpegFacts(bytes),
  }
}

/** Downloads the current result's JPEG from the export surface. */
export async function downloadJpeg(page: Page) {
  await expect(downloadButton(page)).toBeEnabled({ timeout: 240_000 })
  const downloading = page.waitForEvent('download')
  await downloadButton(page).click()
  return readJpegDownload(await downloading)
}

export type ExportManifest = {
  kind: string
  manifest_sha256: string
  policy: { kind: string }
  source_raw: {
    filename: string
    sha256: string
    byte_size: number
    decoded_dimensions: { width: number; height: number }
  }
  output: {
    sha256: string
    filename: string
    quality: number
    dimensions: { width: number; height: number }
  }
  render_params: {
    intensity?: number
    raw_render_exposure_ev?: number
    raw_render_exposure_source?: string
    geometry?: {
      matrix: number[]
      constrain_crop: boolean
      output: { width: number; height: number }
    }
  }
  lut: unknown
  environment: {
    native_artifacts: { build_id: string; variant: 'desktop' | 'low-memory' }
  }
}

/**
 * Downloads the current result's render manifest from the export surface:
 * its hash verifies over the whole file and it records an export.
 */
export async function downloadManifest(page: Page) {
  // Mobile names the action in full; the desktop result row says Manifest.
  const button = exportButton(
    page,
    isMobile(page) ? 'Download render manifest (JSON)' : 'Manifest',
  )
  await expect(button).toBeEnabled({ timeout: 180_000 })
  const downloading = page.waitForEvent('download')
  await button.click()
  const download = await downloading
  expect(download.suggestedFilename()).toMatch(/\.manifest\.json$/)
  const path = (await download.path())!
  const text = await readFile(path, 'utf8')
  const manifest = JSON.parse(text) as ExportManifest
  expect(verifyManifestSha256(manifest)).toBe(true)
  expect(manifest.kind).toBe('export')
  return { manifest, path, sha256: sha256(text) }
}

/** The pixel size of a JPEG as this browser decodes it. */
export async function decodedJpegSize(page: Page, jpeg: Buffer) {
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: 'image/jpeg' }),
    )
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return size
  }, jpeg.toString('base64'))
}
