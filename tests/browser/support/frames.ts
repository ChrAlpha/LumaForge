import { createHash } from 'node:crypto'

import type { Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'

import { cpuCanvas, gpuCanvas } from './lab'
import { cpuTraceIdle, readTrace } from './trace'

export type CanvasDigest = {
  width: number
  height: number
  boxWidth: number
  boxHeight: number
  hash: string
  meanLight: number
  colors: number
}

/** A 2D canvas's pixels: their hash, mean light and sampled colours. */
export async function readCanvas(canvas: Locator): Promise<CanvasDigest> {
  return canvas.evaluate(async (element) => {
    const target = element as HTMLCanvasElement
    const { width, height } = target
    const pixels = target
      .getContext('2d')!
      .getImageData(0, 0, width, height).data
    const digest = await crypto.subtle.digest('SHA-256', pixels)
    let light = 0
    let samples = 0
    const colors = new Set<number>()
    for (let offset = 0; offset < pixels.length; offset += 64) {
      // The letterbox around the fitted photo stays transparent.
      if (pixels[offset + 3] === 0) continue
      light += (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / 3
      colors.add(
        (pixels[offset] << 16) | (pixels[offset + 1] << 8) | pixels[offset + 2],
      )
      samples++
    }
    return {
      width,
      height,
      boxWidth: target.clientWidth,
      boxHeight: target.clientHeight,
      hash: Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join(''),
      meanLight: samples ? light / samples : 0,
      colors: colors.size,
    }
  })
}

/**
 * The CPU canvas once the worker has answered its last render and the canvas
 * has stopped changing (a resize redraw lands after its box settles). Needs
 * the page trace.
 */
export async function settledCpuFrame(page: Page) {
  await expect(cpuCanvas(page)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('cpu-preview-spinner')).toHaveCount(0, {
    timeout: 60_000,
  })
  await expect
    .poll(async () => cpuTraceIdle(await readTrace(page)), { timeout: 60_000 })
    .toBe(true)
  let previous = await readCanvas(cpuCanvas(page))
  await expect
    .poll(
      async () => {
        const next = await readCanvas(cpuCanvas(page))
        const settled = next.hash === previous.hash
        previous = next
        return settled
      },
      { intervals: [300], timeout: 15_000 },
    )
    .toBe(true)
  expect(previous.colors, 'the canvas shows the photograph').toBeGreaterThan(
    1000,
  )
  return previous
}

/** Waits for the CPU canvas to settle on a frame other than `from`. */
export async function nextCpuFrame(page: Page, from: CanvasDigest) {
  await expect
    .poll(async () => (await readCanvas(cpuCanvas(page))).hash, {
      timeout: 60_000,
    })
    .not.toBe(from.hash)
  return settledCpuFrame(page)
}

/**
 * The GPU canvas as the page composites it, once two captures in a row agree.
 * A WebGPU canvas cannot be read back from script once presented, so the
 * capture is a screenshot of the canvas element alone.
 */
export async function settledGpuFrame(page: Page) {
  await expect(gpuCanvas(page)).toBeVisible({ timeout: 60_000 })
  let previous = await gpuCanvas(page).screenshot({ animations: 'disabled' })
  await expect
    .poll(
      async () => {
        const next = await gpuCanvas(page).screenshot({
          animations: 'disabled',
        })
        const settled = next.equals(previous)
        previous = next
        return settled
      },
      { intervals: [400], timeout: 30_000 },
    )
    .toBe(true)
  return createHash('sha256').update(previous).digest('hex')
}

/** The hash of the settled photo on the project's own preview executor. */
export async function settledFrameHash(page: Page, gpu: boolean) {
  return gpu ? settledGpuFrame(page) : (await settledCpuFrame(page)).hash
}
