import type {
  LumaRawDecodeSession,
  LumaRawExportCapability,
  LumaRawProcessedWindow,
  LumaRawProcessedWindowRequest,
  LumaRawWindow,
} from '@lumaforge/luma-raw-runtime'
import { describe, expect, it, vi } from 'vitest'

import {
  createRawExportSession,
  isRawExportSession,
} from './export-runtime-adapter'
function makeCapability(): LumaRawExportCapability {
  return {
    supported: true,
    width: 4,
    height: 4,
    rawWidth: 4,
    rawHeight: 4,
    cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
    blackLevel: 0,
    whiteLevel: 255,
    orientation: { code: 1, supported: true },
    sensor: {
      layout: 'bayer',
      colorCount: 3,
      cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
      phaseIsWindowLocal: false,
    },
    windows: { librawProcessed: false, rawMosaic: true },
    diagnostics: {
      hasRawImage: true,
      hasColor3Image: false,
      hasColor4Image: false,
      hasXTransTable: false,
    },
    reasons: [],
  }
}

function makeWindow(): LumaRawWindow {
  return {
    rect: { x: 0, y: 0, width: 2, height: 2 },
    cfa: { pattern: 'rggb', xPhase: 0, yPhase: 0 },
    data: new Uint16Array([128, 128, 128, 128]),
    blackLevel: 0,
    whiteLevel: 255,
  }
}

function makeProcessedWindow(
  request: LumaRawProcessedWindowRequest,
): LumaRawProcessedWindow {
  return {
    rect: request.outputRect,
    workingSpace: 'linear-prophoto-rgb',
    data: new Uint16Array(
      request.outputRect.width * request.outputRect.height * 3,
    ),
    width: request.outputRect.width,
    height: request.outputRect.height,
    stride: request.outputRect.width * 3,
    normalized: false,
    orientationApplied: true,
    colorApplied: true,
    warnings: [],
  }
}

describe('createRawExportSession', () => {
  it('forwards export capability, raw-window reads, and processed-window reads from the decode session', async () => {
    const capability = makeCapability()
    const window = makeWindow()
    const signal = new AbortController().signal
    const rect = { x: 1, y: 2, width: 3, height: 4 }
    const request = {
      outputRect: rect,
      halo: { left: 2, top: 2, right: 2, bottom: 2 },
    }
    const processedWindow = makeProcessedWindow(request)
    const session = {
      probeExportCapability: vi.fn().mockResolvedValue(capability),
      readRawWindow: vi.fn().mockResolvedValue(window),
      readProcessedWindow: vi.fn().mockResolvedValue(processedWindow),
    } as unknown as LumaRawDecodeSession

    const exportSession = createRawExportSession(session)

    await expect(exportSession.probeExportCapability(signal)).resolves.toBe(
      capability,
    )
    await expect(exportSession.readRawWindow(rect, signal)).resolves.toBe(
      window,
    )
    await expect(
      exportSession.readProcessedWindow(request, signal),
    ).resolves.toBe(processedWindow)
    expect(session.probeExportCapability).toHaveBeenCalledWith(signal)
    expect(session.readRawWindow).toHaveBeenCalledWith(rect, signal)
    expect(session.readProcessedWindow).toHaveBeenCalledWith(request, signal)
  })
})

describe('isRawExportSession', () => {
  it('returns true when the session exposes export-stage functions', () => {
    const session = {
      probeExportCapability: vi.fn(),
      readRawWindow: vi.fn(),
      readProcessedWindow: vi.fn(),
    }

    expect(isRawExportSession(session)).toBe(true)
  })

  it('returns false when export-stage functions are missing', () => {
    const session = {
      extractEmbeddedPreview: vi.fn(),
      decodeQuickRaw: vi.fn(),
      decodeBoundedHqRaw: vi.fn(),
      dispose: vi.fn(),
    }

    expect(isRawExportSession(session)).toBe(false)
  })

  it('returns true for export-only shapes that are not full raw runtime sessions', () => {
    const exportOnly = {
      probeExportCapability: vi.fn(),
      readRawWindow: vi.fn(),
      readProcessedWindow: vi.fn(),
    }

    expect(isRawExportSession(exportOnly)).toBe(true)
  })

  it('returns false when processed-window reads are missing', () => {
    const legacyExportOnly = {
      probeExportCapability: vi.fn(),
      readRawWindow: vi.fn(),
    }

    expect(isRawExportSession(legacyExportOnly)).toBe(false)
  })

  it('returns false for non-object values', () => {
    expect(isRawExportSession(null)).toBe(false)
    expect(isRawExportSession(undefined)).toBe(false)
    expect(isRawExportSession('session')).toBe(false)
  })
})
