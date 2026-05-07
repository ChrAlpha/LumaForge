import { expect, test } from '@playwright/test'

test('keeps RAW Lab tool scrolling inside the viewport shell', async ({
  page,
}) => {
  await page.goto('/raw')
  await expect(page.locator('[data-raw-lab-shell="viewport"]')).toBeVisible()

  const metrics = await page.evaluate(() => {
    const documentRoot = document.documentElement
    const rawShell = document.querySelector<HTMLElement>(
      '[data-raw-lab-shell="viewport"]',
    )
    const toolStack = document.querySelector<HTMLElement>('.raw-tool-stack')
    const mobileRail = document.querySelector<HTMLElement>(
      '[data-raw-tool-surface] nav[aria-label]',
    )
    const mobileSheet = document.querySelector<HTMLElement>(
      '[data-raw-mobile-sheet]',
    )

    return {
      documentScrollOverflow:
        documentRoot.scrollHeight - documentRoot.clientHeight,
      rawShellHeight: rawShell?.getBoundingClientRect().height ?? 0,
      rawShellScrollOverflow: rawShell
        ? rawShell.scrollHeight - rawShell.clientHeight
        : 0,
      toolStackScrollOverflow: toolStack
        ? toolStack.scrollHeight - toolStack.clientHeight
        : 0,
      toolStackOverflowY: toolStack
        ? getComputedStyle(toolStack).overflowY
        : '',
      isMobile: window.innerWidth <= 640,
      mobileRailVisible: mobileRail
        ? getComputedStyle(mobileRail).display !== 'none'
        : false,
      mobileSheetHidden: mobileSheet?.hidden ?? false,
      viewportHeight: window.innerHeight,
    }
  })

  expect(metrics.rawShellHeight).toBe(metrics.viewportHeight)
  expect(metrics.rawShellScrollOverflow).toBe(0)
  expect(metrics.documentScrollOverflow).toBe(0)

  if (metrics.isMobile) {
    expect(metrics.mobileRailVisible).toBe(true)
    expect(metrics.mobileSheetHidden).toBe(true)
  } else if (metrics.toolStackOverflowY === 'auto') {
    expect(metrics.toolStackScrollOverflow).toBeGreaterThan(0)
  }
})
