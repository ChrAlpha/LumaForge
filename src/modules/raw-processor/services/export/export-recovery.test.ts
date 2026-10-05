import { describe, expect, it, vi } from 'vitest'

import type { ExportCheckpointManifest } from '~/lib/export/checkpoint-store'
import { sourceFingerprintMatches } from '~/lib/export/source-fingerprint'

import {
  createInterruptedExportRecovery,
  validateRecoveryReselection,
  withInterruptionHistory,
} from './export-recovery'

vi.mock('~/lib/export/source-fingerprint', () => ({
  sourceFingerprintMatches: vi.fn(),
}))

function manifest(): ExportCheckpointManifest {
  return {
    version: 1,
    exportId: 'export-1',
    sourceFingerprint: {
      name: 'frame.RAF',
      size: 3,
      lastModified: 123,
      hashPrefixHex: 'abc',
    },
    fileName: 'frame.RAF',
    sourceSize: 3,
    sourceLastModified: 123,
    outputWidth: 11662,
    outputHeight: 8746,
    graphFingerprint: 'graph-1',
    profile: 'ios-safe',
    attempt: 1,
    preferredRows: 64,
    totalRows: 8746,
    recoveryMode: 'safe-retry',
    outputSink: 'opfs-file',
    sourceReacquisition: 'user-reselect-required',
    completedRowsForDiagnostics: 64,
    jpegState: 'restart-required',
    updatedAt: '2026-05-01T00:00:00.000Z',
  }
}

/**
 * A journal written by a geometry export records the delivered (cropped)
 * frame, which no longer matches the sensor dimensions of its source.
 */
function transformedManifest(): ExportCheckpointManifest {
  return {
    ...manifest(),
    exportId: 'export-transformed',
    outputWidth: 9120,
    outputHeight: 5130,
    totalRows: 5130,
  }
}

describe('export recovery', () => {
  it('turns an interrupted journal into an interruption-only hint', () => {
    const recovery = createInterruptedExportRecovery(manifest())

    expect(recovery).toEqual({
      status: 'ready-to-retry',
      exportId: 'export-1',
      message:
        'The browser interrupted the previous export. Your next export will use a safer low-memory setting.',
    })
    expect(recovery.message).not.toMatch(/reselect|resume|restor|reproduc/i)
  })

  it('reports a transformed journal without any source or dimension check', () => {
    vi.mocked(sourceFingerprintMatches).mockClear()

    expect(createInterruptedExportRecovery(transformedManifest())).toEqual({
      status: 'ready-to-retry',
      exportId: 'export-transformed',
      message: expect.any(String),
    })
    expect(sourceFingerprintMatches).not.toHaveBeenCalled()
  })

  it('leaves an explicit export untouched without interruption history', () => {
    expect(
      withInterruptionHistory(
        { quality: 'high', fidelity: 'balanced' },
        { status: 'none' },
        undefined,
        null,
      ),
    ).toEqual({ quality: 'high', fidelity: 'balanced' })
  })

  it('asks an explicit export for the safer plan while keeping the current choice', () => {
    expect(
      withInterruptionHistory(
        { quality: 'standard', fidelity: 'max' },
        { status: 'none' },
        createInterruptedExportRecovery(transformedManifest()),
      ),
    ).toEqual({
      quality: 'standard',
      fidelity: 'max',
      previousInterrupted: true,
      recoveredExportId: 'export-transformed',
    })
  })

  it('takes the first interruption the caller lists', () => {
    expect(
      withInterruptionHistory(
        { quality: 'high', fidelity: 'balanced' },
        {
          status: 'ready-to-retry',
          exportId: 'session-export',
          message: 'Interrupted.',
        },
        createInterruptedExportRecovery(manifest()),
      ),
    ).toMatchObject({ recoveredExportId: 'session-export' })
  })

  it('never forwards a journal for sizing or look restoration', () => {
    const request = withInterruptionHistory(
      {
        quality: 'high',
        fidelity: 'balanced',
        recoveredManifest: transformedManifest(),
      } as Parameters<typeof withInterruptionHistory>[0],
      {
        status: 'source-required',
        exportId: 'export-transformed',
        expectedFileName: 'frame.RAF',
        manifest: transformedManifest(),
        message: 'Legacy hint.',
      },
    )

    expect(request).toEqual({
      quality: 'high',
      fidelity: 'balanced',
      previousInterrupted: true,
      recoveredExportId: 'export-transformed',
    })
    expect(request).not.toHaveProperty('recoveredManifest')
  })

  it('accepts a reselected matching source', async () => {
    const checkpointManifest = manifest()
    vi.mocked(sourceFingerprintMatches).mockResolvedValue(true)

    await expect(
      validateRecoveryReselection(
        new File(['raw'], 'frame.RAF'),
        checkpointManifest,
      ),
    ).resolves.toEqual({ ok: true })

    expect(sourceFingerprintMatches).toHaveBeenCalledWith(
      expect.any(File),
      checkpointManifest.sourceFingerprint,
      {
        width: 11662,
        height: 8746,
      },
    )
  })

  it('rejects a mismatched reselected source with product-safe reason', async () => {
    vi.mocked(sourceFingerprintMatches).mockResolvedValue(false)

    await expect(
      validateRecoveryReselection(new File(['other'], 'other.RAF'), manifest()),
    ).resolves.toEqual({
      ok: false,
      reason: 'The selected RAW does not match the interrupted export source.',
    })
  })
})
