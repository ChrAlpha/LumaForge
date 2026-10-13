import { Buffer } from 'node:buffer'
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

import type { BrowserContext, Locator, Page, TestInfo } from '@playwright/test'
import { expect, test } from '@playwright/test'

import type { JpegFile } from './support/files'
import {
  createCube,
  downloadJpeg,
  downloadManifest,
  EXPORT_JPEG_QUALITY_PERCENT,
  sha256,
} from './support/files'
import {
  EXPOSURE_RAW,
  gateRawFixture,
  PUBLIC_DNG,
  PUBLIC_DNG_SIZE,
  RAW_FIXTURE,
} from './support/fixtures'
import type { CanvasDigest } from './support/frames'
import {
  nextCpuFrame,
  readCanvas,
  settledCpuFrame,
  settledFrameHash,
} from './support/frames'
import {
  chooseRaw,
  cpuCanvas,
  deck,
  dockTab,
  dockTabs,
  expectWebGPUPreview,
  exportAction,
  exportFullResolution,
  exportSurface,
  gpuCanvas,
  isChromium,
  lens,
  loadedLab,
  loadRaw,
  lookStrip,
  nudgeExposure,
  openLab,
  openTool,
  restoreButton,
  splitSlider,
  stage,
  strengthSlider,
} from './support/lab'
import type { PageTrace } from './support/trace'
import {
  eventIndex,
  eventPayload,
  IDLE_GAP_MIN_MS,
  RAW_RUNTIME_IDLE_MS,
  rawWorkers,
  readTrace,
  release,
  requested,
  sessionWorker,
  setTrace,
  workerByIndex,
} from './support/trace'

// The mobile /raw surfaces, driven only through what a user does: the dock
// and its deck, the compare lens, the topbar Export and the panel it borrows
// the deck for, the More menu, the Look strip with its inline contract and
// Strength, and the released preview after an export. The Chromium project
// runs them at a phone viewport on the GPU preview unless a test forces the
// CPU; the WebKit project (no WebGPU adapter) runs the CPU preview.

/** Owners an export evacuates before its worker starts, in order. */
const PRE_EXPORT_OWNERS = [
  'preview',
  'bounded-hq',
  'gpu',
  'export-result',
  'lut-fetch',
]

/** The mobile lab on the CPU preview, forced on Chromium. */
async function openMobileCpuLab(page: Page, testInfo: TestInfo) {
  await openLab(page, testInfo, {
    surface: 'mobile',
    path: isChromium(testInfo) ? '/raw?forcePreview=cpu' : '/raw',
  })
  await expect(page.locator('[data-cpu-preview-banner]')).toBeVisible()
  await expect(page.getByText(/GPU preview unavailable/)).toBeVisible()
}

async function holdLens(page: Page) {
  // Hovering first waits until nothing (a toast) covers the lens.
  await lens(page).hover()
  await page.mouse.down()
  // Past the 250ms long press.
  await page.waitForTimeout(450)
}

/** No split surface on the CPU preview: no handle and no stage toggle row. */
async function expectNoSplit(page: Page) {
  await expect(splitSlider(page)).toHaveCount(0)
  await expect(
    stage(page).getByRole('button', { name: 'Original' }),
  ).toHaveCount(0)
}

/**
 * The lens each executor offers: the GPU preview's tap opens the split and a
 * second tap closes it; the CPU preview's tap pins the original, which the
 * CPU worker draws as its neutral variant, and a second tap returns.
 */
