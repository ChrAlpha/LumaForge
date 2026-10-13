import { readFile } from 'node:fs/promises'

import type { Page } from '@playwright/test'
import { devices, expect, test } from '@playwright/test'

import type { JpegFile } from './support/files'
import { downloadJpeg, downloadManifest, sha256 } from './support/files'
import { gateRawFixture, LARGE_RAF, SONY_ARW } from './support/fixtures'
import {
  chooseRaw,
  downloadButton,
  expectWebGPUPreview,
  exportAction,
  exportSurface,
  fullExportButton,
  gpuCanvas,
  hqExportButton,
  isChromium,
  isMobile,
  loadedLab,
  nudgeExposure,
  openLab,
  openTool,
  restoreButton,
} from './support/lab'
import type { ExportDebugEvent } from './support/trace'
import { eventIndex, eventPayload, readTrace } from './support/trace'

// Acceptance on large private RAWs: each test needs its own camera file
// (named by its variable; see support/fixtures.ts) for the plan, output size,
// aspect or resource load it expects, skips as optional private coverage
// without it, and fails without it under LUMAFORGE_REQUIRE_PRIVATE_FIXTURES=1.

/** Owners an export evacuates before its worker starts, in order. */
const PRE_EXPORT_OWNERS = [
  'preview',
  'bounded-hq',
  'gpu',
  'export-result',
  'lut-fetch',
]

async function exportEvents(page: Page) {
  return (await readTrace(page)).exportEvents
}

async function bodyText(page: Page) {
  return (await page.locator('body').textContent()) ?? ''
}

/**
 * Waits until the full-resolution export can start, or the browser says it
 * cannot run it here, and skips with the reason the browser gave.
 */
async function waitForFullExportOrSkip(page: Page, timeout: number) {
  if (isMobile(page)) {
    // Export is a topbar action that stays off while the pipeline is busy.
    await expect(exportAction(page)).toBeEnabled({ timeout: 120_000 })
  }
  await openTool(page, 'Export')
  const unsupported = /not available in this browser build/i
  const failClosed =
    /cannot safely complete this large local full-resolution export/i
  await expect
    .poll(
      async () => {
        const text = await bodyText(page)
        if (unsupported.test(text)) return 'unsupported'
        if (failClosed.test(text)) return 'fail-closed'
        return (await fullExportButton(page).isEnabled()) ? 'ready' : 'waiting'
      },
      { timeout },
    )
    .toMatch(/ready|unsupported|fail-closed/)
  const text = await bodyText(page)
  test.skip(
    unsupported.test(text),
    'Processed-window export is unavailable in this browser build.',
  )
  test.skip(
    failClosed.test(text),
    'This browser correctly failed closed for a large local full-resolution export without durable file storage.',
  )
}

function expectNoRecoveryJournal(events: ExportDebugEvent[]) {
  expect(events.map((event) => event.type)).not.toContain('checkpoint-written')
}

test('desktop HQ preview JPEG: an 8–12MP 3:2 file from the Sony ARW, beside the full-resolution export', async ({
  page,
}, testInfo) => {
  test.skip(
    !isChromium(testInfo),
    'HQ preview export acceptance uses desktop Chromium download APIs',
  )
  // The 8-12MP, 3:2 output bounds need the Sony ARW's size and aspect.
  const rawPath = gateRawFixture(testInfo, SONY_ARW)
  testInfo.setTimeout(240_000)
  await openLab(page, testInfo, { surface: 'desktop' })
  await chooseRaw(page, rawPath)
  await expect(loadedLab(page)).toBeVisible({ timeout: 90_000 })
  await expectWebGPUPreview(page, testInfo)

  await expect(fullExportButton(page)).toBeVisible()
  await expect(hqExportButton(page)).toBeEnabled({ timeout: 90_000 })
  await hqExportButton(page).click()
  await expect(
    exportSurface(page).getByText('HQ preview JPEG ready'),
  ).toBeVisible({ timeout: 90_000 })
  const jpeg = await downloadJpeg(page)
  expect(jpeg.name).toContain('_hq-preview.jpg')
  const megapixels = jpeg.width * jpeg.height
  expect(megapixels).toBeGreaterThanOrEqual(8_000_000)
  expect(megapixels).toBeLessThanOrEqual(12_000_000)
  expect(jpeg.width / jpeg.height).toBeCloseTo(1.5, 1)
  await expectWebGPUPreview(page, testInfo)
})

