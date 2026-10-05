import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import process from 'node:process'

import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

function createIdentityCube(title: string, size = 17) {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`]
  const step = 1 / (size - 1)

  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        lines.push(
          `${(r * step).toFixed(6)} ${(g * step).toFixed(6)} ${(
            b * step
          ).toFixed(6)}`,
        )
      }
    }
  }

  return lines.join('\n')
}

function createCatalogFixture() {
  const cube = createIdentityCube('Catalog Fixture')
  const bytes = Buffer.byteLength(cube)
  const sha256 = createHash('sha256').update(cube).digest('hex')
  const primaryAsset = {
    url: 'https://example.com/audit-rec709.cube',
    role: 'cube-lut',
    mediaType: 'application/x-cube-lut',
    sha256,
    size: bytes,
    title: 'Audit Rec.709 Print',
  }
  const previewAsset = {
    url: 'https://example.com/previews/audit-rec709.png',
    role: 'preview-image',
    mediaType: 'image/png',
    size: 68,
    title: 'Audit Rec.709 Print',
    width: 1,
    height: 1,
  }

  return {
    cube,
    catalog: {
      schemaVersion: 1,
      entries: [
        {
          id: 'audit-rec709',
          kind: 'lut',
          version: '1.0.0',
          title: 'Audit Rec.709 Print',
          family: 'Print Film',
          license: 'CC0-1.0',
          redistributionAllowed: true,
          primaryAsset,
          previewAsset,
          entryUrl: 'https://example.com/entries/audit-rec709.json',
        },
      ],
    },
    entry: {
      schemaVersion: 1,
      id: 'audit-rec709',
      kind: 'lut',
      version: '1.0.0',
      format: 'cube',
      title: 'Audit Rec.709 Print',
      family: 'Print Film',
      license: 'CC0-1.0',
      redistributionAllowed: true,
      primaryAsset,
      previewAsset,
      entryUrl: 'https://example.com/entries/audit-rec709.json',
      lut: {
        intent: 'combined-look-output',
        input: {
          gamut: 's-gamut3-cine',
          transfer: 's-log3',
          range: 'full',
        },
        output: {
          gamut: 'rec709',
          transfer: 'gamma24',
          range: 'legal',
        },
      },
    },
  }
}

const RAW_FIXTURE =
  process.env.LUMAFORGE_MOBILE_RAW ??
  '/workspaces/LumaForge/test-images/SGL_1998.NEF'

async function loadRawFixtureMobile(page: Page) {
  const fileChooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: /browse raw files/i }).click()
  const fileChooser = await fileChooserPromise
  await fileChooser.setFiles(RAW_FIXTURE)
  await expect(
    page.locator('.raw-lab[data-raw-lab-state="loaded"]'),
  ).toBeVisible({ timeout: 90_000 })
}

/** The mobile Look deck: its strip of looks and its footer. */
function lookStrip(page: Page) {
  return page.getByRole('group', { name: 'Looks' })
}

test('closes the online LUT resource browser when its trigger is clicked again', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    'desktop LUT source popover regression',
  )

  await page.goto(
    `/raw?luts=${encodeURIComponent('https://example.com/valid.cube')}`,
  )

  const trigger = page.getByRole('button', { name: 'Open valid.cube' })
  await expect(trigger).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')

  await trigger.click()

  await expect(
    page.getByRole('dialog', { name: 'valid.cube LUTs' }),
  ).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')

  await trigger.click()

  await expect(
    page.getByRole('dialog', { name: 'valid.cube LUTs' }),
  ).toHaveCount(0)
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
})

test('closes the online LUT resource browser after a rapid repeated trigger click', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    'desktop LUT source popover regression',
  )

  await page.goto(
    `/raw?luts=${encodeURIComponent('https://example.com/rapid.cube')}`,
  )

  const trigger = page.getByRole('button', { name: 'Open rapid.cube' })
  await expect(trigger).toBeVisible()

  await trigger.dblclick()

  await expect(
    page.getByRole('dialog', { name: 'rapid.cube LUTs' }),
  ).toHaveCount(0)
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
})

test('closes the LUT contract browser when its trigger is clicked again', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    'desktop LUT contract popover regression',
  )

  const cubePath = testInfo.outputPath('unknown-validation.cube')
  await writeFile(cubePath, createIdentityCube('Unknown Validation'), 'utf8')
  await page.goto('/raw')

  await page
    .locator('input[type="file"][accept=".cube"]')
    .first()
    .setInputFiles(cubePath)

  const trigger = page.getByRole('button', { name: 'Change LUT contract' })
  await expect(trigger).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')

  await trigger.click()

  await expect(
    page.getByRole('dialog', { name: 'LUT contract browser' }),
  ).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')

  await trigger.click()

  await expect(
    page.getByRole('dialog', { name: 'LUT contract browser' }),
  ).toHaveCount(0)
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
})

test('keeps the LUT contract browser options inside its scroll frame on desktop', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    'desktop anchored contract browser regression',
  )

  const cubePath = testInfo.outputPath('contract-browser-scroll.cube')
  await writeFile(
    cubePath,
    createIdentityCube('Contract Browser Scroll'),
    'utf8',
  )
  await page.goto('/raw')

  await page
    .locator('input[type="file"][accept=".cube"]')
    .first()
    .setInputFiles(cubePath)

  const trigger = page.getByRole('button', { name: 'Change LUT contract' })
  await expect(trigger).toBeVisible()
  await trigger.click()

  const browser = page.getByRole('dialog', { name: 'LUT contract browser' })
  await expect(browser).toBeVisible()

  const metrics = await page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>(
      '[data-raw-lut-browser-dialog="contract"]',
    )
    const list = document.querySelector<HTMLElement>(
      '[data-raw-lut="contract-browser-list"]',
    )
    const toolSurface = document.querySelector<HTMLElement>('.raw-tool-surface')

    return {
      dialog: dialog?.getBoundingClientRect().toJSON(),
      list: list?.getBoundingClientRect().toJSON(),
      listOverflowY: list ? getComputedStyle(list).overflowY : '',
      placement: dialog?.getAttribute('data-lut-source-placement'),
      toolSurface: toolSurface?.getBoundingClientRect().toJSON(),
    }
  })

  expect(metrics.dialog).toBeTruthy()
  expect(metrics.list).toBeTruthy()
  expect(metrics.toolSurface).toBeTruthy()
  expect(metrics.placement).toBe('sidecar')
  expect(metrics.dialog!.width).toBeGreaterThanOrEqual(500)
  expect(metrics.dialog!.right).toBeLessThanOrEqual(
    metrics.toolSurface!.left - 8,
  )
  expect(metrics.listOverflowY).toBe('auto')
  expect(metrics.list!.bottom).toBeLessThanOrEqual(metrics.dialog!.bottom + 1)
})

test('keeps sparse online LUT resource entries compact on desktop', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    'desktop anchored online resource browser regression',
  )

  const fixture = createCatalogFixture()

  await page.route('https://example.com/catalog.json', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(fixture.catalog),
    }),
  )
  await page.route('https://example.com/entries/audit-rec709.json', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(fixture.entry),
    }),
  )
  await page.route('https://example.com/audit-rec709.cube', (route) =>
    route.fulfill({
      contentType: 'text/plain',
      body: fixture.cube,
    }),
  )
  await page.goto(
    `/raw?luts=${encodeURIComponent('https://example.com/catalog.json')}`,
  )

  const trigger = page.getByRole('button', {
    name: 'Open Catalog from example.com',
  })
  await expect(trigger).toBeVisible()
  await trigger.click()

  const browser = page.getByRole('dialog', {
    name: 'Catalog from example.com LUTs',
  })
  await expect(browser).toBeVisible()
  // Preview chrome was removed with the shelved preheat design; entries from
  // catalogs that still ship preview assets must render without it.
  await expect(browser.locator('[data-raw-lut-preview]')).toHaveCount(0)

  const metrics = await page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>(
      '[data-raw-lut-browser-dialog="source"]',
    )
    const list = document.querySelector<HTMLElement>(
      '[data-raw-lut="source-browser-list"]',
    )
    // Scope to the dialog list: inline preview tiles in the tool surface
    // share the catalog-entry chrome since the paint was unified, so a
    // top-level query would grab the wrong element.
    const entry = list?.querySelector<HTMLElement>(
      '[data-raw-lut="catalog-entry"]',
    )
    const toolSurface = document.querySelector<HTMLElement>('.raw-tool-surface')

    return {
      dialog: dialog?.getBoundingClientRect().toJSON(),
      entry: entry?.getBoundingClientRect().toJSON(),
      list: list?.getBoundingClientRect().toJSON(),
      listAlignContent: list ? getComputedStyle(list).alignContent : '',
      placement: dialog?.getAttribute('data-lut-source-placement'),
      toolSurface: toolSurface?.getBoundingClientRect().toJSON(),
    }
  })

  expect(metrics.dialog).toBeTruthy()
  expect(metrics.list).toBeTruthy()
  expect(metrics.entry).toBeTruthy()
  expect(metrics.toolSurface).toBeTruthy()
  expect(metrics.placement).toBe('sidecar')
  expect(metrics.dialog!.width).toBeGreaterThanOrEqual(500)
  expect(metrics.dialog!.right).toBeLessThanOrEqual(
    metrics.toolSurface!.left - 8,
  )
  expect(['start', 'flex-start']).toContain(metrics.listAlignContent)
  expect(metrics.dialog!.height).toBeLessThanOrEqual(280)
  expect(metrics.entry!.height).toBeLessThanOrEqual(56)

  await browser
    .getByRole('button', { name: 'Load Audit Rec.709 Print' })
    .click()
  await expect(browser).toHaveCount(0)
  await expect(page.getByText('LUT input:')).toBeVisible()
  await expect(page.getByText('Sony S-Gamut3.Cine / S-Log3')).toBeVisible()
  await expect(page.getByText('LUT output:')).toBeVisible()
  await expect(page.getByText('Rec.709 display')).toBeVisible()
  await expect(page.getByText('LUT intent is unsupported')).toHaveCount(0)
})

test('mobile tries a catalog look on the photo from the Look strip', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'webkit-ios-safe',
    'mobile Look deck targets the iOS project',
  )
  test.skip(!existsSync(RAW_FIXTURE), `Missing RAW fixture: ${RAW_FIXTURE}`)
  testInfo.setTimeout(180_000)

  const fixture = createCatalogFixture()
  await page.route('https://example.com/catalog.json', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(fixture.catalog),
    }),
  )
  await page.route('https://example.com/entries/audit-rec709.json', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(fixture.entry),
    }),
  )
  await page.route('https://example.com/audit-rec709.cube', (route) =>
    route.fulfill({ contentType: 'text/plain', body: fixture.cube }),
  )
  await page.goto(
    `/raw?luts=${encodeURIComponent('https://example.com/catalog.json')}`,
  )
  await loadRawFixtureMobile(page)

  // Look opens with the strip: Original applied, the catalog's look, Import.
  const strip = lookStrip(page)
  await expect(strip).toBeVisible()
  const original = strip.getByRole('button', { name: 'Original' })
  await expect(original).toHaveAttribute('aria-pressed', 'true')
  const look = strip.locator('[data-mobile-lut-tile="entry"]').first()
  await expect(look).toBeVisible({ timeout: 60_000 })
  await expect(
    strip.getByRole('button', { name: 'Import .cube' }),
  ).toBeVisible()
  await expect(page.getByText('No LUT · tone and color only')).toBeVisible()
  await expect(
    page
      .getByRole('tablist', { name: 'Strength' })
      .getByRole('tab', { name: 'Strong' }),
  ).toBeDisabled()

  // A tap applies it on the photo; the sheet never opens.
  await look.click()
  await expect(look).toHaveAttribute('aria-pressed', 'true', {
    timeout: 60_000,
  })
  await expect(look).toHaveAttribute('data-state', 'applied')
  await expect(original).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // The catalog declares its contract, so the footer reads it quietly.
  await expect(
    page.getByRole('button', { name: /^Edit color contract for/ }),
  ).toContainText('Rec.709 display')
  await expect(
    page
      .getByRole('tablist', { name: 'Strength' })
      .getByRole('tab', { name: 'Strong' }),
  ).toBeEnabled()

  // LUT sources is a sheet for the sources only.
  await page.getByRole('button', { name: 'LUT sources' }).click()
  const sources = page.getByRole('dialog', { name: 'LUT sources' })
  await expect(sources).toBeVisible()
  await expect(sources.getByRole('tablist', { name: 'Strength' })).toHaveCount(
    0,
  )
  await sources.getByRole('button', { name: 'Close LUT sources' }).click()
  await expect(sources).toHaveCount(0)
})

test("mobile chooses an imported LUT's contract inline, with the photo in view", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'webkit-ios-safe',
    'mobile Look deck targets the iOS project',
  )
  test.skip(!existsSync(RAW_FIXTURE), `Missing RAW fixture: ${RAW_FIXTURE}`)
  testInfo.setTimeout(180_000)

  await page.goto('/raw')
  await loadRawFixtureMobile(page)

  const cubePath = testInfo.outputPath('inline-contract.cube')
  await writeFile(cubePath, createIdentityCube('Inline Contract'), 'utf8')
  await page.locator('[data-mobile-lut-import-input]').setInputFiles(cubePath)

  // Nothing resolved this file, so its contract opens by itself, in the
  // deck: no sheet over the photo.
  const input = page.getByRole('region', { name: /: input$/ })
  await expect(input).toBeVisible({ timeout: 60_000 })
  await expect(input).toContainText('1 / 2')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('[data-mobile-dock-panel]')).toHaveAttribute(
    'data-deck-fill',
    'true',
  )
  // The deck takes list sizing: it starts where the photo ends, so the
  // photo stays in view above it (polled past the 240ms inset motion).
  await expect
    .poll(async () => {
      const photo = await page
        .locator('[data-raw-preview-frame]')
        .first()
        .boundingBox()
      const deck = await page.locator('[data-mobile-dock-panel]').boundingBox()
      if (!photo || !deck) return Number.NaN
      return Math.round(deck.y - (photo.y + photo.height))
    })
    .toBeGreaterThanOrEqual(-1)

  await page.getByLabel('Search LUT contract').fill('display srgb')
  await page
    .getByRole('button', { name: 'Use Display sRGB as LUT input', exact: true })
    .click()
  const output = page.getByRole('region', { name: /: output$/ })
  await expect(output).toContainText('2 / 2')
  await page.getByLabel('Search LUT contract').fill('display srgb')
  await page
    .getByRole('button', {
      name: 'Use Display sRGB as LUT output',
      exact: true,
    })
    .click()

  // Complete: back on the strip, the file applied, its contract confirmed.
  await expect(lookStrip(page)).toBeVisible()
  await expect(
    lookStrip(page).locator('[data-mobile-lut-tile="custom"]'),
  ).toHaveAttribute('data-state', 'applied')
  await expect(
    page.getByRole('button', { name: /^Edit color contract for/ }),
  ).toBeVisible()
})
