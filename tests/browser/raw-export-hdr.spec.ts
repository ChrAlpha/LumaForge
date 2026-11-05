import { Buffer } from 'node:buffer'
import { writeFile } from 'node:fs/promises'

import type { Page, TestInfo } from '@playwright/test'
import { expect, test } from '@playwright/test'

import { createCube, downloadJpeg, downloadManifest } from './support/files'
import { dngFile, PUBLIC_DNG_SIZE } from './support/fixtures'
import { readCanvas } from './support/frames'
import {
  chooseRaw,
  cpuCanvas,
  exportFullResolution,
  exportSurface,
  isChromium,
  openLab,
  openTool,
  previewFrame,
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

const PHOTO_ONLY_STYLE = `
  .raw-lab-compare-handle, .raw-lab-compare-label, [data-mobile-lab-chrome],
  [data-mobile-compare-lens], [data-sonner-toaster] {
    visibility: hidden !important;
  }
`

/**
 * The photo's mean light, 0-255: the CPU canvas as drawn, or the WebGPU
 * stage as the page composites it, since a presented WebGPU canvas cannot
 * be read back from script.
 */
async function photoLight(page: Page, testInfo: TestInfo) {
  if (!isChromium(testInfo))
    return (await readCanvas(cpuCanvas(page))).meanLight
  const png = await previewFrame(page).screenshot({
    animations: 'disabled',
    style: PHOTO_ONLY_STYLE,
  })
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: 'image/png' }),
    )
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height)
    let sum = 0
    for (let index = 0; index < data.length; index += 4)
      sum +=
        0.2126 * data[index] +
        0.7152 * data[index + 1] +
        0.0722 * data[index + 2]
    return sum / (data.length / 4)
  }, png.toString('base64'))
}

test('HDR preview views: chosen beside the option, drawn on the photo, SDR again once it goes off', async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(300_000)
  const raw = await dngFile(testInfo, 'hdr-preview.dng')
  await openLab(page, testInfo)
  await chooseRaw(page, raw)
  await waitForLoaded(page, raw.name)
  await openTool(page, 'Export')
  await hdrOption(page).check()

  const views = exportSurface(page).getByRole('group', { name: 'HDR preview' })
  const view = (name: string) =>
    views.getByRole('button', { name, exact: true })
  // A headless screen reports no high dynamic range, so the preview offers
  // the views any screen shows and opens on the SDR picture.
  await expect(views.getByRole('button')).toHaveText([
    'SDR',
    'Above SDR',
    'Stop down',
  ])
  await expect(view('SDR')).toHaveAttribute('aria-pressed', 'true')
  const sdr = await photoLight(page, testInfo)
  await page.screenshot({ path: testInfo.outputPath('hdr-preview-sdr.png') })

  await view('Stop down').click()
  await expect(view('Stop down')).toHaveAttribute('aria-pressed', 'true')
  await expect(exportSurface(page).getByText(/2\.3 stops darker/)).toBeVisible()
  await expect.poll(() => photoLight(page, testInfo)).toBeLessThan(sdr - 8)
  await page.screenshot({
    path: testInfo.outputPath('hdr-preview-stop-down.png'),
  })

  await view('Above SDR').click()
  await expect(view('Above SDR')).toHaveAttribute('aria-pressed', 'true')
  await expect(exportSurface(page).getByText(/amber to magenta/)).toBeVisible()
  await expect
    .poll(async () => Math.abs((await photoLight(page, testInfo)) - sdr))
    .toBeGreaterThan(4)
  await page.screenshot({
    path: testInfo.outputPath('hdr-preview-above-sdr.png'),
  })

  // Off, the views go with the option and the photo is the SDR picture.
  await hdrOption(page).uncheck()
  await expect(views).toHaveCount(0)
  await expect
    .poll(async () => Math.abs((await photoLight(page, testInfo)) - sdr))
    .toBeLessThan(0.5)
})

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

test('HDR gain map export over a LUT that outputs PQ', async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(600_000)
  const raw = await dngFile(testInfo, 'hdr-pq.dng')
  // A Rec.2100 PQ to PQ LUT that keeps the signal, its contract declared in
  // the file.
  const cubePath = testInfo.outputPath('rec2100-pq.cube')
  await writeFile(
    cubePath,
    [
      '# LUMAFORGE_ROLE=combined-look-output',
      '# LUMAFORGE_INPUT_PROFILE=rec2100-pq',
      '# LUMAFORGE_OUTPUT_GAMUT=rec2020',
      '# LUMAFORGE_OUTPUT_TRANSFER=pq',
      '# LUMAFORGE_OUTPUT_RANGE=full',
      createCube('Rec.2100 PQ identity'),
    ].join('\n'),
    'utf8',
  )
  await openLab(page, testInfo)
  await chooseRaw(page, raw)
  await waitForLoaded(page, raw.name)
  await page
    .locator('input[type="file"][accept=".cube"]')
    .first()
    .setInputFiles(cubePath)
  await openTool(page, 'Export')
  await hdrOption(page).check()
  await expect(hdrOption(page)).toBeChecked()
  await exportFullResolution(page)
  const hdr = await downloadJpeg(page)
  const { manifest } = await downloadManifest(page)

  const [primary, gainMap] = mpEntries(hdr.bytes)
  expect(primary.size + gainMap.size).toBe(hdr.bytes.length)
  expect(
    app2(headerSegments(hdr.bytes, gainMap.start), ISO_21496_URN),
  ).toHaveLength(1)
  expect(manifest.output.sha256).toBe(hdr.sha256)
  expect(manifest.output.hdr_gain_map).toMatchObject({ gamut: 'rec2020' })
  expect(manifest.color_graph.descriptor.steps.at(-2)).toMatchObject({
    kind: 'lut-hdr-output-to-srgb',
    transfer: 'pq',
    toneMap: 'bt2390-eetf-maxrgb',
  })
})
