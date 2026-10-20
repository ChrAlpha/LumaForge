import { Buffer } from 'node:buffer'

import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

import { downloadJpeg, downloadManifest } from './support/files'
import { dngFile, PUBLIC_DNG_SIZE } from './support/fixtures'
import {
  chooseRaw,
  exportFullResolution,
  exportSurface,
  openLab,
  openTool,
  waitForLoaded,
} from './support/lab'

const ISO_21496_URN = 'urn:iso:std:iso:ts:21496:-1\0'
const MP_ENTRY_TAG = 0xB0_02

type Segment = { marker: number; start: number; end: number; payload: Buffer }

/** The marker segments of the JPEG starting at `start`, up to its scan. */
function headerSegments(bytes: Buffer, start = 0): Segment[] {
  expect(bytes.readUInt16BE(start), 'an image starts with SOI').toBe(0xFF_D8)
  const segments: Segment[] = []
  let offset = start + 2
  while (bytes[offset] === 0xFF && bytes[offset + 1] !== 0xDA) {
    const marker = bytes[offset + 1]
    const end = offset + 2 + bytes.readUInt16BE(offset + 2)
    segments.push({
      marker,
      start: offset,
      end,
      payload: bytes.subarray(offset + 4, end),
    })
    offset = end
  }
  return segments
}

function app2(segments: Segment[], identifier: string) {
  return segments.filter(
    (segment) =>
      segment.marker === 0xE2 &&
      segment.payload.toString('latin1', 0, identifier.length) === identifier,
  )
}

/** The images the primary's MPF index lists, read through its TIFF IFD. */
function mpEntries(jpeg: Buffer) {
  const [mpf] = app2(headerSegments(jpeg), 'MPF\0')
  expect(mpf, 'the primary carries an MPF index').toBeTruthy()
  const tiff = mpf.start + 8
  const bigEndian = jpeg.toString('latin1', tiff, tiff + 2) === 'MM'
  const u16 = (at: number) =>
    bigEndian ? jpeg.readUInt16BE(at) : jpeg.readUInt16LE(at)
  const u32 = (at: number) =>
    bigEndian ? jpeg.readUInt32BE(at) : jpeg.readUInt32LE(at)
  const ifd = tiff + u32(tiff + 4)
  for (let index = 0; index < u16(ifd); index++) {
    const entry = ifd + 2 + index * 12
    if (u16(entry) !== MP_ENTRY_TAG) continue
    const at = tiff + u32(entry + 8)
    return Array.from({ length: u32(entry + 4) / 16 }, (_, image) => ({
      size: u32(at + image * 16 + 4),
      // The first image's offset is 0; the others count from the TIFF header.
      start: image === 0 ? 0 : tiff + u32(at + image * 16 + 8),
    }))
  }
  throw new Error('the MPF index lists no images')
}

/** The JPEG without the APP2 segments its header carries. */
function withoutApp2(jpeg: Buffer) {
  const kept: Buffer[] = [jpeg.subarray(0, 2)]
  const segments = headerSegments(jpeg)
  for (const segment of segments) {
    if (segment.marker !== 0xE2)
      kept.push(jpeg.subarray(segment.start, segment.end))
  }
  kept.push(jpeg.subarray(segments.at(-1)!.end))
  return Buffer.concat(kept)
}

function hdrOption(page: Page) {
  return exportSurface(page).getByRole('checkbox', { name: 'HDR gain map' })
}

test('HDR gain map export: the SDR JPEG unchanged, its gain map indexed beside it', async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(600_000)
  const raw = await dngFile(testInfo, 'hdr.dng')
  await openLab(page, testInfo)
  await chooseRaw(page, raw)
  await waitForLoaded(page, raw.name)
  await openTool(page, 'Export')
  await expect(hdrOption(page)).not.toBeChecked()
  await exportFullResolution(page)
  const sdr = await downloadJpeg(page)
  // The plain export carries no gain map and no index for one.
  expect(app2(headerSegments(sdr.bytes), 'MPF\0')).toEqual([])

  // The same file again, with the gain map asked for.
  await page.reload()
  await chooseRaw(page, raw)
  await waitForLoaded(page, raw.name)
  await openTool(page, 'Export')
  await hdrOption(page).check()
  await expect(hdrOption(page)).toBeChecked()
  await expect(
    exportSurface(page).getByText(/HDR screens show highlights/),
  ).toBeVisible()
  await exportFullResolution(page)
  const hdr = await downloadJpeg(page)
  const { manifest } = await downloadManifest(page)

  expect({ width: hdr.width, height: hdr.height }).toEqual(PUBLIC_DNG_SIZE)
  const [primary, gainMap] = mpEntries(hdr.bytes)
  expect(primary.size + gainMap.size).toBe(hdr.bytes.length)
  expect(gainMap.start).toBe(primary.size)
  // Both images name ISO 21496-1: the primary its version, the gain map its
  // metadata.
  expect(app2(headerSegments(hdr.bytes), ISO_21496_URN)).toHaveLength(1)
  expect(
    app2(headerSegments(hdr.bytes, gainMap.start), ISO_21496_URN),
  ).toHaveLength(1)
  // The primary is the SDR export byte for byte once its APP2 segments go.
  expect(
    withoutApp2(hdr.bytes.subarray(0, primary.size)).equals(sdr.bytes),
  ).toBe(true)
  expect(manifest.output.sha256).toBe(hdr.sha256)
  expect(manifest.output.hdr_gain_map).toEqual({
    format: 'iso-21496-1',
    gamut: 'rec2020',
    reference_white_nits: 203,
    nominal_peak_nits: 1000,
    quality: 98,
  })
})