test('preflight: the 100MP RAF selects each project’s expected export plan before the export runs', async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(240_000)
  const rawPath = gateRawFixture(testInfo, LARGE_RAF)
  const expected = isChromium(testInfo)
    ? {
        preferredRows: [256],
        concurrency: 2,
        runtimeMemoryProfile: 'desktop',
        derivedLabelFragment: 'wkchromium',
      }
    : {
        preferredRows: [64, 128],
        concurrency: 1,
        runtimeMemoryProfile: 'low-memory',
        derivedLabelFragment: 'wkwebkit-mobile',
      }
  await openLab(page, testInfo)
  await chooseRaw(page, rawPath)
  await waitForFullExportOrSkip(page, 120_000)
  await fullExportButton(page).click()

  const required = [
    'export-plan-selected',
    'resource-evacuated',
    'export-worker-attempt',
  ]
  await expect
    .poll(async () => {
      const types = new Set(
        (await exportEvents(page)).map((event) => event.type),
      )
      return required.every((type) => types.has(type))
    })
    .toBe(true)
  const events = await exportEvents(page)
  const plan = eventPayload(events, 'export-plan-selected')!
  expect(plan).toMatchObject({
    concurrency: expected.concurrency,
    runtimeMemoryProfile: expected.runtimeMemoryProfile,
    checkpointMode: 'safe-retry',
    outputSink: 'opfs-file',
    policyVector: {
      workerMemoryProfile: expected.runtimeMemoryProfile,
      concurrency: expected.concurrency,
      outputSink: 'opfs-file',
    },
  })
  expect(expected.preferredRows).toContain(plan.preferredRows)
  expect(expected.preferredRows).toContain(
    (plan.policyVector as { rowSlice?: unknown }).rowSlice,
  )
  expect(plan.derivedLabel).toEqual(
    expect.stringContaining(expected.derivedLabelFragment),
  )
  const evacuated = eventPayload(events, 'resource-evacuated')!
  expect(evacuated).toMatchObject({ registryCheck: { ok: true } })
  expect(evacuated.requiredOwners).toEqual(PRE_EXPORT_OWNERS)
  expect(evacuated.remainingLive).toEqual([])
  expect(eventPayload(events, 'export-worker-attempt')).toMatchObject({
    attempt: 1,
    phase: 'started',
    freshWorker: true,
  })
  // The OPFS sink keeps its output address but writes no recovery journal.
  expectNoRecoveryJournal(events)
})

/** Row means along the bottom of a decoded JPEG, and how much they jump. */
async function bottomBandStats(page: Page, jpeg: JpegFile) {
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: 'image/jpeg' }),
    )
    const sourceWidth = bitmap.width
    const sourceHeight = bitmap.height
    const width = Math.min(1024, sourceWidth)
    const height = Math.max(1, Math.round((sourceHeight / sourceWidth) * width))
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    context.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()

    const sampledRows = Math.min(96, height)
    const pixels = context.getImageData(
      0,
      height - sampledRows,
      width,
      sampledRows,
    ).data
    const means: Array<[number, number, number]> = []
    for (let row = 0; row < sampledRows; row += 1) {
      const sum: [number, number, number] = [0, 0, 0]
      for (let x = 0; x < width; x += 1) {
        const offset = (row * width + x) * 4
        sum[0] += pixels[offset]!
        sum[1] += pixels[offset + 1]!
        sum[2] += pixels[offset + 2]!
      }
      means.push([sum[0] / width, sum[1] / width, sum[2] / width])
    }
    const delta = (
      left: [number, number, number],
      right: [number, number, number],
    ) =>
      Math.max(
        Math.abs(left[0] - right[0]),
        Math.abs(left[1] - right[1]),
        Math.abs(left[2] - right[2]),
      )
    const average = (start: number, end: number): [number, number, number] => {
      const sum: [number, number, number] = [0, 0, 0]
      for (let row = start; row < end; row += 1) {
        sum[0] += means[row]![0]
        sum[1] += means[row]![1]
        sum[2] += means[row]![2]
      }
      const count = end - start
      return [sum[0] / count, sum[1] / count, sum[2] / count]
    }
    let maxAdjacentDelta = 0
    for (let row = 1; row < means.length; row += 1) {
      maxAdjacentDelta = Math.max(
        maxAdjacentDelta,
        delta(means[row - 1]!, means[row]!),
      )
    }
    const terminalRows = Math.min(12, Math.floor(sampledRows / 4))
    return {
      sourceWidth,
      sourceHeight,
      maxAdjacentDelta,
      terminalDelta: delta(
        average(sampledRows - terminalRows * 2, sampledRows - terminalRows),
        average(sampledRows - terminalRows, sampledRows),
      ),
    }
  }, jpeg.bytes.toString('base64'))
}

