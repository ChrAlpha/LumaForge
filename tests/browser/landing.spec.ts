import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

const ENGLISH_LOCALE = 'en'
const LOCALE_STORAGE_KEY = 'lumaforge.locale'

async function openEnglishLanding(page: Page) {
  await page.addInitScript(
    ({ key, locale }) => {
      try {
        if (window.localStorage.getItem(key) === null) {
          window.localStorage.setItem(key, locale)
        }
      } catch {}
    },
    { key: LOCALE_STORAGE_KEY, locale: ENGLISH_LOCALE },
  )

  await page.goto('/')
  await expect(page.getByRole('main')).toBeVisible()
}

function captureBrowserErrors(page: Page) {
  const errors: string[] = []

  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => {
    errors.push(`page: ${error.message}`)
  })

  return errors
}

async function readSliderValue(page: Page) {
  const value = await page.getByRole('slider').getAttribute('aria-valuenow')

  return Number(value)
}

test('presents the complete RAW workflow without browser errors', async ({
  page,
}) => {
  const browserErrors = captureBrowserErrors(page)
  await openEnglishLanding(page)

  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { level: 1 })).toBeVisible()

  const namedSections = main.locator(':scope > section')
  expect(await namedSections.count()).toBeGreaterThanOrEqual(5)
  expect(
    await namedSections.evaluateAll((sections) =>
      sections.every(
        (section) =>
          section.hasAttribute('aria-label') ||
          section.hasAttribute('aria-labelledby'),
      ),
    ),
  ).toBe(true)

  const workflow = page.getByRole('region', {
    name: /one file.*whole decision path/i,
  })
  await expect(workflow.getByRole('listitem')).toHaveCount(5)

  const pipeline = page.getByRole('list', {
    name: /color pipeline from raw development to jpeg/i,
  })
  await expect(pipeline.getByRole('listitem')).toHaveCount(7)

  const landingCopy = await main.textContent()
  for (const feature of [
    /progressive raw preview/i,
    /exposure/i,
    /temperature/i,
    /eight-band hsl/i,
    /histogram/i,
    /compare/i,
    /full-resolution jpeg/i,
    /local raw handling/i,
  ]) {
    expect(landingCopy).toMatch(feature)
  }

  const localWebp = main.locator('img[src$=".webp"]')
  expect(await localWebp.count()).toBeGreaterThan(0)
  await expect
    .poll(() =>
      localWebp
        .first()
        .evaluate((image) => image.complete && image.naturalWidth > 0),
    )
    .toBe(true)

  const imageSource = await localWebp.first().evaluate((image) => {
    const source = new URL(image.currentSrc)
    return {
      origin: source.origin,
      pageOrigin: window.location.origin,
      pathname: source.pathname,
    }
  })
  expect(imageSource.origin).toBe(imageSource.pageOrigin)
  expect(imageSource.pathname).toMatch(/\.webp$/i)

  const workspaceEvidence = page.getByRole('img', {
    name: /actual lumaforge raw lab session/i,
  })
  await workspaceEvidence.scrollIntoViewIfNeeded()
  await expect
    .poll(() =>
      workspaceEvidence.evaluate((image) => ({
        height: image.naturalHeight,
        loaded: image.complete && image.naturalWidth > 0,
        width: image.naturalWidth,
      })),
    )
    .toEqual({ height: 900, loaded: true, width: 1440 })

  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    'content',
    'oklch(0.075 0.006 255)',
  )

  const productCtas = page.locator(
    'nav a:not([target="_blank"]):not([href="/"]), main a:not([target="_blank"])',
  )
  expect(await productCtas.count()).toBeGreaterThanOrEqual(3)
  for (let index = 0; index < (await productCtas.count()); index += 1) {
    await expect(productCtas.nth(index)).toHaveAttribute('href', '/raw')
  }

  await page.evaluate(() => document.fonts.ready)
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - window.innerWidth,
    body: document.body.scrollWidth - window.innerWidth,
  }))
  expect(overflow.document).toBeLessThanOrEqual(1)
  expect(overflow.body).toBeLessThanOrEqual(1)

  expect(
    browserErrors,
    `unexpected browser errors:\n${browserErrors.join('\n')}`,
  ).toEqual([])
})

test('compare supports its complete keyboard range', async ({ page }) => {
  await openEnglishLanding(page)

  const slider = page.getByRole('slider')
  await expect(slider).toBeVisible()
  const minimum = Number(await slider.getAttribute('aria-valuemin'))
  const maximum = Number(await slider.getAttribute('aria-valuemax'))
  expect(minimum).toBeLessThan(maximum)

  await slider.focus()
  await page.keyboard.press('Home')
  await expect(slider).toHaveAttribute('aria-valuenow', String(minimum))

  await page.keyboard.press('ArrowRight')
  const afterRight = await readSliderValue(page)
  expect(afterRight).toBeGreaterThan(minimum)

  await page.keyboard.press('ArrowUp')
  const afterUp = await readSliderValue(page)
  expect(afterUp).toBeGreaterThan(afterRight)

  await page.keyboard.press('End')
  await expect(slider).toHaveAttribute('aria-valuenow', String(maximum))

  await page.keyboard.press('ArrowLeft')
  const afterLeft = await readSliderValue(page)
  expect(afterLeft).toBeLessThan(maximum)

  await page.keyboard.press('ArrowDown')
  expect(await readSliderValue(page)).toBeLessThan(afterLeft)
})

