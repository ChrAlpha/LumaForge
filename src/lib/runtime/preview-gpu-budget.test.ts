import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { CapabilityVector } from '@lumaforge/render-engine/policy'
import {
  BOUNDED_HQ_PREVIEW_LOW_MEMORY_MAX_PIXELS,
  BOUNDED_HQ_PREVIEW_MAX_PIXELS,
  QUICK_PREVIEW_MAX_PIXELS,
} from '@lumaforge/render-engine/preview'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { getPreviewBackendSnapshot } from '~/lib/preview/gpu-backend'

import {
  derivePreviewGpuBudget,
  detectPreviewGpuCapabilitySnapshot,
} from './preview-gpu-budget'

vi.mock('~/lib/preview/gpu-backend', () => ({
  getPreviewBackendSnapshot: vi.fn(() => null),
}))

const baseCapability: CapabilityVector = {
  coi: true,
  pthread: true,
  deviceMemoryGB: null,
  hwConcurrency: 8,
  webKitClass: 'chromium',
  deviceFormFactor: 'desktop',
  maybeOpfsSupported: true,
}

const strongGpu = {
  webgpu: true,
  maxTextureSize: 8192,
}

describe('derivePreviewGpuBudget', () => {
  it('derives from the engine-owned preview pixel caps', () => {
    expect(QUICK_PREVIEW_MAX_PIXELS).toBe(2_500_000)
    expect(BOUNDED_HQ_PREVIEW_MAX_PIXELS).toBe(12_000_000)
    expect(BOUNDED_HQ_PREVIEW_LOW_MEMORY_MAX_PIXELS).toBe(8_000_000)
  })

  afterEach(() => {
    vi.mocked(getPreviewBackendSnapshot).mockReturnValue(null)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('uses the resolved WebGPU limits without opening a canvas', () => {
    vi.mocked(getPreviewBackendSnapshot).mockReturnValue({
      backend: 'webgpu',
      maxTextureSize: 4096,
      reason: null,
    })
    const createElement = vi.spyOn(document, 'createElement')
    expect(detectPreviewGpuCapabilitySnapshot()).toEqual({
      webgpu: true,
      maxTextureSize: 4096,
    })
    expect(createElement).not.toHaveBeenCalled()
  })

  it('uses the CPU budget after a resolved GPU failure', () => {
    vi.mocked(getPreviewBackendSnapshot).mockReturnValue({
      backend: 'cpu',
      maxTextureSize: 0,
      reason: 'gpu-preview-failed',
    })
    const gpu = detectPreviewGpuCapabilitySnapshot()!
    expect(gpu.webgpu).toBe(false)
    expect(
      derivePreviewGpuBudget({
        capability: baseCapability,
        gpu,
        sourceWidth: 6000,
        sourceHeight: 4000,
      }).dualGpuAllowed,
    ).toBe(false)
  })

  it('allows 12MP bounded HQ preview on a strong GPU without requiring pthread', () => {
    expect(
      derivePreviewGpuBudget({
        capability: { ...baseCapability, pthread: false },
        gpu: strongGpu,
        sourceWidth: 6000,
        sourceHeight: 4000,
      }),
    ).toMatchObject({
      boundedHqMaxPixels: BOUNDED_HQ_PREVIEW_MAX_PIXELS,
      dualGpuAllowed: true,
      originalReferenceSnapshotMaxPixels: BOUNDED_HQ_PREVIEW_MAX_PIXELS,
    })
  })

  it('caps 3:2 sources to the largest safe pixel count for a 4096 texture limit', () => {
    expect(
      derivePreviewGpuBudget({
        capability: { ...baseCapability, pthread: false },
        gpu: {
          webgpu: true,
          maxTextureSize: 4096,
        },
        sourceWidth: 6000,
        sourceHeight: 4000,
      }).boundedHqMaxPixels,
    ).toBe(11_184_810)
  })

  it('keeps known low-memory devices on the low-memory preview ceiling', () => {
    expect(
      derivePreviewGpuBudget({
        capability: { ...baseCapability, deviceMemoryGB: 4 },
        gpu: strongGpu,
        sourceWidth: 6000,
        sourceHeight: 4000,
      }),
    ).toMatchObject({
      boundedHqMaxPixels: BOUNDED_HQ_PREVIEW_LOW_MEMORY_MAX_PIXELS,
      dualGpuAllowed: false,
      originalReferenceSnapshotMaxPixels:
        BOUNDED_HQ_PREVIEW_LOW_MEMORY_MAX_PIXELS,
    })
  })

  it('reports no GPU facts before the preview backend resolves', () => {
    const createElement = vi.spyOn(document, 'createElement')
    expect(detectPreviewGpuCapabilitySnapshot()).toBeNull()
    expect(createElement).not.toHaveBeenCalled()
  })

  it.each([
    [
      'no WebGPU keeps the quick-preview ceiling',
      baseCapability,
      { webgpu: false, maxTextureSize: 8192 },
      [6000, 4000],
      [2_500_000, false, 2_500_000],
    ],
    [
      'desktop Chromium with pthread takes the performance ceiling',
      baseCapability,
      strongGpu,
      [6000, 4000],
      [16_000_000, true, 16_000_000],
    ],
    [
      'desktop Chromium with 8 GB stays on the performance ceiling',
      { ...baseCapability, deviceMemoryGB: 8 },
      strongGpu,
      [6000, 4000],
      [16_000_000, true, 16_000_000],
    ],
    [
      'mobile Chromium stays on the bounded-HQ ceiling',
      { ...baseCapability, deviceFormFactor: 'mobile' },
      strongGpu,
      [6000, 4000],
      [12_000_000, true, 12_000_000],
    ],
    [
      'mobile WebKit without pthread stays on the bounded-HQ ceiling',
      {
        ...baseCapability,
        coi: false,
        pthread: false,
        webKitClass: 'webkit-mobile',
        deviceFormFactor: 'mobile',
      },
      strongGpu,
      [6000, 4000],
      [12_000_000, true, 12_000_000],
    ],
    [
      'a 2 GB device keeps the low-memory ceiling and no dual GPU',
      { ...baseCapability, deviceMemoryGB: 2 },
      strongGpu,
      [6000, 4000],
      [8_000_000, false, 8_000_000],
    ],
    [
      'a 4096 texture caps the performance ceiling for 3:2',
      baseCapability,
      { webgpu: true, maxTextureSize: 4096 },
      [6000, 4000],
      [11_184_810, true, 11_184_810],
    ],
    [
      'a 4096 texture caps a 3:1 panorama below dual GPU',
      baseCapability,
      { webgpu: true, maxTextureSize: 4096 },
      [9000, 3000],
      [5_592_405, false, 5_592_405],
    ],
    [
      'a 2048 texture blocks dual GPU',
      baseCapability,
      { webgpu: true, maxTextureSize: 2048 },
      [6000, 4000],
      [2_796_202, false, 2_796_202],
    ],
    [
      'an unusable texture limit falls back to the quick-preview floor',
      baseCapability,
      { webgpu: true, maxTextureSize: 0 },
      [6000, 4000],
      [2_500_000, false, 2_500_000],
    ],
    [
      'unknown source dimensions are treated as square',
      baseCapability,
      { webgpu: true, maxTextureSize: 4096 },
      [0, 0],
      [16_000_000, true, 16_000_000],
    ],
  ] satisfies Array<
    [
      string,
      CapabilityVector,
      { webgpu: boolean; maxTextureSize: number },
      [number, number],
      [number, boolean, number],
    ]
  >)(
    'keeps the budget table: %s',
    (
      _label,
      capability,
      gpu,
      [sourceWidth, sourceHeight],
      [boundedHqMaxPixels, dualGpuAllowed, originalReferenceSnapshotMaxPixels],
    ) => {
      const budget = derivePreviewGpuBudget({
        capability,
        gpu,
        sourceWidth,
        sourceHeight,
      })

      expect(budget).toEqual({
        boundedHqMaxPixels,
        dualGpuAllowed,
        originalReferenceSnapshotMaxPixels,
      })
      expect(Object.isFrozen(budget)).toBe(true)
    },
  )
})

describe('preview GPU budget type ownership', () => {
  it.each([
    'CapabilityVector',
    'PreviewGpuBudget',
    'PreviewGpuCapabilitySnapshot',
  ])('takes %s from the render engine', (name) => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/lib/runtime/preview-gpu-budget.ts'),
      'utf8',
    )

    expect(source).not.toMatch(
      new RegExp(
        String.raw`\b(?:interface|type) ${name}\b|\bexport (?:type )?\{[^}]*\b${name}\b`,
      ),
    )
    expect(source).toMatch(
      new RegExp(
        String.raw`import type \{[^}]*\b${name}\b[^}]*\} from '@lumaforge/render-engine/policy'`,
      ),
    )
  })
})