test.describe('as an iPhone', () => {
  const iPhone = devices['iPhone 14 Pro']
  test.use({
    viewport: iPhone.viewport,
    userAgent: iPhone.userAgent,
    deviceScaleFactor: iPhone.deviceScaleFactor,
    isMobile: iPhone.isMobile,
    hasTouch: iPhone.hasTouch,
  })

  test('low-memory export of the Sony ARW decodes without a bottom color band, and its manifest names the file', async ({
    page,
  }, testInfo) => {
    // The decoded size and bottom-band limits below belong to the Sony ARW.
    const rawPath = gateRawFixture(testInfo, SONY_ARW)
    testInfo.setTimeout(600_000)
    await openLab(page, testInfo)
    await chooseRaw(page, rawPath)
    await waitForFullExportOrSkip(page, 180_000)
    await fullExportButton(page).click()

    await expect
      .poll(
        async () => {
          const plan = eventPayload(
            await exportEvents(page),
            'export-plan-selected',
          )
          return {
            runtimeMemoryProfile: plan?.runtimeMemoryProfile,
            outputSink: plan?.outputSink,
            checkpointMode: plan?.checkpointMode,
            derivedLabel: plan?.derivedLabel,
            workerMemoryProfile: (
              plan?.policyVector as
                | { workerMemoryProfile?: unknown }
                | undefined
            )?.workerMemoryProfile,
          }
        },
        { timeout: 60_000 },
      )
      .toMatchObject({
        runtimeMemoryProfile: 'low-memory',
        outputSink: 'opfs-file',
        checkpointMode: 'safe-retry',
        derivedLabel: expect.stringContaining('wkwebkit-mobile'),
        workerMemoryProfile: 'low-memory',
      })

    await expect(downloadButton(page)).toBeVisible({ timeout: 420_000 })
    const jpeg = await downloadJpeg(page)
    const stats = await bottomBandStats(page, jpeg)
    expect(stats).toMatchObject({ sourceWidth: 9566, sourceHeight: 6374 })
    expect(stats.maxAdjacentDelta).toBeLessThan(48)
    expect(stats.terminalDelta).toBeLessThan(18)

    // OPFS-backed output is hashed by the worker as it is written, so the
    // manifest must identify the downloaded JPEG without reopening the file.
    const { manifest } = await downloadManifest(page)
    expect(manifest.output.sha256).toBe(jpeg.sha256)
    expect(manifest.environment.native_artifacts.variant).toBe('low-memory')
  })
})

/**
 * The plan a large desktop export selects is one coherent policy: the
 * vector it reports mirrors the plan, its rows and workers are in range, it
 * never gives up, and its label names the rows and the sink.
 */
function expectCoherentPlan(plan: Record<string, unknown>) {
  expect(plan).toMatchObject({ checkpointMode: 'safe-retry' })
  const vector = plan.policyVector as Record<string, unknown>
  expect(vector).toMatchObject({
    workerMemoryProfile: plan.runtimeMemoryProfile,
    concurrency: plan.concurrency,
    outputSink: plan.outputSink,
    rowSlice: plan.preferredRows,
  })
  expect(['desktop', 'low-memory']).toContain(plan.runtimeMemoryProfile)
  expect(['opfs-file', 'streaming', 'blob-handoff']).toContain(plan.outputSink)
  const concurrency = Number(plan.concurrency)
  const rows = Number(plan.preferredRows)
  expect(concurrency).toBeGreaterThanOrEqual(1)
  expect(rows).toBeGreaterThanOrEqual(64)
  expect(rows).toBeLessThanOrEqual(2048)
  expect([
    'high-performance',
    'safe-export',
    'resource-retry',
    'interrupted-retry',
    'non-durable-checkpoint',
  ]).toContain(vector.productCopy)
  if (vector.productCopy === 'high-performance') {
    expect(plan.runtimeMemoryProfile).toBe('desktop')
    expect(concurrency).toBeGreaterThanOrEqual(2)
    expect(rows).toBeGreaterThanOrEqual(512)
  }
  expect(plan.derivedLabel).toEqual(expect.stringContaining(`rs${rows}`))
  expect(plan.derivedLabel).toEqual(
    expect.stringContaining(`-${String(plan.outputSink)}-`),
  )
}