async function expectExecutorLens(page: Page, gpu: boolean) {
  await expect(lens(page)).toBeVisible({ timeout: 60_000 })
  await expect(lens(page)).toHaveAttribute('aria-pressed', 'false')
  await expect(splitSlider(page)).toHaveCount(0)
  await lens(page).hover()
  if (gpu) {
    await expect(lens(page)).toHaveAttribute('data-lens-mode', 'split')
    await expect(lens(page)).toHaveAccessibleName('Split compare')
    await lens(page).click()
    await expect(lens(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(splitSlider(page)).toBeVisible()
    await lens(page).click()
    await expect(lens(page)).toHaveAttribute('aria-pressed', 'false')
    await expect(splitSlider(page)).toHaveCount(0)
    return
  }
  await expect(lens(page)).toHaveAttribute('data-lens-mode', 'original')
  await expect(lens(page)).toHaveAccessibleName('Show original')
  const processed = await settledCpuFrame(page)
  const before = (await readTrace(page)).cpuRenders.length
  await lens(page).click()
  await expect(lens(page)).toHaveAttribute('aria-pressed', 'true')
  await expect
    .poll(
      async () =>
        (await readTrace(page)).cpuRenders.slice(before).map((r) => r.variant),
      { timeout: 60_000 },
    )
    .toEqual(['neutral'])
  expect((await settledCpuFrame(page)).hash).not.toBe(processed.hash)
  await expectNoSplit(page)
  await lens(page).click()
  await expect(lens(page)).toHaveAttribute('aria-pressed', 'false')
  await expect
    .poll(async () => (await readTrace(page)).cpuRenders.at(-1)?.variant, {
      timeout: 60_000,
    })
    .toBe('processed')
  expect((await settledCpuFrame(page)).hash).toBe(processed.hash)
}

/** Rows of one fact list in the File & pipeline sheet, keyed by label. */
async function readFactRows(sheet: Locator, heading: string) {
  return sheet
    .locator('section')
    .filter({ has: sheet.page().getByRole('heading', { name: heading }) })
    .locator('dl')
    .evaluate((list) => {
      const rows: Record<string, string> = {}
      for (const term of Array.from(list.querySelectorAll('dt'))) {
        rows[term.textContent?.trim() ?? ''] =
          term.nextElementSibling?.textContent?.trim() ?? ''
      }
      return rows
    })
}

async function readPipelineSteps(sheet: Locator) {
  return sheet
    .locator('section')
    .filter({
      has: sheet.page().getByRole('heading', { name: 'Color pipeline' }),
    })
    .locator('ol > li')
    .evaluateAll((items) =>
      items.map((item) => {
        const parts = item.querySelectorAll(':scope > span:last-child > span')
        return {
          label: parts[0]?.textContent?.trim() ?? '',
          detail: parts[1]?.textContent?.trim() ?? '',
        }
      }),
    )
}

async function openFileDetails(page: Page) {
  await page.getByRole('button', { name: 'More actions' }).click()
  await page
    .getByRole('menuitem', { name: 'File & pipeline details', exact: true })
    .click()
  const sheet = page.getByRole('dialog', { name: 'File & pipeline' })
  await expect(sheet).toBeVisible()
  return sheet
}

async function closeFileDetails(page: Page) {
  const sheet = page.getByRole('dialog', { name: 'File & pipeline' })
  await sheet
    .getByRole('button', { name: 'Close file & pipeline details' })
    .click()
  await expect(sheet).toHaveCount(0)
}

/**
 * The File facts rows for the public DNG. On the GPU preview the preview
 * size and its render time are measured; the CPU worker measures neither,
 * so those rows may only say so or carry a real measurement.
 */
async function expectPublicDngFileFacts(sheet: Locator, gpu: boolean) {
  const files = await readFactRows(sheet, 'File facts')
  expect(Object.keys(files)).toEqual([
    'Camera',
    'Support',
    'Size',
    'Preview',
    'Preview render',
    'Processing',
  ])
  expect(files.Camera).toBe('Apple iPhone8,4 back camera')
  expect(files.Support).toBe('Experimental support')
  expect(files.Size).toBe(
    `${PUBLIC_DNG_SIZE.width} x ${PUBLIC_DNG_SIZE.height}`,
  )
  expect(files.Processing).toBe('This browser, nothing uploaded')
  const previewSize = /^(\d+) x (\d+)$/.exec(files.Preview ?? '')
  if (gpu || previewSize) {
    expect(
      previewSize,
      `measured preview size: ${files.Preview}`,
    ).not.toBeNull()
    const [width, height] = [Number(previewSize![1]), Number(previewSize![2])]
    expect(width).toBeLessThanOrEqual(PUBLIC_DNG_SIZE.width)
    expect(width / height).toBeCloseTo(
      PUBLIC_DNG_SIZE.width / PUBLIC_DNG_SIZE.height,
      1,
    )
  } else {
    expect(files.Preview).toBe('Not loaded')
  }
  expect(files['Preview render']).toMatch(
    gpu ? /^\d+ ms$/ : /^(Not loaded|\d+ ms)$/,
  )
  return files
}

/** Opens the Look strip's Import .cube and picks `path`. */
async function importCube(page: Page, path: string) {
  await openTool(page, 'Look')
  const importing = page.waitForEvent('filechooser')
  await lookStrip(page).getByRole('button', { name: 'Import .cube' }).click()
  await (await importing).setFiles(path)
}

/** Nothing resolved an imported file, so its contract opens in the deck. */
function contractInput(page: Page) {
  return page.getByRole('region', { name: /: input$/ })
}

/** The recommended pair completes an open contract in one tap. */
async function applyRecommendedContract(page: Page) {
  await contractInput(page)
    .getByRole('group', { name: 'Recommended input' })
    .getByRole('button', { name: 'Display sRGB · Apply' })
    .click()
  await expect(lookStrip(page)).toBeVisible()
  await expect(
    lookStrip(page).locator('[data-mobile-lut-tile="custom"]'),
  ).toHaveAttribute('data-state', 'applied')
}

/** One step of Strength and back: an edit that leaves the intent as it was. */
async function touchStrength(page: Page) {
  await openTool(page, 'Look')
  const strength = strengthSlider(page)
  await expect(strength).not.toHaveAttribute('data-disabled')
  const value = Number.parseInt(
    (await strength.getAttribute('aria-valuetext')) ?? '',
    10,
  )
  expect(value).toBeLessThan(100)
  await strength.focus()
  await page.keyboard.press('ArrowRight')
  await expect(strength).toHaveAttribute('aria-valuetext', `${value + 1}%`)
  await page.keyboard.press('ArrowLeft')
  await expect(strength).toHaveAttribute('aria-valuetext', `${value}%`)
}

async function expectReleasedPreview(page: Page) {
  await expect(
    stage(page).getByRole('button', { name: 'Restore preview' }),
  ).toBeVisible()
  for (const name of ['Look', 'Adjust', 'Transform'] as const) {
    await expect(dockTab(page, name)).toBeDisabled()
  }
  await expect(lens(page)).toHaveCount(0)
  await expect(deck(page).getByRole('slider')).toHaveCount(0)
}

async function closeExportPanel(page: Page) {
  await exportSurface(page)
    .getByRole('button', { name: 'Close export' })
    .click()
  await expect(exportSurface(page)).toHaveCount(0)
  await expect(exportAction(page)).toHaveAttribute('aria-expanded', 'false')
}

/** Every raw-render exposure the CPU preview has drawn a processed frame at. */
function cpuProcessedExposures(trace: PageTrace) {
  return [
    ...new Set(
      trace.cpuRenders
        .filter((render) => render.variant === 'processed')
        .map((render) => render.ev),
    ),
  ]
}

/** The mean light of a JPEG as this browser decodes it, on a small canvas. */
async function decodedMeanLight(page: Page, jpeg: JpegFile) {
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: 'image/jpeg' }),
    )
    const canvas = new OffscreenCanvas(256, 192)
    const context = canvas.getContext('2d')!
    context.drawImage(bitmap, 0, 0, 256, 192)
    const pixels = context.getImageData(0, 0, 256, 192).data
    let light = 0
    for (let offset = 0; offset < pixels.length; offset += 4) {
      light += (pixels[offset]! + pixels[offset + 1]! + pixels[offset + 2]!) / 3
    }
    return light / (pixels.length / 4)
  }, jpeg.bytes.toString('base64'))
}

