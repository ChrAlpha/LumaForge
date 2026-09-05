import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import process from 'node:process'

import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

import { verifyManifestSha256 } from '../../packages/render-engine/src/manifest/canonicalize'

type ExportDebugEvent = {
  type: string
  payload: Record<string, unknown>
}

type LifecycleResourceSample = {
  label: string
  timestamp: number
  heap: null | {
    usedJSHeapSize: number
    totalJSHeapSize: number
    jsHeapSizeLimit: number
  }
  userAgentSpecificMemory:
    | { available: false; reason?: string }
    | { available: true; bytes: number; breakdownCount: number }
  resourceEntries: Array<{
    name: string
    initiatorType: string
    transferSize: number
    encodedBodySize: number
    decodedBodySize: number
    duration: number
  }>
}

const sonyRawPath =
  process.env.LUMAFORGE_SONY_ARW ??
  '/workspaces/LumaForge/test-images/SGL00940.ARW'

async function collectExportEvents(page: Page) {
  return (await page.evaluate(() => {
    return (
      (window as unknown as { __LUMAFORGE_EXPORT_EVENTS__?: unknown[] })
        .__LUMAFORGE_EXPORT_EVENTS__ ?? []
    )
  })) as ExportDebugEvent[]
}

function eventPayload(events: ExportDebugEvent[], type: string) {
  return events.find((event) => event.type === type)?.payload ?? null
}

function eventIndex(events: ExportDebugEvent[], type: string) {
  return events.findIndex((event) => event.type === type)
}

function expectDerivedPlanCoherence(
  planPayload: Record<string, unknown> | null,
) {
  expect(planPayload).toMatchObject({
    checkpointMode: 'safe-retry',
  })

  const policyVector = planPayload?.policyVector as
    | Record<string, unknown>
    | undefined
  expect(policyVector).toMatchObject({
    workerMemoryProfile: planPayload?.runtimeMemoryProfile,
    concurrency: planPayload?.concurrency,
    outputSink: planPayload?.outputSink,
    rowSlice: planPayload?.preferredRows,
  })
  expect(['desktop', 'low-memory']).toContain(planPayload?.runtimeMemoryProfile)
  expect(['opfs-file', 'streaming', 'blob-handoff']).toContain(
    planPayload?.outputSink,
  )

  const concurrency = Number(planPayload?.concurrency)
  const preferredRows = Number(planPayload?.preferredRows)
  expect(Number.isFinite(concurrency)).toBe(true)
  expect(concurrency).toBeGreaterThanOrEqual(1)
  expect(Number.isFinite(preferredRows)).toBe(true)
  expect(preferredRows).toBeGreaterThanOrEqual(64)
  expect(preferredRows).toBeLessThanOrEqual(2048)

  const productCopy = policyVector?.productCopy
  expect(productCopy).not.toBe('cannot-safely-complete')
  expect([
    'high-performance',
    'safe-export',
    'resource-retry',
    'interrupted-retry',
    'non-durable-checkpoint',
  ]).toContain(productCopy)

  if (productCopy === 'high-performance') {
    expect(planPayload?.runtimeMemoryProfile).toBe('desktop')
    expect(concurrency).toBeGreaterThanOrEqual(2)
    expect(preferredRows).toBeGreaterThanOrEqual(512)
  }

  expect(planPayload?.derivedLabel).toEqual(
    expect.stringContaining(`rs${preferredRows}`),
  )
  expect(planPayload?.derivedLabel).toEqual(
    expect.stringContaining(`-${String(planPayload?.outputSink)}-`),
  )
}