test('desktop export of the Sony ARW: a coherent plan, the preview evacuated before the worker, Restore keeps the result, the manifest names the bytes, and Reset disposes it', async ({
  page,
}, testInfo) => {
  test.skip(
    !isChromium(testInfo),
    'The desktop export lifecycle uses Chromium and origin-private storage',
  )
  // A large export is what the plan and the evacuation are sized for.
  const rawPath = gateRawFixture(testInfo, SONY_ARW)
  testInfo.setTimeout(600_000)
  await openLab(page, testInfo, { surface: 'desktop' })
  await chooseRaw(page, rawPath)
  await expect(loadedLab(page)).toBeVisible({ timeout: 90_000 })
  await expect(fullExportButton(page)).toBeEnabled({ timeout: 90_000 })
  await nudgeExposure(page, 5)
  await openTool(page, 'Export')
  await expect(fullExportButton(page)).toBeEnabled()
  await fullExportButton(page).click()
  await expect(exportSurface(page).getByText('JPEG ready')).toBeVisible({
    timeout: 420_000,
  })

  // Restore brings the preview back and the result stays deliverable.
  await restoreButton(page).click()
  await expect(gpuCanvas(page)).toBeVisible({ timeout: 90_000 })
  const jpeg = await downloadJpeg(page)
  await expect
    .poll(async () =>
      eventPayload(await exportEvents(page), 'output-materialized'),
    )
    .toBeTruthy()
  const { manifest } = await downloadManifest(page)
  expect(manifest.policy.kind).toBe('export-full')
  expect(manifest.output.sha256).toBe(jpeg.sha256)
  expect(manifest.output.filename).toBe(jpeg.name)
  const source = await readFile(rawPath)
  expect(manifest.source_raw.byte_size).toBe(source.byteLength)
  expect(manifest.source_raw.sha256).toBe(sha256(source))

  await page.getByRole('button', { name: /^reset$/i }).click()
  await page
    .getByRole('alertdialog', { name: 'Reset session' })
    .getByRole('button', { name: 'Reset session' })
    .click()
  await expect(
    page.getByRole('button', { name: /finish a raw with a lut/i }),
  ).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(async () =>
      eventPayload(await exportEvents(page), 'resource-cleanup'),
    )
    .toMatchObject({
      reason: 'reset-session',
      disposedOwners: ['export-result'],
      registryCheck: { ok: true },
      remainingLive: [],
    })

  const events = await exportEvents(page)
  const plan = eventPayload(events, 'export-plan-selected')!
  expectCoherentPlan(plan)
  expect(eventPayload(events, 'export-manifest-ready')).toMatchObject({
    manifestSha256: manifest.manifest_sha256,
    outputSha256: manifest.output.sha256,
  })
  const evacuated = eventPayload(events, 'resource-evacuated')!
  expect(evacuated).toMatchObject({ registryCheck: { ok: true } })
  expect(evacuated.requiredOwners).toEqual(PRE_EXPORT_OWNERS)
  expect(evacuated.disposedOwners).toEqual(PRE_EXPORT_OWNERS)
  expect(evacuated.remainingLive).toEqual([])
  expect(eventPayload(events, 'export-worker-attempt')).toMatchObject({
    attempt: 1,
    phase: 'started',
    freshWorker: true,
  })
  expectNoRecoveryJournal(events)
  expect(eventPayload(events, 'output-materialized')).toMatchObject({
    action: 'download',
    cleanup: 'scheduled',
    byteLength: jpeg.bytes.byteLength,
    ...(plan.outputSink === 'opfs-file' ? { outputKind: 'file-backed' } : {}),
  })
  const order = [
    'export-plan-selected',
    'resource-evacuated',
    'export-worker-attempt',
    'output-materialized',
    'resource-cleanup',
  ].map((type) => eventIndex(events, type))
  expect(order[0]).toBeGreaterThanOrEqual(0)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
})