test('mobile CPU lab: tools stay in the dock, compare on the stage lens and Export in the topbar; the lens switches executors and the frame survives a resize', async ({
  page,
}, testInfo) => {
  const rawPath = gateRawFixture(testInfo, PUBLIC_DNG)
  testInfo.setTimeout(240_000)
  await openMobileCpuLab(page, testInfo)
  await loadRaw(page, rawPath)

  // The dock holds the three tools and nothing else.
  await expect(dockTabs(page)).toHaveText(['Look', 'Adjust', 'Transform'])
  await expect(dockTab(page, 'Look')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { name: /compare|export/i })).toHaveCount(
    0,
  )

  // Compare is a lens on the photograph. The CPU preview has no split
  // surface, so the lens is an original toggle and no split control exists.
  await expect(lens(page)).toHaveAttribute('data-lens-mode', 'original')
  await expect(lens(page)).toHaveAccessibleName('Show original')
  await expect(lens(page)).toHaveAttribute('aria-pressed', 'false')
  const stageBox = (await stage(page).boundingBox())!
  const lensBox = (await lens(page).boundingBox())!
  expect(lensBox.x).toBeGreaterThanOrEqual(stageBox.x - 1)
  expect(lensBox.y).toBeGreaterThanOrEqual(stageBox.y - 1)
  expect(lensBox.x + lensBox.width).toBeLessThanOrEqual(
    stageBox.x + stageBox.width + 1,
  )
  expect(lensBox.y + lensBox.height).toBeLessThanOrEqual(
    stageBox.y + stageBox.height + 1,
  )
  await expectNoSplit(page)

  // Export is the topbar action; it borrows the deck and hands it back to
  // the tool that held it.
  await expect(exportAction(page)).toHaveAttribute('data-state', 'ready', {
    timeout: 60_000,
  })
  await exportAction(page).click()
  await expect(exportAction(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(exportSurface(page)).toBeVisible()
  for (const tab of await dockTabs(page).all()) {
    await expect(tab).toHaveAttribute('aria-selected', 'false')
  }
  await closeExportPanel(page)
  await expect(lookStrip(page)).toBeVisible()
  await expect(dockTab(page, 'Look')).toHaveAttribute('aria-selected', 'true')

  // A visible edit, so the processed and the neutral executors differ.
  const unedited = await settledCpuFrame(page)
  await nudgeExposure(page, 10)
  const processed = await nextCpuFrame(page, unedited)
  expect(processed.meanLight).toBeGreaterThan(unedited.meanLight + 4)
  const rendersBeforeLens = (await readTrace(page)).cpuRenders.length
  expect((await readTrace(page)).cpuRenders.at(-1)?.variant).toBe('processed')

  // Tap: the CPU worker renders the neutral variant and the canvas shows it.
  await lens(page).click()
  await expect(lens(page)).toHaveAttribute('aria-pressed', 'true')
  const neutral = await nextCpuFrame(page, processed)
  expect(
    (await readTrace(page)).cpuRenders
      .slice(rendersBeforeLens)
      .map((render) => render.variant),
  ).toEqual(['neutral'])
  expect(neutral.meanLight).toBeLessThan(processed.meanLight - 4)
  await expectNoSplit(page)

  // Tap again: back to the processed executor and the same frame.
  await lens(page).click()
  await expect(lens(page)).toHaveAttribute('aria-pressed', 'false')
  expect((await nextCpuFrame(page, neutral)).hash).toBe(processed.hash)

  // Hold peeks the original; release hands back the processed photo, and a
  // hold is never a tap.
  await holdLens(page)
  expect((await nextCpuFrame(page, processed)).hash).toBe(neutral.hash)
  await page.mouse.up()
  expect((await nextCpuFrame(page, neutral)).hash).toBe(processed.hash)
  await expect(lens(page)).toHaveAttribute('aria-pressed', 'false')

  // A cancelled hold ends the peek the same way.
  await lens(page).evaluate((element) => {
    element.addEventListener(
      'pointerdown',
      (event) => {
        ;(window as unknown as { __lensPointer: number }).__lensPointer = (
          event as PointerEvent
        ).pointerId
      },
      { once: true },
    )
  })
  await holdLens(page)
  expect((await nextCpuFrame(page, processed)).hash).toBe(neutral.hash)
  await lens(page).evaluate((element) => {
    element.dispatchEvent(
      new PointerEvent('pointercancel', {
        bubbles: true,
        pointerId: (window as unknown as { __lensPointer: number })
          .__lensPointer,
        pointerType: 'mouse',
      }),
    )
  })
  expect((await nextCpuFrame(page, neutral)).hash).toBe(processed.hash)
  await page.mouse.up()
  await expect(lens(page)).toHaveAttribute('aria-pressed', 'false')
  expect((await settledCpuFrame(page)).hash).toBe(processed.hash)

  // A press that slides off before the hold lands is neither a tap nor a
  // peek.
  const box = (await lens(page).boundingBox())!
  await lens(page).hover()
  await page.mouse.down()
  await page.mouse.move(box.x - 30, box.y + box.height + 30, { steps: 4 })
  await page.mouse.up()
  await page.waitForTimeout(400)
  await expect(lens(page)).toHaveAttribute('aria-pressed', 'false')
  expect((await settledCpuFrame(page)).hash).toBe(processed.hash)

  // From a pinned original, a hold keeps the original and its release
  // returns to the pin, not to the processed photo.
  await lens(page).click()
  await expect(lens(page)).toHaveAttribute('aria-pressed', 'true')
  expect((await nextCpuFrame(page, processed)).hash).toBe(neutral.hash)
  await holdLens(page)
  await page.mouse.up()
  await expect(lens(page)).toHaveAttribute('aria-pressed', 'true')
  expect((await settledCpuFrame(page)).hash).toBe(neutral.hash)
  // Changing tools drops the pin, so the next edit is seen: the processed
  // executor renders again.
  await openTool(page, 'Look')
  await expect(lens(page)).toHaveAttribute('aria-pressed', 'false')
  const edited = await nextCpuFrame(page, neutral)
  expect(edited.hash).toBe(processed.hash)
  expect((await readTrace(page)).cpuRenders.at(-1)?.variant).toBe('processed')
  await expectNoSplit(page)

  // A tap on the photo goes immersive and the stage takes the whole screen.
  // The frame already on the canvas is redrawn at the new box without a new
  // render, and again on the way back.
  const rendersBeforeResize = (await readTrace(page)).cpuRenders.length
  const dpr = await page.evaluate(() => Math.min(window.devicePixelRatio, 2))
  const expectRedrawnWithoutRender = async (from: CanvasDigest) => {
    // Redrawn: the backing store follows the new box, which a resize alone
    // (the canvas stretched by CSS) would not do.
    await expect
      .poll(async () => {
        const next = await readCanvas(cpuCanvas(page))
        return (
          `${next.boxWidth}x${next.boxHeight}` !==
            `${from.boxWidth}x${from.boxHeight}` &&
          next.width === Math.round(next.boxWidth * dpr) &&
          next.height === Math.round(next.boxHeight * dpr)
        )
      })
      .toBe(true)
    const resized = await settledCpuFrame(page)
    expect(resized.width).toBe(Math.round(resized.boxWidth * dpr))
    expect(resized.height).toBe(Math.round(resized.boxHeight * dpr))
    expect(Math.abs(resized.meanLight - edited.meanLight)).toBeLessThan(3)
    expect((await readTrace(page)).cpuRenders).toHaveLength(rendersBeforeResize)
    return resized
  }
  const tapPhoto = async () => {
    const photo = (await cpuCanvas(page).boundingBox())!
    await page.mouse.click(
      photo.x + photo.width / 2,
      photo.y + photo.height / 2,
    )
  }
  await tapPhoto()
  await expect(page.getByRole('banner')).toHaveCount(0)
  const immersive = await expectRedrawnWithoutRender(edited)
  await tapPhoto()
  await expect(page.getByRole('banner')).toBeVisible()
  await expectRedrawnWithoutRender(immersive)
  await expectNoSplit(page)
})

test('the More menu holds real actions; support and measured facts read in the topbar and File & pipeline details', async ({
  page,
}, testInfo) => {
  const rawPath = gateRawFixture(testInfo, PUBLIC_DNG)
  testInfo.setTimeout(240_000)
  await openMobileCpuLab(page, testInfo)
  await loadRaw(page, rawPath)

  // The public DNG is not on the official support matrix: the topbar names
  // that level beside the camera rather than by colour alone.
  const topbar = page.getByRole('banner')
  await expect(topbar).toContainText('Experimental support')
  await expect(topbar).not.toContainText('Official support')

  // The menu lists actions only, each of which does something.
  await page.getByRole('button', { name: 'More actions' }).click()
  const menu = page.getByRole('menu')
  await expect(
    menu.getByRole('menuitem').or(menu.getByRole('menuitemcheckbox')),
  ).toHaveText([
    'Replace RAW',
    'File & pipeline details',
    'Histogram',
    'LanguageEnglish',
    'Reset session',
  ])
  await expect(menu).not.toContainText(/support/i)
  const choosing = page.waitForEvent('filechooser')
  await menu.getByRole('menuitem', { name: 'Replace RAW' }).click()
  const replacing = await choosing
  expect(replacing.isMultiple()).toBe(false)
  // Choosing nothing closes the picker and keeps the open RAW.
  await replacing.setFiles([])
  await expect(
    page.getByRole('heading', { name: basename(rawPath) }),
  ).toBeVisible()

  await page.getByRole('button', { name: 'More actions' }).click()
  const histogram = page.getByRole('menuitemcheckbox', { name: 'Histogram' })
  await expect(histogram).toHaveAttribute('aria-checked', 'false')
  await histogram.click()
  await expect(page.locator('[data-mobile-histogram-card]')).toBeVisible()
  await page.getByRole('button', { name: 'More actions' }).click()
  await expect(histogram).toHaveAttribute('aria-checked', 'true')
  await histogram.click()
  await expect(page.locator('[data-mobile-histogram-card]')).toHaveCount(0)

  // Language switches the lab's copy, and the same item switches it back.
  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: /^Language/ }).click()
  await expect(topbar).toContainText('实验支持')
  await page.getByRole('button', { name: '更多操作' }).click()
  const chinese = page.getByRole('menuitem', { name: /^语言/ })
  await expect(chinese).toContainText('中文')
  await chinese.click()
  await expect(topbar).toContainText('Experimental support')

  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Reset session' }).click()
  const reset = page.getByRole('alertdialog', { name: 'Reset session' })
  await expect(reset).toBeVisible()
  await reset.getByRole('button', { name: 'Cancel' }).click()
  await expect(reset).toHaveCount(0)
  await expect(loadedLab(page)).toBeVisible()

  // File & pipeline details: measured facts, each in its own row. The CPU
  // worker does not time its renders, so no render time is invented.
  let sheet = await openFileDetails(page)
  const files = await expectPublicDngFileFacts(sheet, false)
  await expect(topbar).toContainText(files.Camera!)
  // No LUT yet: the contract reads as unused and Output names the
  // full-resolution JPEG it can write.
  expect(await readFactRows(sheet, 'LUT contract')).toEqual({
    LUT: 'Not used',
  })
  const steps = await readPipelineSteps(sheet)
  expect(steps.map((step) => step.label)).toEqual([
    'RAW decode',
    'Adjust',
    'LUT',
    'Transform',
    'Output',
  ])
  expect(steps[0]!.detail).toBe(`${files.Camera} · Experimental support`)
  expect(steps[2]!.detail).toBe('Not used')
  expect(steps[4]!.detail).toBe('Full-resolution JPEG')
  await closeFileDetails(page)

  // Build the Look through its own entry points: the LUT sources sheet,
  // the strip's import, the contract chosen inline, then Strength.
  await openTool(page, 'Look')
  await page.getByRole('button', { name: 'LUT sources' }).click()
  const sources = page.getByRole('dialog', { name: 'LUT sources' })
  await expect(sources).toBeVisible()
  await sources.getByRole('button', { name: 'Close LUT sources' }).click()
  await expect(sources).toHaveCount(0)

  // Named for its contract, so the import recommends Display sRGB.
  const cubePath = testInfo.outputPath('display-srgb.cube')
  await writeFile(cubePath, createCube('Display sRGB'), 'utf8')
  await importCube(page, cubePath)
  await expect(contractInput(page)).toBeVisible({ timeout: 60_000 })

  // While the contract is open the LUT cannot be confirmed, so no JPEG can
  // be written yet.
  sheet = await openFileDetails(page)
  expect((await readFactRows(sheet, 'LUT contract')).Contract).toBe(
    'Needs contract',
  )
  expect((await readPipelineSteps(sheet))[4]!.detail).not.toBe(
    'Full-resolution JPEG',
  )
  await closeFileDetails(page)

  await applyRecommendedContract(page)
  const strength = strengthSlider(page)
  await expect(strength).not.toHaveAttribute('data-disabled')
  await expect(strength).toHaveAttribute('aria-valuetext', '70%')
  await strength.focus()
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect(strength).toHaveAttribute('aria-valuetext', '59%')

  sheet = await openFileDetails(page)
  const look = await readFactRows(sheet, 'LUT contract')
  expect(look.LUT).toBeTruthy()
  expect(look.Contract).toMatch(/^Contract confirmed · /)
  const confirmedSteps = await readPipelineSteps(sheet)
  expect(confirmedSteps[2]!.detail).toBe(`${look.LUT} · Contract confirmed`)
  expect(confirmedSteps[4]!.detail).toBe('Full-resolution JPEG')
  await closeFileDetails(page)

  // The export recap writes what the details promise: the source size and
  // the look at its continuous strength.
  await exportAction(page).click()
  const recap = exportSurface(page).locator('[data-export-recap]')
  await expect(recap).toContainText(
    `Full-resolution JPEG · ${PUBLIC_DNG_SIZE.width}×${PUBLIC_DNG_SIZE.height}`,
  )
  await expect(recap).toContainText('59%')
})