test('compare follows a real pointer drag', async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    'Mouse dragging is covered in the desktop browser project',
  )
  await openEnglishLanding(page)

  const slider = page.getByRole('slider')
  await slider.scrollIntoViewIfNeeded()
  const box = await slider.boundingBox()
  expect(box).toBeTruthy()
  const before = await readSliderValue(page)

  await page.mouse.move(box!.x + box!.width * 0.22, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width * 0.78, box!.y + box!.height / 2, {
    steps: 12,
  })
  await page.mouse.up()

  await expect.poll(() => readSliderValue(page)).toBeGreaterThan(before)
})

test('locale choice survives a reload', async ({ page }) => {
  await openEnglishLanding(page)

  const localeToggle = page.getByRole('button', {
    name: 'Switch to Chinese',
  })
  await localeToggle.click()
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: /完成一张 raw/i,
    }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Switch to English' }),
  ).toBeVisible()
  expect(
    await page.evaluate(
      (key) => window.localStorage.getItem(key),
      LOCALE_STORAGE_KEY,
    ),
  ).toBe('zh-CN')
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')

  await page.reload()
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: /完成一张 raw/i,
    }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Switch to English' }),
  ).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
})

test('intermediate desktop keeps the workflow editorial gutter', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium-desktop',
    'The intermediate desktop breakpoint is covered in Chromium',
  )
  await page.setViewportSize({ width: 920, height: 900 })
  await openEnglishLanding(page)

  const layout = await page.locator('.lf-workflow-list').evaluate((list) => {
    const bounds = list.getBoundingClientRect()

    return {
      documentWidth: document.documentElement.scrollWidth,
      rightGutter: window.innerWidth - bounds.right,
      viewportWidth: window.innerWidth,
    }
  })

  expect(layout.rightGutter).toBeGreaterThanOrEqual(40)
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth + 1)
})

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' })

  test('keeps the complete landing content visible', async ({ page }) => {
    await openEnglishLanding(page)

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByRole('slider')).toBeVisible()
    await expect(
      page.getByRole('heading', { name: /open the raw lab.*finish/i }),
    ).toBeVisible()
  })
})

test('mobile navigation and controls fit safe touch geometry', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'webkit-ios-safe',
    'Touch geometry targets the configured iPhone WebKit project',
  )
  await openEnglishLanding(page)

  const navCta = page
    .getByRole('navigation')
    .getByRole('link', { name: 'Open RAW lab' })
  await expect(navCta).toBeVisible()
  await expect(navCta.locator('span')).toBeVisible()
  expect(
    await navCta.evaluate(
      (element) =>
        getComputedStyle(element).backgroundColor !== 'rgba(0, 0, 0, 0)',
    ),
  ).toBe(true)
  await expect(page.getByRole('slider')).toHaveCSS('touch-action', 'pan-y')

  const measurements = await page.evaluate(() => {
    const targets = Array.from(
      document.querySelectorAll<HTMLElement>(
        'nav a, nav button, main a, footer a, [role="slider"]',
      ),
    ).map((element) => {
      const bounds = element.getBoundingClientRect()
      return {
        name:
          element.getAttribute('aria-label') ||
          element.textContent?.trim() ||
          element.tagName,
        height: bounds.height,
        width: bounds.width,
        left: bounds.left,
        right: bounds.right,
      }
    })
    const navBounds = document.querySelector('nav')!.getBoundingClientRect()

    return {
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      nav: {
        left: navBounds.left,
        right: navBounds.right,
        width: navBounds.width,
      },
      targets,
    }
  })

  expect(measurements.documentWidth).toBeLessThanOrEqual(
    measurements.viewportWidth + 1,
  )
  expect(measurements.bodyWidth).toBeLessThanOrEqual(
    measurements.viewportWidth + 1,
  )
  expect(measurements.nav.left).toBeGreaterThanOrEqual(-0.5)
  expect(measurements.nav.right).toBeLessThanOrEqual(
    measurements.viewportWidth + 0.5,
  )
  expect(measurements.nav.width).toBeLessThanOrEqual(
    measurements.viewportWidth + 1,
  )

  for (const target of measurements.targets) {
    expect
      .soft(target.width, `${target.name} touch width`)
      .toBeGreaterThanOrEqual(44)
    expect
      .soft(target.height, `${target.name} touch height`)
      .toBeGreaterThanOrEqual(44)
    expect
      .soft(target.left, `${target.name} left edge`)
      .toBeGreaterThanOrEqual(-0.5)
    expect
      .soft(target.right, `${target.name} right edge`)
      .toBeLessThanOrEqual(measurements.viewportWidth + 0.5)
  }

  const slider = page.getByRole('slider')
  await slider.scrollIntoViewIfNeeded()
  const box = await slider.boundingBox()
  expect(box).toBeTruthy()
  const before = await readSliderValue(page)
  await page.touchscreen.tap(
    box!.x + box!.width * 0.72,
    box!.y + box!.height / 2,
  )
  await expect.poll(() => readSliderValue(page)).toBeGreaterThan(before)
})
