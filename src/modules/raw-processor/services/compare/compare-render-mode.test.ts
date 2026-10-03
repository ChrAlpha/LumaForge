import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  selectCompareRenderMode,
  supportsLayeredCompareCss,
} from './compare-render-mode'

describe('selectCompareRenderMode', () => {
  it('prefers dual GPU when capability allows two live preview pipelines', () => {
    expect(
      selectCompareRenderMode({
        requestedViewMode: 'compare',
        supportsCssClip: true,
        dualGpuAllowed: true,
        originalGpuReady: true,
        jpegSnapshotReady: false,
      }),
    ).toEqual({ kind: 'dual-gpu' })
  })

  it('does not select dual GPU while the current original layer generation is pending', () => {
    expect(
      selectCompareRenderMode({
        requestedViewMode: 'compare',
        supportsCssClip: true,
        dualGpuAllowed: true,
        originalGpuReady: false,
        jpegSnapshotReady: false,
      }),
    ).toEqual({
      kind: 'processed-only',
      reason: 'jpeg-fallback-unavailable',
    })
  })

  it('keeps dual GPU while a retained compare frame covers a preview upgrade', () => {
    expect(
      selectCompareRenderMode({
        requestedViewMode: 'compare',
        supportsCssClip: true,
        dualGpuAllowed: true,
        originalGpuReady: false,
        retainedCompareFrameReady: true,
        jpegSnapshotReady: false,
      }),
    ).toEqual({ kind: 'dual-gpu' })
  })

  it('uses embedded fallback while original GPU is pending', () => {
    expect(
      selectCompareRenderMode({
        requestedViewMode: 'compare',
        supportsCssClip: true,
        dualGpuAllowed: true,
        originalGpuReady: false,
        originalGpuFailed: false,
        embeddedPreviewReady: true,
        jpegSnapshotReady: false,
      }),
    ).toEqual({
      kind: 'embedded-fallback',
      reason: 'original-gpu-pending',
    })
  })

  it('uses JPEG fallback when dual GPU is not allowed and a snapshot is ready', () => {
    expect(
      selectCompareRenderMode({
        requestedViewMode: 'compare',
        supportsCssClip: true,
        dualGpuAllowed: false,
        originalGpuReady: false,
        jpegSnapshotReady: true,
      }),
    ).toEqual({ kind: 'jpeg-fallback', reason: 'dual-gpu-unavailable' })
  })

  it('uses JPEG fallback when left GPU fails after dual GPU was allowed', () => {
    expect(
      selectCompareRenderMode({
        requestedViewMode: 'compare',
        supportsCssClip: true,
        dualGpuAllowed: true,
        originalGpuReady: false,
        originalGpuFailed: true,
        jpegSnapshotReady: true,
      }),
    ).toEqual({ kind: 'jpeg-fallback', reason: 'original-gpu-failed' })
  })

  it('does not select the legacy single-canvas shader compare path', () => {
    expect(
      selectCompareRenderMode({
        requestedViewMode: 'compare',
        supportsCssClip: false,
        dualGpuAllowed: true,
        originalGpuReady: false,
        jpegSnapshotReady: true,
      }),
    ).toEqual({ kind: 'processed-only', reason: 'css-clip-unavailable' })
  })
})

describe('supportsLayeredCompareCss', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('accepts prefixed WebKit clip-path support', () => {
    vi.stubGlobal('CSS', {
      supports: vi.fn((property: string) => property === '-webkit-clip-path'),
    })

    expect(supportsLayeredCompareCss()).toBe(true)
  })

  it('does not disable layered compare in non-DOM environments', () => {
    vi.stubGlobal('CSS', undefined)

    expect(supportsLayeredCompareCss()).toBe(true)
  })
})