test('export round trip on the executor’s own preview: a 37% look at quality 92 with the DNG baseline exposure, the preview released with its runtime ended, delivery, Restore on a fresh runtime, and a byte-identical re-export', async ({
  page,
}, testInfo) => {
  const rawPath = gateRawFixture(testInfo, PUBLIC_DNG)
  testInfo.setTimeout(900_000)
  const gpu = isChromium(testInfo)
  await openLab(page, testInfo, { surface: 'mobile' })
  // The loaded RAW's runtime may not idle out before the export: with its
  // idle window held, only an explicit end can stop it.
  await setTrace(page, { holdIdleTimers: true })
  await loadRaw(page, rawPath)
  const loadedOn = sessionWorker(await readTrace(page))!
  // The load gave its runtime back, and the idle end that would follow is
  // held.
  await expect
    .poll(async () => (await readTrace(page)).heldIdleTimers, {
      timeout: 60_000,
    })
    .toBeGreaterThanOrEqual(1)

  if (gpu) {
    // The GPU preview measures its preview size and its own render time.
    await expectWebGPUPreview(page, testInfo)
    await expect(page.locator('[data-cpu-preview-banner]')).toHaveCount(0)
    await expect(page.getByRole('banner')).toContainText(
      'Experimental support · Apple iPhone8,4 back camera',
    )
    const sheet = await openFileDetails(page)
    await expectPublicDngFileFacts(sheet, true)
    expect((await readPipelineSteps(sheet))[4]!.detail).toBe(
      'Full-resolution JPEG',
    )
    await closeFileDetails(page)
  } else {
    await expect(page.locator('[data-cpu-preview-banner]')).toBeVisible()
  }
  await expect(dockTabs(page)).toHaveText(['Look', 'Adjust', 'Transform'])

  // The Look: a local .cube that darkens every channel, its contract chosen
  // inline, Strength at 37%, which the preview draws differently from the
  // 70% default.
  // Named for its contract, so the import recommends Display sRGB.
  const cubePath = testInfo.outputPath('display-srgb.cube')
  await writeFile(
    cubePath,
    createCube('Display sRGB', (value) => value * 0.55),
    'utf8',
  )
  await importCube(page, cubePath)
  await expect(contractInput(page)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await applyRecommendedContract(page)
  const at70 = await settledFrameHash(page, gpu)
  const strength = strengthSlider(page)
  await expect(strength).toHaveAttribute('aria-valuetext', '70%')
  await strength.focus()
  for (let step = 0; step < 3; step += 1) {
    await page.keyboard.press('Shift+ArrowLeft')
  }
  for (let step = 0; step < 3; step += 1) await page.keyboard.press('ArrowLeft')
  await expect(strength).toHaveAttribute('aria-valuetext', '37%')
  await expect
    .poll(() => settledFrameHash(page, gpu), { timeout: 60_000 })
    .not.toBe(at70)

  // An Adjust panel is open and edited when the export starts.
  const exposure = await nudgeExposure(page, 5)
  const exposureValue = (await exposure.getAttribute('aria-valuenow'))!
  await settledFrameHash(page, gpu)

  // Export borrows the deck: no tool stays selected while it is open, and
  // closing it hands the deck back. Quality is fixed, so the panel offers
  // no quality or fidelity choice.
  await openTool(page, 'Export')
  const panel = exportSurface(page)
  for (const tab of await dockTabs(page).all()) {
    await expect(tab).toHaveAttribute('aria-selected', 'false')
  }
  const recap = panel.locator('[data-export-recap]')
  await expect(recap).toContainText(
    `Full-resolution JPEG · ${PUBLIC_DNG_SIZE.width}×${PUBLIC_DNG_SIZE.height}`,
  )
  await expect(recap).toContainText('· 37%')
  await expect(panel.getByRole('radio')).toHaveCount(0)
  await expect(panel.getByRole('combobox')).toHaveCount(0)
  await expect(panel.getByRole('slider')).toHaveCount(0)
  await expect(panel).not.toContainText(/quality|fidelity/i)
  await closeExportPanel(page)
  await expect(dockTab(page, 'Adjust')).toHaveAttribute('aria-selected', 'true')

  // The GPU preview also writes the HQ preview JPEG from its bounded HQ
  // frame, at the app's one quality. The HQ result stands until an edit,
  // which clears it for the full export.
  let hq: JpegFile | null = null
  if (gpu) {
    await openTool(page, 'Export')
    const hqExport = panel.getByRole('button', {
      name: 'Export HQ preview JPEG',
    })
    await expect(hqExport).toBeEnabled({ timeout: 120_000 })
    await hqExport.click()
    await expect(exportAction(page)).toHaveAttribute(
      'data-state',
      'preview-done',
      { timeout: 120_000 },
    )
    await expect(panel).toContainText('HQ preview JPEG ready')
    hq = await downloadJpeg(page)
    await expect(panel).toContainText(`${hq.width} x ${hq.height}`)
    expect(hq.quality).toBe(EXPORT_JPEG_QUALITY_PERCENT)
    expect(hq.width).toBeLessThanOrEqual(PUBLIC_DNG_SIZE.width)
    expect(hq.width / hq.height).toBeCloseTo(
      PUBLIC_DNG_SIZE.width / PUBLIC_DNG_SIZE.height,
      2,
    )
    await closeExportPanel(page)
    await touchStrength(page)
    await openTool(page, 'Adjust')
  }

  // The full-resolution export evacuates the preview first: the preview's
  // runtime is ended by the export, before the export's own worker starts.
  await openTool(page, 'Export')
  await expect(
    panel.getByRole('button', { name: 'Export full-resolution JPEG' }),
  ).toBeEnabled({ timeout: 60_000 })
  const exportClickedAt = await page.evaluate(() => performance.now())
  expect(
    workerByIndex(await readTrace(page), loadedOn.index).terminatedAt,
  ).toBeNull()
  await panel
    .getByRole('button', { name: 'Export full-resolution JPEG' })
    .click()
  await expect(exportAction(page)).toHaveAttribute('data-state', 'done', {
    timeout: 300_000,
  })
  let trace = await readTrace(page)
  // From here on the idle window runs as it does for a user.
  await release(page, 'idleTimers')
  const ended = workerByIndex(trace, loadedOn.index)
  expect(ended.terminatedAt).not.toBeNull()
  expect(ended.terminatedAt!).toBeGreaterThan(exportClickedAt)
  const exportWorker = trace.workers.find(
    (worker) => worker.kind === 'export' && worker.createdAt > exportClickedAt,
  )
  expect(exportWorker, 'the export ran on its own worker').toBeTruthy()
  expect(ended.terminatedAt!).toBeLessThanOrEqual(exportWorker!.createdAt)
  expect(rawWorkers(trace).filter((worker) => !worker.terminatedAt)).toEqual([])

  const events = trace.exportEvents
  const plan = eventPayload(events, 'export-plan-selected')!
  expect(eventIndex(events, 'resource-evacuated')).toBeGreaterThan(
    eventIndex(events, 'export-plan-selected'),
  )
  expect(eventIndex(events, 'export-worker-attempt')).toBeGreaterThan(
    eventIndex(events, 'resource-evacuated'),
  )
  const evacuated = eventPayload(events, 'resource-evacuated')!
  expect(evacuated.registryCheck).toMatchObject({ ok: true })
  expect(evacuated.requiredOwners).toEqual(PRE_EXPORT_OWNERS)
  expect(evacuated.disposedOwners).toEqual(PRE_EXPORT_OWNERS)
  expect(evacuated.remainingLive).toEqual([])
  expect(eventPayload(events, 'export-worker-attempt')).toMatchObject({
    attempt: 1,
    phase: 'started',
    freshWorker: true,
  })
  // No export writes a recovery journal, whatever its sink.
  expect(events.map((event) => event.type)).not.toContain('checkpoint-written')
  if (!gpu) {
    // A phone-class WebKit exports on the low-memory runtime; a 12MP JPEG is
    // small enough to hand off as a blob.
    expect(plan).toMatchObject({
      runtimeMemoryProfile: 'low-memory',
      outputSink: 'blob-handoff',
    })
  }

  // Released: the tools lock and the lens leaves, while the file and its
  // manifest deliver and agree with the source and the look.
  await expectReleasedPreview(page)
  await expect(panel).toContainText('Exported')
  const first = await downloadJpeg(page)
  const firstManifest = await downloadManifest(page)
  await expect(panel).toContainText(`${first.width} x ${first.height}`)
  const { manifest } = firstManifest
  expect(manifest.output.sha256).toBe(first.sha256)
  expect(manifest.output.filename).toBe(first.name)
  expect({ width: first.width, height: first.height }).toEqual(PUBLIC_DNG_SIZE)
  expect(manifest.output.dimensions).toEqual(PUBLIC_DNG_SIZE)
  expect(manifest.output.quality).toBe(EXPORT_JPEG_QUALITY_PERCENT)
  expect(first.quality).toBe(EXPORT_JPEG_QUALITY_PERCENT)
  expect(manifest.render_params.intensity).toBeCloseTo(0.37, 6)
  expect(manifest.lut).toBeTruthy()
  const source = await readFile(rawPath)
  expect(manifest.source_raw).toMatchObject({
    filename: basename(rawPath),
    sha256: sha256(source),
    byte_size: source.byteLength,
    decoded_dimensions: PUBLIC_DNG_SIZE,
  })
  expect(manifest.policy.kind).toBe('export-full')
  if (!gpu) {
    expect(manifest.environment.native_artifacts.variant).toBe('low-memory')
  }
  // The DNG's BaselineExposure sets the exposure of every frame and of the
  // export; every processed CPU frame so far drew the exposure it recorded.
  expect(manifest.render_params.raw_render_exposure_source).toBe('dng-baseline')
  const exposureEv = manifest.render_params.raw_render_exposure_ev
  expect(Number.isFinite(exposureEv)).toBe(true)
  if (!gpu) {
    expect(cpuProcessedExposures(await readTrace(page))).toEqual([exposureEv])
  }
  if (hq) {
    // The HQ file is written from the same look and exposure.
    const fullLight = await decodedMeanLight(page, first)
    const hqLight = await decodedMeanLight(page, hq)
    expect(Math.abs(hqLight - fullLight)).toBeLessThan(2)
  }
  // The download materialized the stored result, and the manifest names it.
  // Delivery reads storage only: it starts no runtime.
  const delivered = await readTrace(page)
  const sinceExport = delivered.exportEvents.slice(
    eventIndex(delivered.exportEvents, 'export-worker-attempt'),
  )
  expect(eventPayload(sinceExport, 'output-materialized')).toMatchObject({
    action: 'download',
    cleanup: 'scheduled',
    byteLength: first.bytes.byteLength,
    outputKind: plan.outputSink === 'opfs-file' ? 'file-backed' : 'blob',
  })
  expect(
    eventPayload(delivered.exportEvents, 'export-manifest-ready'),
  ).toMatchObject({
    manifestSha256: manifest.manifest_sha256,
    outputSha256: manifest.output.sha256,
  })
  expect(rawWorkers(delivered)).toHaveLength(rawWorkers(trace).length)

  // Closing the result leaves the deck empty: the Adjust panel that was open
  // before the export does not come back to edit under the JPEG.
  await closeExportPanel(page)
  await expect(deck(page)).toHaveCount(0)
  await expect(page.getByRole('slider')).toHaveCount(0)
  await expectReleasedPreview(page)
  // The topbar reopens the same result, still deliverable byte for byte.
  await expect(exportAction(page)).toHaveAttribute('data-state', 'done')
  await openTool(page, 'Export')
  await expect(panel).toContainText(first.name)
  const again = await downloadJpeg(page)
  expect([again.name, again.sha256]).toEqual([first.name, first.sha256])
  expect((await downloadManifest(page)).sha256).toBe(firstManifest.sha256)

  // Restore warms a fresh runtime, reopens the source on it and hands the
  // tools back with the edits intact.
  const restoreClickedAt = await page.evaluate(() => performance.now())
  await restoreButton(page).click()
  for (const name of ['Look', 'Adjust', 'Transform'] as const) {
    await expect(dockTab(page, name)).toBeEnabled({ timeout: 120_000 })
  }
  await expect(gpu ? gpuCanvas(page) : cpuCanvas(page)).toBeVisible({
    timeout: 120_000,
  })
  trace = await readTrace(page)
  const restored = sessionWorker(trace)!
  expect(restored.index).not.toBe(loadedOn.index)
  expect(restored.createdAt).toBeGreaterThan(restoreClickedAt)
  expect(requested(restored, 'decodeQuickFromSession')).toBe(true)
  await openTool(page, 'Adjust')
  await expect(
    deck(page).getByRole('slider', { name: 'Exposure', exact: true }),
  ).toHaveAttribute('aria-valuenow', exposureValue)
  await openTool(page, 'Look')
  await expect(strengthSlider(page)).toHaveAttribute('aria-valuetext', '37%')
  await settledFrameHash(page, gpu)
  await expectExecutorLens(page, gpu)

  // Once restored, its runtime idles out like a loaded RAW's; the photo,
  // the tools and the lens stay.
  await expect
    .poll(
      async () =>
        workerByIndex(await readTrace(page), restored.index).terminatedAt !==
        null,
      { timeout: RAW_RUNTIME_IDLE_MS * 4 },
    )
    .toBe(true)
  const idled = workerByIndex(await readTrace(page), restored.index)
  expect(idled.terminatedAt! - idled.lastReplyAt!).toBeGreaterThanOrEqual(
    IDLE_GAP_MIN_MS,
  )
  await expect(lens(page)).toBeVisible()
  await expect(dockTab(page, 'Look')).toBeEnabled()
  await expect(gpu ? gpuCanvas(page) : cpuCanvas(page)).toBeVisible()

  // The result outlives the released preview: with the photo back and no
  // edit since, the same file still delivers.
  await openTool(page, 'Export')
  expect((await downloadJpeg(page)).sha256).toBe(first.sha256)
  await closeExportPanel(page)

  // An edit that leaves the intent as it was clears the result; the second
  // export of the same RAW records the same exposure and writes the same
  // bytes.
  await touchStrength(page)
  await settledFrameHash(page, gpu)
  if (!gpu) {
    expect(cpuProcessedExposures(await readTrace(page))).toEqual([exposureEv])
  }
  await exportFullResolution(page)
  await expectReleasedPreview(page)
  const second = await downloadJpeg(page)
  const { manifest: secondManifest } = await downloadManifest(page)
  expect(secondManifest.render_params.raw_render_exposure_ev).toBe(exposureEv)
  expect(secondManifest.render_params.raw_render_exposure_source).toBe(
    'dng-baseline',
  )
  expect(secondManifest.render_params.intensity).toBeCloseTo(0.37, 6)
  expect(secondManifest.output.sha256).toBe(second.sha256)
  expect(second.sha256).toBe(first.sha256)

  // Reset ends the session and disposes the stored result with it.
  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Reset session' }).click()
  await page
    .getByRole('alertdialog', { name: 'Reset session' })
    .getByRole('button', { name: 'Reset session' })
    .click()
  await expect(
    page.getByRole('button', { name: 'Browse RAW files' }),
  ).toBeVisible({
    timeout: 30_000,
  })
  await expect
    .poll(async () =>
      eventPayload((await readTrace(page)).exportEvents, 'resource-cleanup'),
    )
    .toMatchObject({
      reason: 'reset-session',
      disposedOwners: ['export-result'],
      registryCheck: { ok: true },
      remainingLive: [],
    })
  const cleaned = (await readTrace(page)).exportEvents
  expect(
    cleaned.findIndex((event) => event.type === 'resource-cleanup'),
  ).toBeGreaterThan(
    cleaned.findLastIndex((event) => event.type === 'output-materialized'),
  )
})

/**
 * Every processed frame the CPU preview has been asked for, in order: the
 * size of the source it draws from and the raw-render exposure it draws at.
 */
function cpuProcessedFrames(trace: PageTrace) {
  return trace.cpuRenders
    .filter((render) => render.variant === 'processed')
    .map((render) => {
      const source = trace.cpuSources.findLast(
        (loaded) =>
          loaded.worker === render.worker &&
          loaded.sourceId === render.sourceId,
      )
      return { width: source?.width ?? 0, ev: render.ev }
    })
}

test('a RAW without a DNG baseline keeps its quick frame’s exposure through the bounded HQ frame, export, Restore and re-export', async ({
  page,
}, testInfo) => {
  const rawPath = gateRawFixture(testInfo, EXPOSURE_RAW)
  testInfo.setTimeout(900_000)
  const gpu = isChromium(testInfo)
  await openLab(page, testInfo, { surface: 'mobile' })
  // The load reports success only once the bounded HQ frame has replaced the
  // quick one: the frame whose own estimate differs from the quick frame's.
  await loadRaw(page, rawPath)
  let framesBeforeHq = 0
  if (gpu) {
    await expectWebGPUPreview(page, testInfo)
    await expect(page.locator('[data-raw-preview-frame]')).toHaveAttribute(
      'data-display-source',
      'bounded-hq',
      { timeout: 120_000 },
    )
  } else {
    framesBeforeHq = cpuProcessedFrames(await readTrace(page)).length
    expect(framesBeforeHq, 'the quick frame was drawn').toBeGreaterThan(0)
  }
  // A look gives the re-export an edit to clear the first result with. On
  // the CPU preview, which keeps drawing from its quick source, the renders
  // it asks for take the bounded HQ frame's exposure.
  const cubePath = testInfo.outputPath('display-srgb.cube')
  await writeFile(
    cubePath,
    createCube('Display sRGB', (value) => value * 0.55),
    'utf8',
  )
  await importCube(page, cubePath)
  await expect(contractInput(page)).toBeVisible({ timeout: 60_000 })
  await applyRecommendedContract(page)
  await settledFrameHash(page, gpu)

  await exportFullResolution(page)
  await expectReleasedPreview(page)
  const first = await downloadJpeg(page)
  const { manifest: firstManifest } = await downloadManifest(page)
  expect(firstManifest.output.sha256).toBe(first.sha256)
  expect({ width: first.width, height: first.height }).toEqual(
    firstManifest.output.dimensions,
  )
  expect(first.quality).toBe(EXPORT_JPEG_QUALITY_PERCENT)
  // No baseline: the exposure is estimated from the pixels of a frame.
  expect(firstManifest.render_params.raw_render_exposure_source).toBe(
    'image-statistics',
  )
  const exposureEv = firstManifest.render_params.raw_render_exposure_ev!
  expect(Number.isFinite(exposureEv)).toBe(true)
  let framesBeforeRestore = 0
  if (!gpu) {
    // The frames drawn before and after the bounded HQ frame landed all drew
    // the exposure the export recorded.
    const frames = cpuProcessedFrames(await readTrace(page))
    framesBeforeRestore = frames.length
    expect(framesBeforeRestore).toBeGreaterThan(framesBeforeHq)
    expect([...new Set(frames.map((frame) => frame.ev))]).toEqual([exposureEv])
  }

  // Restore decodes a new quick frame of the same source; it keeps the
  // exposure rather than estimating its own.
  await restoreButton(page).click()
  await expect(gpu ? gpuCanvas(page) : cpuCanvas(page)).toBeVisible({
    timeout: 120_000,
  })
  for (const name of ['Look', 'Adjust', 'Transform'] as const) {
    await expect(dockTab(page, name)).toBeEnabled({ timeout: 60_000 })
  }
  await touchStrength(page)
  await settledFrameHash(page, gpu)
  if (!gpu) {
    const trace = await readTrace(page)
    const frames = cpuProcessedFrames(trace)
    // The restored frame is a second quick source of the same size.
    expect(trace.cpuSources.length).toBeGreaterThanOrEqual(2)
    expect(trace.cpuSources.at(-1)!.width).toBe(trace.cpuSources[0]!.width)
    expect(frames.length).toBeGreaterThan(framesBeforeRestore)
    expect(frames.at(-1)!.width).toBe(trace.cpuSources[0]!.width)
    expect([...new Set(frames.map((frame) => frame.ev))]).toEqual([exposureEv])
  }

  // The re-export from the restored quick frame records the same exposure
  // and writes the same bytes.
  await exportFullResolution(page)
  await expectReleasedPreview(page)
  const second = await downloadJpeg(page)
  const { manifest: secondManifest } = await downloadManifest(page)
  expect(secondManifest.render_params.raw_render_exposure_source).toBe(
    'image-statistics',
  )
  expect(secondManifest.render_params.raw_render_exposure_ev).toBe(exposureEv)
  expect(secondManifest.output.sha256).toBe(second.sha256)
  expect(second.sha256).toBe(first.sha256)
})

/** A catalog of two visibly equal looks that differ in contract. */
const CATALOG_URL = 'https://luts.example.com/mobile/catalog.json'
const ACCEPTED_TITLE = 'Accepted Print'
const REFUSED_TITLE = 'Linear Print'

async function serveContractCatalog(context: BrowserContext) {
  const entry = (id: string, title: string, lut: Record<string, unknown>) => {
    // Darkens every channel, so a drawn look shows on the photo. Each look
    // has its own file: one LUT is one look, whatever its catalog row says.
    const cube = createCube(title, (value) => value * 0.55)
    const row = {
      id,
      kind: 'lut',
      version: '1.0.0',
      title,
      family: 'Contract',
      license: 'CC0-1.0',
      redistributionAllowed: true,
      primaryAsset: {
        url: `https://luts.example.com/mobile/${id}.cube`,
        role: 'cube-lut',
        mediaType: 'application/x-cube-lut',
        sha256: sha256(cube),
        size: Buffer.byteLength(cube),
        title,
      },
      entryUrl: `https://luts.example.com/mobile/entries/${id}.json`,
    }
    return {
      row,
      cube,
      document: { ...row, schemaVersion: 1, format: 'cube', lut },
    }
  }
  const accepted = entry('accepted-print', ACCEPTED_TITLE, {
    intent: 'display-look',
    input: { gamut: 'srgb-rec709', transfer: 'srgb', range: 'full' },
  })
  // Export refuses a linear LUT output, so the preview must not draw it.
  const refused = entry('linear-print', REFUSED_TITLE, {
    intent: 'combined-look-output',
    input: { gamut: 'srgb-rec709', transfer: 'srgb', range: 'full' },
    output: { gamut: 'srgb-rec709', transfer: 'linear', range: 'full' },
  })
  const documents = new Map<string, string>([
    [
      CATALOG_URL,
      JSON.stringify({
        schemaVersion: 1,
        entries: [accepted.row, refused.row],
      }),
    ],
    [accepted.row.entryUrl, JSON.stringify(accepted.document)],
    [refused.row.entryUrl, JSON.stringify(refused.document)],
    [accepted.row.primaryAsset.url, accepted.cube],
    [refused.row.primaryAsset.url, refused.cube],
  ])
  await context.route('https://luts.example.com/**', async (route) => {
    const body = documents.get(route.request().url())
    await route.fulfill(
      body === undefined
        ? { status: 404, body: 'not found' }
        : {
            contentType: route.request().url().endsWith('.cube')
              ? 'text/plain'
              : 'application/json',
            headers: { 'access-control-allow-origin': '*' },
            body,
          },
    )
  })
  // The default catalog is not part of this test; answer it with no looks.
  await context.route('https://luma-prof.ichr.me/**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ schemaVersion: 1, entries: [] }),
    }),
  )
}

