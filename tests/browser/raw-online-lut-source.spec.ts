import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

import type { BrowserContext, Page, TestInfo } from '@playwright/test'
import { expect, test } from '@playwright/test'

import { isDesktopChromiumProject, rawPreviewUrl } from './raw-preview-backend'
import { gateRawFixture, PUBLIC_DNG } from './support/fixtures'

// Online LUT catalogs are fetched on first use, not on mount: the default
// and saved sources are listed from the first render, and their catalog is
// requested only when a surface that shows it opens, a ?luts= link names it,
// or the user adds or refreshes a source. Every catalog request is answered
// here and counted per URL; no request leaves the test.

const CHROMIUM_ONLY =
  'Catalog activation runs on the Chromium project at desktop and phone viewports'

/** The product's default source, listed without a request. */
const DEFAULT_CATALOG_URL =
  'https://luma-prof.ichr.me/channels/stable/luts/catalog.json'
const DEFAULT_SOURCE_LABEL = 'LumaForge Profiles'
const DEFAULT_ENTRY_TITLE = 'Default Print'
/** A source another user shares by link. */
const SHARED_CATALOG_URL = 'https://luts.example.com/shared/catalog.json'
const SHARED_SOURCE_LABEL = 'Catalog from luts.example.com'
const SHARED_ENTRY_TITLE = 'Shared Print'

const DESKTOP_VIEWPORT = { width: 1440, height: 1000 }
const MOBILE_VIEWPORT = { width: 393, height: 852 }
/** Long enough for any mount-time request to have been sent. */
const QUIET_MS = 2_500