async function sampleResourceUsage(
  page: Page,
  label: string,
): Promise<LifecycleResourceSample> {
  return page.evaluate(async (sampleLabel) => {
    const memory =
      'memory' in performance
        ? (
            performance as Performance & {
              memory?: {
                usedJSHeapSize: number
                totalJSHeapSize: number
                jsHeapSizeLimit: number
              }
            }
          ).memory
        : undefined
    const memoryApi = performance as Performance & {
      measureUserAgentSpecificMemory?: () => Promise<{
        bytes: number
        breakdown?: unknown[]
      }>
    }
    let userAgentSpecificMemory:
      | { available: false; reason?: string }
      | { available: true; bytes: number; breakdownCount: number } = {
      available: false,
    }

    if (typeof memoryApi.measureUserAgentSpecificMemory === 'function') {
      try {
        const result = await memoryApi.measureUserAgentSpecificMemory()
        userAgentSpecificMemory = {
          available: true,
          bytes: result.bytes,
          breakdownCount: result.breakdown?.length ?? 0,
        }
      } catch (error) {
        userAgentSpecificMemory = {
          available: false,
          reason: error instanceof Error ? error.message : String(error),
        }
      }
    }

    const interestingResource = /raw|raf|arw|nef|wasm|worker|jpeg|jpg/i
    const resourceEntries = performance
      .getEntriesByType('resource')
      .filter((entry): entry is PerformanceResourceTiming => {
        return (
          entry instanceof PerformanceResourceTiming &&
          interestingResource.test(entry.name)
        )
      })
      .map((entry) => ({
        name: entry.name,
        initiatorType: entry.initiatorType,
        transferSize: entry.transferSize,
        encodedBodySize: entry.encodedBodySize,
        decodedBodySize: entry.decodedBodySize,
        duration: entry.duration,
      }))

    return {
      label: sampleLabel,
      timestamp: performance.now(),
      heap: memory
        ? {
            usedJSHeapSize: memory.usedJSHeapSize,
            totalJSHeapSize: memory.totalJSHeapSize,
            jsHeapSizeLimit: memory.jsHeapSizeLimit,
          }
        : null,
      userAgentSpecificMemory,
      resourceEntries,
    }
  }, label)
}

async function loadRawFixture(page: Page, fixture: string) {
  const fileChooserPromise = page.waitForEvent('filechooser')
  await page
    .getByRole('button', { name: /finish a raw with a lut/i })
    .click({ position: { x: 24, y: 24 } })
  const fileChooser = await fileChooserPromise
  await fileChooser.setFiles(fixture)
}

async function dragSlider(page: Page, sliderName: string, targetRatio: number) {
  const slider = page.getByRole('slider', { name: sliderName })
  await expect(slider).toBeVisible()
  const box = await slider.boundingBox()

  expect(box).toBeTruthy()

  const before = Number(await slider.getAttribute('aria-valuenow'))

  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.mouse.move(
    box!.x + box!.width * targetRatio,
    box!.y + box!.height / 2,
    { steps: 10 },
  )
  await page.mouse.up()

  await expect
    .poll(async () => Number(await slider.getAttribute('aria-valuenow')))
    .not.toBe(before)
}

function expectFiniteHeapSample(sample: LifecycleResourceSample) {
  expect(Number.isFinite(sample.timestamp)).toBe(true)
  if (sample.heap) {
    expect(Number.isFinite(sample.heap.usedJSHeapSize)).toBe(true)
    expect(Number.isFinite(sample.heap.totalJSHeapSize)).toBe(true)
    expect(Number.isFinite(sample.heap.jsHeapSizeLimit)).toBe(true)
  }
  if (sample.userAgentSpecificMemory.available) {
    expect(Number.isFinite(sample.userAgentSpecificMemory.bytes)).toBe(true)
    expect(Number.isFinite(sample.userAgentSpecificMemory.breakdownCount)).toBe(
      true,
    )
  }
  for (const entry of sample.resourceEntries) {
    expect(Number.isFinite(entry.duration)).toBe(true)
    expect(Number.isFinite(entry.transferSize)).toBe(true)
    expect(Number.isFinite(entry.encodedBodySize)).toBe(true)
    expect(Number.isFinite(entry.decodedBodySize)).toBe(true)
  }
}