function lookTile(page: Page, title: string) {
  return lookStrip(page)
    .locator('[data-mobile-lut-tile="entry"]')
    .filter({ hasText: title })
}

test('a look export refuses draws as no look, says why, and cannot be exported', async ({
  context,
  page,
}, testInfo) => {
  const rawPath = gateRawFixture(testInfo, PUBLIC_DNG)
  testInfo.setTimeout(300_000)
  const gpu = isChromium(testInfo)
  await serveContractCatalog(context)
  await openLab(page, testInfo, {
    surface: 'mobile',
    path: `/raw?luts=${encodeURIComponent(CATALOG_URL)}`,
  })
  await loadRaw(page, rawPath)
  await openTool(page, 'Look')
  await expect(lookTile(page, ACCEPTED_TITLE)).toBeVisible({ timeout: 60_000 })
  await expect(lookTile(page, REFUSED_TITLE)).toBeVisible()
  const noLook = await settledFrameHash(page, gpu)

  // The accepted contract draws the cube: the photo changes.
  await lookTile(page, ACCEPTED_TITLE).click()
  await expect(lookTile(page, ACCEPTED_TITLE)).toHaveAttribute(
    'data-state',
    'applied',
    { timeout: 60_000 },
  )
  await expect(page.getByText(/^Not in (the CPU )?preview/)).toHaveCount(0)
  await expect
    .poll(() => settledFrameHash(page, gpu), { timeout: 60_000 })
    .not.toBe(noLook)

  // The same cube under a contract export refuses: the look stays selected,
  // the preview drops it (user color kept, nothing blanked) and says why.
  await lookTile(page, REFUSED_TITLE).click()
  await expect(lookTile(page, REFUSED_TITLE)).toHaveAttribute(
    'data-state',
    'needs-contract',
    { timeout: 60_000 },
  )
  await expect(lookTile(page, REFUSED_TITLE)).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(lookTile(page, ACCEPTED_TITLE)).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await expect(
    page.getByRole('button', {
      name: 'Not in preview · linear LUT output not supported',
    }),
  ).toBeVisible()
  await expect
    .poll(() => settledFrameHash(page, gpu), { timeout: 60_000 })
    .toBe(noLook)

  // Export fails closed on it, and says it is the contract.
  await openTool(page, 'Export')
  const panel = exportSurface(page)
  await expect(
    panel.getByRole('button', { name: 'Export full-resolution JPEG' }),
  ).toBeDisabled()
  const reason = panel.locator('[data-export-unavailable-reason]')
  await expect(reason).toBeVisible()
  await expect(reason).toHaveAttribute('data-tone', 'contract')
  // The HQ preview JPEG is the preview's own render, which leaves the look
  // out, so it refuses as well and says why. The recap does not claim the
  // look either.
  const hqExport = panel.getByRole('button', { name: 'Export HQ preview JPEG' })
  await expect(hqExport).toBeDisabled()
  await expect(hqExport).toHaveAccessibleDescription(
    'The preview leaves out the selected LUT. Fix its color contract or clear the LUT to export an HQ preview JPEG.',
  )
  const recap = panel.locator('[data-export-recap]')
  await expect(recap).toBeVisible()
  await expect(recap).not.toContainText(REFUSED_TITLE)
  await expect(recap).toContainText('No LUT')
  await expect(exportAction(page)).toHaveAccessibleName(
    'Export blocked: open details',
  )
})

