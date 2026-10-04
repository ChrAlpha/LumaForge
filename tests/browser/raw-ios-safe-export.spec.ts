import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

import { resolveRawFixture } from './raw-export-fixtures'

type ExportDebugEvent = {
  type: string
  payload: Record<string, unknown>
}

type ExpectedProjectPlan = {
  preferredRows: number[]
  concurrency: number
  runtimeMemoryProfile: string
  checkpointMode: string
  outputSink: string
  checkpointExpected: boolean
  derivedLabelFragment: string
}

function getExpectedProjectPlan(projectName: string): ExpectedProjectPlan {
  if (projectName === 'chromium-desktop') {
    return {
      preferredRows: [256],
      concurrency: 2,
      runtimeMemoryProfile: 'desktop',
      checkpointMode: 'safe-retry',
      outputSink: 'opfs-file',
      checkpointExpected: true,
      derivedLabelFragment: 'wkchromium',
    }
  }

  return {
    preferredRows: [64, 128],
    concurrency: 1,
    runtimeMemoryProfile: 'low-memory',
    checkpointMode: 'safe-retry',
    outputSink: 'opfs-file',
    checkpointExpected: true,
    derivedLabelFragment: 'wkwebkit-mobile',
  }
}

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

async function hasUnsupportedBrowserBuildMessage(page: Page) {
  return /not available in this browser build/i.test(
    (await page.locator('body').textContent()) ?? '',
  )
}

async function hasFailClosedLargeExportMessage(page: Page) {
  return /cannot safely complete this large local full-resolution export/i.test(
    (await page.locator('body').textContent()) ?? '',
  )
}

async function openRawToolsIfCollapsed(page: Page) {
  const toolsToggle = page.getByRole('button', { name: 'Tools' })
  if (await toolsToggle.isVisible()) {
    const expanded = await toolsToggle.getAttribute('aria-expanded')
    if (expanded !== 'true') {
      await toolsToggle.click()
    }
  }
}

async function loadRawFixture(page: Page, fixture: string) {
  const isMobileViewport = await page.evaluate(() => window.innerWidth <= 640)
  const mobileBrowseButton = page.getByRole('button', {
    name: /browse raw files/i,
  })
  const emptyStageButton = page.getByRole('button', {
    name: /finish a raw with a lut/i,
  })

  if (isMobileViewport) {
    await expect(mobileBrowseButton).toBeVisible()
    const fileChooserPromise = page.waitForEvent('filechooser')
    await mobileBrowseButton.click()
    const fileChooser = await fileChooserPromise
    await fileChooser.setFiles(fixture)
  } else {
    await expect(emptyStageButton).toBeVisible()
    const fileChooserPromise = page.waitForEvent('filechooser')
    await emptyStageButton.click({ position: { x: 24, y: 24 } })
    const fileChooser = await fileChooserPromise
    await fileChooser.setFiles(fixture)
  }
}

async function openExportControls(page: Page) {
  const isMobileViewport = await page.evaluate(() => window.innerWidth <= 640)
  if (!isMobileViewport) return

  // Export is a topbar action, not a dock tab. It mounts once a RAW is
  // loaded and stays disabled while the pipeline is busy; a tap opens the
  // export panel in the deck.
  const mobileExportAction = page.locator('[data-mobile-export-action]')
  await expect(mobileExportAction).toBeVisible({ timeout: 120_000 })
  await expect(mobileExportAction).toBeEnabled({ timeout: 120_000 })
  if ((await mobileExportAction.getAttribute('aria-expanded')) !== 'true') {
    await mobileExportAction.click()
  }
  await expect(page.locator('[data-mobile-export-panel]')).toBeVisible()
}

test('browser preflight records expected export policy before export', async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(240_000)
  const fixture = resolveRawFixture(testInfo)
  const expectedPlan = getExpectedProjectPlan(testInfo.project.name)

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

  await loadRawFixture(page, fixture)

  await openRawToolsIfCollapsed(page)
  await openExportControls(page)

  const exportButton = page
    .getByRole('button', { name: /export full-resolution jpeg/i })
    .first()
  await expect
    .poll(
      async () => {
        if (await hasUnsupportedBrowserBuildMessage(page)) {
          return 'unsupported'
        }
        if (await hasFailClosedLargeExportMessage(page)) {
          return 'fail-closed'
        }
        if (
          (await exportButton.isVisible()) &&
          (await exportButton.isEnabled())
        ) {
          return 'ready'
        }
        return 'waiting'
      },
      { timeout: 120_000 },
    )
    .toMatch(/ready|unsupported|fail-closed/)

  if (await hasUnsupportedBrowserBuildMessage(page)) {
    testInfo.skip(
      true,
      'This Playwright WebKit browser build cannot expose processed-window full-resolution export for this fixture.',
    )
  }
  if (await hasFailClosedLargeExportMessage(page)) {
    testInfo.skip(
      true,
      'This browser correctly failed closed for a large local full-resolution export without durable file storage.',
    )
  }

  await expect(exportButton).toBeEnabled({ timeout: 60_000 })
  await exportButton.click()

  try {
    const requiredEventTypes = [
      'export-plan-selected',
      'resource-evacuated',
      'export-worker-attempt',
      ...(expectedPlan.checkpointExpected ? ['checkpoint-written'] : []),
    ]
    await expect
      .poll(async () => {
        const eventTypes = new Set(
          (await collectExportEvents(page)).map((event) => event.type),
        )
        return requiredEventTypes.every((type) => eventTypes.has(type))
      })
      .toBe(true)

    const events = await collectExportEvents(page)
    const planPayload = eventPayload(events, 'export-plan-selected')
    expect(planPayload).toMatchObject({
      concurrency: expectedPlan.concurrency,
      runtimeMemoryProfile: expectedPlan.runtimeMemoryProfile,
      checkpointMode: expectedPlan.checkpointMode,
      outputSink: expectedPlan.outputSink,
      policyVector: {
        workerMemoryProfile: expectedPlan.runtimeMemoryProfile,
        concurrency: expectedPlan.concurrency,
        outputSink: expectedPlan.outputSink,
      },
    })
    expect(expectedPlan.preferredRows).toContain(planPayload?.preferredRows)
    expect(expectedPlan.preferredRows).toContain(
      (planPayload?.policyVector as { rowSlice?: unknown } | undefined)
        ?.rowSlice,
    )
    expect(planPayload?.derivedLabel).toEqual(
      expect.stringContaining(expectedPlan.derivedLabelFragment),
    )

    const evacuationPayload = eventPayload(events, 'resource-evacuated')
    expect(evacuationPayload).toMatchObject({
      registryCheck: { ok: true },
    })
    expect(evacuationPayload?.requiredOwners).toEqual([
      'preview',
      'bounded-hq',
      'gpu',
      'export-result',
      'lut-fetch',
    ])
    expect(evacuationPayload?.remainingLive).toEqual([])

    const workerAttemptPayload = eventPayload(events, 'export-worker-attempt')
    expect(workerAttemptPayload).toMatchObject({
      attempt: 1,
      phase: 'started',
      freshWorker: true,
    })

    if (expectedPlan.checkpointExpected) {
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'checkpoint-written',
        }),
      )
    }
  } finally {
    await testInfo.attach('export-events.json', {
      body: JSON.stringify(await collectExportEvents(page), null, 2),
      contentType: 'application/json',
    })
  }
})