test('monitors a full desktop RAW export lifecycle with resource diagnostics', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    'desktop lifecycle resource monitor uses Chromium performance APIs and OPFS',
  )
  test.skip(
    !existsSync(sonyRawPath),
    `Missing Sony ARW fixture: ${sonyRawPath}`,
  )
  testInfo.setTimeout(600_000)

  const samples: LifecycleResourceSample[] = []

  try {
    await page.addInitScript(() => {
      window.addEventListener('lumaforge-export-debug', (event) => {
        const custom = event as CustomEvent
        ;(
          window as unknown as { __LUMAFORGE_EXPORT_EVENTS__: unknown[] }
        ).__LUMAFORGE_EXPORT_EVENTS__ ??= []
        ;(
          window as unknown as { __LUMAFORGE_EXPORT_EVENTS__: unknown[] }
        ).__LUMAFORGE_EXPORT_EVENTS__.push(custom.detail)
      })
    })

    await page.goto('/raw')
    samples.push(await sampleResourceUsage(page, 'initial'))

    await loadRawFixture(page, sonyRawPath)
    await expect(
      page.locator('.raw-lab[data-raw-lab-state="loaded"]'),
    ).toBeVisible({ timeout: 90_000 })
    await expect(
      page
        .getByRole('region', { name: 'Export' })
        .first()
        .getByRole('button', { name: /export full-resolution jpeg/i }),
    ).toBeEnabled({ timeout: 90_000 })
    samples.push(await sampleResourceUsage(page, 'raw-ready'))

    await dragSlider(page, 'Exposure', 0.7)
    samples.push(await sampleResourceUsage(page, 'tone-adjusted'))

    const exportRegion = page.getByRole('region', { name: 'Export' }).first()
    const exportButton = exportRegion
      .getByRole('button', { name: /export full-resolution jpeg/i })
      .first()
    await expect(exportButton).toBeEnabled()
    samples.push(await sampleResourceUsage(page, 'before-export'))
    await exportButton.click()

    await expect
      .poll(async () => {
        const eventTypes = new Set(
          (await collectExportEvents(page)).map((event) => event.type),
        )
        return (
          eventTypes.has('export-plan-selected') &&
          eventTypes.has('resource-evacuated') &&
          eventTypes.has('export-worker-attempt')
        )
      })
      .toBe(true)
    samples.push(await sampleResourceUsage(page, 'after-evacuation'))

    await expect(exportRegion.getByText('JPEG ready')).toBeVisible({
      timeout: 420_000,
    })
    const downloadButton = exportRegion.getByRole('button', {
      name: /^download$/i,
    })
    await expect(downloadButton).toBeVisible()
    samples.push(await sampleResourceUsage(page, 'jpeg-ready'))

    const restorePreviewButton = page.getByRole('button', {
      name: /^restore preview$/i,
    })
    await expect(restorePreviewButton).toBeVisible()
    await restorePreviewButton.click()
    await expect(page.locator('.raw-preview-canvas')).toBeVisible({
      timeout: 90_000,
    })
    await expect(downloadButton).toBeVisible()
    samples.push(await sampleResourceUsage(page, 'after-preview-restore'))

    const downloadPromise = page.waitForEvent('download')
    await downloadButton.click()
    const download = await downloadPromise
    expect(await download.path()).toBeTruthy()
    await expect
      .poll(async () => {
        return (await collectExportEvents(page)).some(
          (event) => event.type === 'output-materialized',
        )
      })
      .toBe(true)
    samples.push(await sampleResourceUsage(page, 'download-materialized'))

    // The sealed manifest is attached after "ready" once the source RAW and
    // the delivered JPEG have been hashed; it must verify and identify the
    // exact bytes that were downloaded.
    const manifestButton = exportRegion.getByRole('button', {
      name: /^manifest$/i,
    })
    await expect(manifestButton).toBeVisible({ timeout: 180_000 })
    const manifestDownloadPromise = page.waitForEvent('download')
    await manifestButton.click()
    const manifestDownload = await manifestDownloadPromise
    expect(manifestDownload.suggestedFilename()).toMatch(/\.manifest\.json$/)
    const manifestPath = await manifestDownload.path()
    expect(manifestPath).toBeTruthy()
    const manifest = JSON.parse(await readFile(manifestPath!, 'utf8')) as {
      kind: string
      manifest_sha256: string
      policy: { kind: string }
      source_raw: { sha256: string; byte_size: number }
      output: { sha256: string; filename: string }
      environment: { native_artifacts: { variant: string } }
    }
    expect(verifyManifestSha256(manifest)).toBe(true)
    expect(manifest.kind).toBe('export')
    expect(manifest.policy.kind).toBe('export-full')
    const jpegPath = await download.path()
    const jpegBytes = await readFile(jpegPath!)
    expect(manifest.output.sha256).toBe(
      createHash('sha256').update(jpegBytes).digest('hex'),
    )
    expect(manifest.output.filename).toBe(download.suggestedFilename())
    const sourceBytes = await readFile(sonyRawPath)
    expect(manifest.source_raw.byte_size).toBe(sourceBytes.byteLength)
    expect(manifest.source_raw.sha256).toBe(
      createHash('sha256').update(sourceBytes).digest('hex'),
    )
    expect(['desktop', 'low-memory']).toContain(
      manifest.environment.native_artifacts.variant,
    )
    samples.push(await sampleResourceUsage(page, 'manifest-downloaded'))

    await page.getByRole('button', { name: /^reset$/i }).click()
    const resetDialog = page.getByRole('alertdialog', {
      name: 'Reset session',
    })
    await expect(resetDialog).toBeVisible()
    await resetDialog.getByRole('button', { name: 'Reset session' }).click()
    await expect(
      page.getByRole('button', { name: /finish a raw with a lut/i }),
    ).toBeVisible({ timeout: 30_000 })
    await expect
      .poll(async () => {
        return (await collectExportEvents(page)).some(
          (event) =>
            event.type === 'resource-cleanup' &&
            event.payload.reason === 'reset-session',
        )
      })
      .toBe(true)
    samples.push(await sampleResourceUsage(page, 'after-reset'))

    const events = await collectExportEvents(page)
    const planPayload = eventPayload(events, 'export-plan-selected')
    expectDerivedPlanCoherence(planPayload)
    expect(eventPayload(events, 'export-manifest-ready')).toMatchObject({
      manifestSha256: manifest.manifest_sha256,
      outputSha256: manifest.output.sha256,
    })

    const evacuationPayload = eventPayload(events, 'resource-evacuated')
    expect(evacuationPayload).toMatchObject({
      registryCheck: { ok: true },
    })
    expect(evacuationPayload?.requiredOwners).toEqual([
      'preview',
      'bounded-hq',
      'webgl',
      'export-result',
      'lut-fetch',
    ])
    expect(evacuationPayload?.disposedOwners).toEqual([
      'preview',
      'bounded-hq',
      'webgl',
      'export-result',
      'lut-fetch',
    ])
    expect(evacuationPayload?.remainingLive).toEqual([])

    expect(eventPayload(events, 'export-worker-attempt')).toMatchObject({
      attempt: 1,
      phase: 'started',
      freshWorker: true,
    })
    if (planPayload?.checkpointDurableExpected === true) {
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'checkpoint-written' }),
      )
    }
    const outputMaterialized = eventPayload(events, 'output-materialized')
    expect(outputMaterialized).toMatchObject({
      action: 'download',
      cleanup: 'scheduled',
    })
    expect(Number(outputMaterialized?.byteLength)).toBeGreaterThan(0)
    if (planPayload?.outputSink === 'opfs-file') {
      expect(outputMaterialized?.outputKind).toBe('file-backed')
    }
    expect(eventPayload(events, 'resource-cleanup')).toMatchObject({
      reason: 'reset-session',
      disposedOwners: ['export-result'],
      registryCheck: { ok: true },
      remainingLive: [],
    })

    expect(eventIndex(events, 'export-plan-selected')).toBeGreaterThanOrEqual(0)
    expect(eventIndex(events, 'resource-evacuated')).toBeGreaterThan(
      eventIndex(events, 'export-plan-selected'),
    )
    expect(eventIndex(events, 'export-worker-attempt')).toBeGreaterThan(
      eventIndex(events, 'resource-evacuated'),
    )
    expect(eventIndex(events, 'output-materialized')).toBeGreaterThan(
      eventIndex(events, 'export-worker-attempt'),
    )
    expect(eventIndex(events, 'resource-cleanup')).toBeGreaterThan(
      eventIndex(events, 'output-materialized'),
    )

    expect(samples.map((sample) => sample.label)).toEqual([
      'initial',
      'raw-ready',
      'tone-adjusted',
      'before-export',
      'after-evacuation',
      'jpeg-ready',
      'after-preview-restore',
      'download-materialized',
      'after-reset',
    ])
    samples.forEach(expectFiniteHeapSample)
  } finally {
    await testInfo.attach('raw-export-lifecycle-resources.json', {
      body: JSON.stringify(
        { events: await collectExportEvents(page), samples },
        null,
        2,
      ),
      contentType: 'application/json',
    })
  }
})