test('tries a catalog look on the photo from the Look strip', async ({
  context,
  page,
}, testInfo) => {
  test.skip(isChromium(testInfo), 'The mobile Look deck runs on WebKit')
  const rawPath = gateRawFixture(testInfo, RAW_FIXTURE)
  testInfo.setTimeout(180_000)
  await serveContractCatalog(context)
  await page.goto(`/raw?luts=${encodeURIComponent(CATALOG_URL)}`)
  await chooseRaw(page, rawPath)
  await expect(loadedLab(page)).toBeVisible({ timeout: 90_000 })

  // Look opens with the strip: Original applied, the catalog's looks, Import.
  const strip = lookStrip(page)
  await expect(strip).toBeVisible()
  const original = strip.getByRole('button', { name: 'Original' })
  await expect(original).toHaveAttribute('aria-pressed', 'true')
  const look = lookTile(page, ACCEPTED_TITLE)
  await expect(look).toBeVisible({ timeout: 60_000 })
  await expect(
    strip.getByRole('button', { name: 'Import .cube' }),
  ).toBeVisible()
  await expect(page.getByText('No LUT · tone and color only')).toBeVisible()
  // Strength is a slider row in the deck; without a LUT it is off.
  const strength = strengthSlider(page)
  await expect(strength).toHaveAttribute('data-disabled', '')

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
  ).toContainText('Display sRGB')
  await expect(strength).not.toHaveAttribute('data-disabled')
  await expect(strength).toHaveAttribute('aria-valuetext', '70%')
  // Continuous: arrows step 1%, Shift+arrows 10%; the value is the reset.
  await strength.focus()
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  await expect(strength).toHaveAttribute('aria-valuetext', '59%')
  await page.getByRole('button', { name: 'Reset Strength' }).click()
  await expect(strength).toHaveAttribute('aria-valuetext', '70%')

  // LUT sources is a sheet for the sources only.
  await page.getByRole('button', { name: 'LUT sources' }).click()
  const sources = page.getByRole('dialog', { name: 'LUT sources' })
  await expect(sources).toBeVisible()
  await expect(sources.getByRole('slider', { name: 'Strength' })).toHaveCount(0)
  await sources.getByRole('button', { name: 'Close LUT sources' }).click()
  await expect(sources).toHaveCount(0)
})