function createIdentityCube(title: string, size = 17) {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`]
  const step = 1 / (size - 1)
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        lines.push(
          `${(r * step).toFixed(6)} ${(g * step).toFixed(6)} ${(b * step).toFixed(6)}`,
        )
      }
    }
  }
  return lines.join('\n')
}

/** A one-LUT catalog whose entry and cube live beside it. */
function createCatalog(catalogUrl: string, id: string, title: string) {
  const base = new URL('./', catalogUrl).href
  const cube = createIdentityCube(title)
  const primaryAsset = {
    url: `${base}${id}.cube`,
    role: 'cube-lut',
    mediaType: 'application/x-cube-lut',
    sha256: createHash('sha256').update(cube).digest('hex'),
    size: Buffer.byteLength(cube),
    title,
  }
  const entryUrl = `${base}entries/${id}.json`
  const row = {
    id,
    kind: 'lut',
    version: '1.0.0',
    title,
    family: 'Print Film',
    license: 'CC0-1.0',
    redistributionAllowed: true,
    primaryAsset,
    entryUrl,
  }
  return {
    catalog: { schemaVersion: 1, entries: [row] },
    entryUrl,
    entry: {
      ...row,
      schemaVersion: 1,
      format: 'cube',
      lut: {
        intent: 'display-look',
        input: { gamut: 'srgb-rec709', transfer: 'srgb', range: 'full' },
      },
    },
    cubeUrl: primaryAsset.url,
    cube,
  }
}

type CatalogRequests = {
  /** Requests per catalog URL, in the order they were sent. */
  count: (url: string) => number
  all: () => string[]
}

/**
 * Answers both catalogs (and their entries and cubes) from the fixtures and
 * records every request to their hosts. Anything else on those hosts fails.
 */
async function serveCatalogs(
  context: BrowserContext,
): Promise<CatalogRequests> {
  const requests: string[] = []
  const documents = new Map<string, { type: string; body: string }>()
  for (const [url, id, title] of [
    [DEFAULT_CATALOG_URL, 'default-print', DEFAULT_ENTRY_TITLE],
    [SHARED_CATALOG_URL, 'shared-print', SHARED_ENTRY_TITLE],
  ] as const) {
    const fixture = createCatalog(url, id, title)
    documents.set(url, {
      type: 'application/json',
      body: JSON.stringify(fixture.catalog),
    })
    documents.set(fixture.entryUrl, {
      type: 'application/json',
      body: JSON.stringify(fixture.entry),
    })
    documents.set(fixture.cubeUrl, { type: 'text/plain', body: fixture.cube })
  }
  const handle = async (
    route: Parameters<Parameters<BrowserContext['route']>[1]>[0],
  ) => {
    const url = route.request().url()
    requests.push(url)
    const document = documents.get(url)
    if (!document) {
      await route.fulfill({ status: 404, body: 'not found' })
      return
    }
    await route.fulfill({
      contentType: document.type,
      headers: { 'access-control-allow-origin': '*' },
      body: document.body,
    })
  }
  await context.route('https://luma-prof.ichr.me/**', handle)
  await context.route('https://luts.example.com/**', handle)
  return {
    count: (url) => requests.filter((request) => request === url).length,
    all: () => [...requests],
  }
}

async function prepareLab(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('lumaforge.locale', 'en')
    localStorage.setItem('lumaforge.raw.mobile.lensHintSeen.v1', '1')
  })
}

async function waitForLoadedRaw(page: Page, name: string) {
  await expect(
    page.locator('.raw-lab[data-raw-lab-state="loaded"]'),
  ).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText(`Loaded ${name}`, { exact: true })).toBeVisible({
    timeout: 120_000,
  })
}

async function loadDesktopRaw(page: Page, path: string) {
  const choosing = page.waitForEvent('filechooser')
  await page
    .getByRole('button', { name: /finish a raw with a lut/i })
    .click({ position: { x: 24, y: 24 } })
  await (await choosing).setFiles(path)
  await waitForLoadedRaw(page, basename(path))
}

async function loadMobileRaw(page: Page, path: string) {
  const choosing = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Browse RAW files' }).click()
  await (await choosing).setFiles(path)
  await waitForLoadedRaw(page, basename(path))
}

/** The desktop row of one listed source. */
function desktopSource(page: Page, label: string) {
  return page
    .locator('[data-raw-lut="source-controls"]')
    .getByRole('button', { name: `Open ${label}` })
}

async function openDesktopSource(page: Page, label: string) {
  await desktopSource(page, label).click()
  const browser = page.getByRole('dialog', { name: `${label} LUTs` })
  await expect(browser).toBeVisible()
  return browser
}

async function closeDesktopSource(page: Page, label: string) {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: `${label} LUTs` })).toHaveCount(
    0,
  )
}

function skipUnlessChromium(testInfo: TestInfo) {
  test.skip(!isDesktopChromiumProject(testInfo), CHROMIUM_ONLY)
}

test.describe('online LUT catalogs load on first use', () => {
  test('desktop: neither the empty route, the open Look card, a RAW nor a local contract requests a catalog; opening the source does, once', async ({
    context,
    page,
  }, testInfo) => {
    skipUnlessChromium(testInfo)
    const rawPath = gateRawFixture(testInfo, PUBLIC_DNG)
    testInfo.setTimeout(240_000)
    const catalogs = await serveCatalogs(context)
    await prepareLab(page)
    await page.setViewportSize(DESKTOP_VIEWPORT)

    await page.goto(rawPreviewUrl(testInfo, '/raw'))
    await expect(page.locator('[data-raw-lab-shell="viewport"]')).toBeVisible()
    // The default source is listed, not loaded.
    await expect(desktopSource(page, DEFAULT_SOURCE_LABEL)).toBeVisible()
    await expect(
      page.locator('[data-raw-lut="source-controls"]').getByRole('button', {
        name: `Load LUTs from ${DEFAULT_SOURCE_LABEL}`,
      }),
    ).toBeVisible()
    await page.waitForTimeout(QUIET_MS)
    expect(catalogs.all()).toEqual([])

    await loadDesktopRaw(page, rawPath)
    // A local LUT and its contract are not a catalog either.
    const cubePath = testInfo.outputPath('local-contract.cube')
    await writeFile(cubePath, createIdentityCube('Local Contract'), 'utf8')
    await page
      .locator('input[type="file"][accept=".cube"]')
      .first()
      .setInputFiles(cubePath)
    const changeContract = page.getByRole('button', {
      name: 'Change LUT contract',
    })
    await expect(changeContract).toBeVisible({ timeout: 60_000 })
    await changeContract.click()
    await expect(page.getByLabel('Search LUT contract')).toBeVisible()
    await page.waitForTimeout(QUIET_MS)
    expect(catalogs.all()).toEqual([])

    // Opening the source is the first use: one request, and its LUTs list.
    let browser = await openDesktopSource(page, DEFAULT_SOURCE_LABEL)
    await expect(
      browser.getByRole('button', { name: `Load ${DEFAULT_ENTRY_TITLE}` }),
    ).toBeVisible()
    expect(catalogs.count(DEFAULT_CATALOG_URL)).toBe(1)
    await closeDesktopSource(page, DEFAULT_SOURCE_LABEL)

    // A loaded catalog is not requested again by reopening it.
    browser = await openDesktopSource(page, DEFAULT_SOURCE_LABEL)
    await expect(
      browser.getByRole('button', { name: `Load ${DEFAULT_ENTRY_TITLE}` }),
    ).toBeVisible()
    await closeDesktopSource(page, DEFAULT_SOURCE_LABEL)
    await page.waitForTimeout(500)
    expect(catalogs.count(DEFAULT_CATALOG_URL)).toBe(1)

    // Refresh asks again.
    await page
      .locator('[data-raw-lut="source-controls"]')
      .getByRole('button', { name: `Refresh ${DEFAULT_SOURCE_LABEL}` })
      .click()
    await expect.poll(() => catalogs.count(DEFAULT_CATALOG_URL)).toBe(2)
    expect(catalogs.count(SHARED_CATALOG_URL)).toBe(0)
  })

  test('mobile: the empty state requests nothing; the Look strip on a ready RAW loads the default catalog once', async ({
    context,
    page,
  }, testInfo) => {
    skipUnlessChromium(testInfo)
    const rawPath = gateRawFixture(testInfo, PUBLIC_DNG)
    testInfo.setTimeout(240_000)
    const catalogs = await serveCatalogs(context)
    await prepareLab(page)
    await page.setViewportSize(MOBILE_VIEWPORT)

    await page.goto(rawPreviewUrl(testInfo, '/raw'))
    await expect(
      page.getByRole('button', { name: 'Browse RAW files' }),
    ).toBeVisible()
    await page.waitForTimeout(QUIET_MS)
    expect(catalogs.all()).toEqual([])

    // The strip is the mobile browser: once it shows, its looks load.
    await loadMobileRaw(page, rawPath)
    const strip = page.getByRole('group', { name: 'Looks' })
    await expect(strip).toBeVisible()
    await expect(
      strip.locator('[data-mobile-lut-tile="entry"]').first(),
    ).toBeVisible({ timeout: 60_000 })
    expect(catalogs.count(DEFAULT_CATALOG_URL)).toBe(1)

    // Neither the sources sheet nor coming back to Look asks again.
    await page.getByRole('button', { name: 'LUT sources' }).click()
    const sources = page.getByRole('dialog', { name: 'LUT sources' })
    await expect(sources).toBeVisible()
    await expect(sources).toContainText(DEFAULT_SOURCE_LABEL)
    await sources.getByRole('button', { name: 'Close LUT sources' }).click()
    await expect(sources).toHaveCount(0)
    const dock = page.getByRole('tablist', { name: 'Lab modes' })
    await dock.getByRole('tab', { name: 'Adjust', exact: true }).click()
    await dock.getByRole('tab', { name: 'Look', exact: true }).click()
    await expect(strip).toBeVisible()
    await page.waitForTimeout(500)
    expect(catalogs.count(DEFAULT_CATALOG_URL)).toBe(1)
    expect(catalogs.count(SHARED_CATALOG_URL)).toBe(0)
  })

  test('a ?luts= link requests only the source it names, Share writes it back, and the shared link lists it once', async ({
    context,
    page,
  }, testInfo) => {
    skipUnlessChromium(testInfo)
    testInfo.setTimeout(180_000)
    const catalogs = await serveCatalogs(context)
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await prepareLab(page)
    await page.setViewportSize(DESKTOP_VIEWPORT)

    await page.goto(
      rawPreviewUrl(
        testInfo,
        `/raw?luts=${encodeURIComponent(SHARED_CATALOG_URL)}`,
      ),
    )
    // The link is an explicit request for its source, before any RAW or
    // click; the default source stays listed and unrequested.
    await expect.poll(() => catalogs.count(SHARED_CATALOG_URL)).toBe(1)
    await expect(desktopSource(page, SHARED_SOURCE_LABEL)).toHaveCount(1)
    await expect(desktopSource(page, DEFAULT_SOURCE_LABEL)).toBeVisible()
    await page.waitForTimeout(QUIET_MS)
    expect(catalogs.count(SHARED_CATALOG_URL)).toBe(1)
    expect(catalogs.count(DEFAULT_CATALOG_URL)).toBe(0)
    // Opening the source shows what that request loaded, without another.
    let browser = await openDesktopSource(page, SHARED_SOURCE_LABEL)
    await expect(
      browser.getByRole('button', { name: `Load ${SHARED_ENTRY_TITLE}` }),
    ).toBeVisible()
    await closeDesktopSource(page, SHARED_SOURCE_LABEL)
    expect(catalogs.count(SHARED_CATALOG_URL)).toBe(1)

    // Share copies a link that names the shared source, not the default.
    await page.getByRole('button', { name: 'Copy LUT source link' }).click()
    await expect(page.getByText('LUT source link copied')).toBeVisible()
    const shared = new URL(
      await page.evaluate(() => navigator.clipboard.readText()),
      page.url(),
    )
    expect(shared.pathname).toBe('/raw')
    expect(shared.searchParams.getAll('luts')).toEqual([SHARED_CATALOG_URL])

    // Opening the shared link in a fresh page lists the source once and
    // requests it once.
    const second = await context.newPage()
    await prepareLab(second)
    await second.setViewportSize(DESKTOP_VIEWPORT)
    await second.goto(
      rawPreviewUrl(testInfo, `${shared.pathname}${shared.search}`),
    )
    await expect.poll(() => catalogs.count(SHARED_CATALOG_URL)).toBe(2)
    await expect(desktopSource(second, SHARED_SOURCE_LABEL)).toHaveCount(1)
    await second.waitForTimeout(QUIET_MS)
    expect(catalogs.count(SHARED_CATALOG_URL)).toBe(2)
    expect(catalogs.count(DEFAULT_CATALOG_URL)).toBe(0)
    browser = await openDesktopSource(second, SHARED_SOURCE_LABEL)
    await expect(
      browser.getByRole('button', { name: `Load ${SHARED_ENTRY_TITLE}` }),
    ).toBeVisible()
    await closeDesktopSource(second, SHARED_SOURCE_LABEL)
    expect(catalogs.count(SHARED_CATALOG_URL)).toBe(2)
    await second.close()
  })
})