test('chooses an imported LUT’s contract inline, input then output, with the photo in view', async ({
  page,
}, testInfo) => {
  test.skip(isChromium(testInfo), 'The mobile Look deck runs on WebKit')
  const rawPath = gateRawFixture(testInfo, RAW_FIXTURE)
  testInfo.setTimeout(180_000)
  await page.goto('/raw')
  await chooseRaw(page, rawPath)
  await expect(loadedLab(page)).toBeVisible({ timeout: 90_000 })

  const cubePath = testInfo.outputPath('inline-contract.cube')
  await writeFile(cubePath, createCube('Inline Contract'), 'utf8')
  await page.locator('[data-mobile-lut-import-input]').setInputFiles(cubePath)

  // Nothing resolved this file, so its contract opens by itself, in the
  // deck: no sheet over the photo.
  const input = contractInput(page)
  await expect(input).toBeVisible({ timeout: 60_000 })
  await expect(input).toContainText('1 / 2')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(deck(page)).toHaveAttribute('data-deck-fill', 'true')
  // The deck takes list sizing: it starts where the photo ends, so the
  // photo stays in view above it (polled past the 240ms inset motion). The
  // stage region is the photo's height on both preview paths.
  await expect
    .poll(async () => {
      const photoBottom = await page.evaluate(() => {
        const stage = document.querySelector<HTMLElement>('.raw-lab-stage')
        if (!stage) return null
        const rect = stage.getBoundingClientRect()
        const padding = getComputedStyle(stage)
        const top = rect.top + Number.parseFloat(padding.paddingTop)
        const bottom = rect.bottom - Number.parseFloat(padding.paddingBottom)
        return bottom - top > 100 ? bottom : null
      })
      const box = await deck(page).boundingBox()
      if (photoBottom === null || !box) return Number.NaN
      return Math.round(box.y - photoBottom)
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
