import { describe, expect, it, vi } from 'vitest'

import type { ExportCheckpointManifest } from '~/lib/export/checkpoint-store'
import { sourceFingerprintMatches } from '~/lib/export/source-fingerprint'

import type { ExportInterruptionHint } from './export-interruption'
import {
  createExportInterruptionMarkers,
  encodeExportSourceHint,
} from './export-interruption'
import type { SourceInterruptionHint } from './export-recovery'
import {
  classifyExportAttemptOutcome,
  createInterruptedExportRecovery,
  interruptionForSource,
  projectExportRecovery,
  readSourceInterruption,
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

const SOURCE = new File(['raw'], 'frame.RAF', { lastModified: 123 })
const OTHER_SOURCE = new File(['other raw'], 'other.RAF', { lastModified: 456 })

function crashHint(attempts = ['attempt-a']): ExportInterruptionHint {
  return {
    previousCrashLikeInterruption: true,
    previousResourceFailure: false,
    attempts,
  }
}

function hintFor(
  file: File,
  hint: ExportInterruptionHint = crashHint(),
): SourceInterruptionHint {
  const source = encodeExportSourceHint(file)
  if (source === null) throw new Error('Expected an encodable file tuple.')
  return { source, hint }
}

describe('source-scoped interruption hints', () => {
  it('applies a hint only to the file tuple it was read for', () => {
    const interruption = hintFor(SOURCE)

    expect(interruptionForSource(interruption, SOURCE)).toBe(interruption.hint)
    // The same tuple on a fresh File object is the same hint location.
    expect(
      interruptionForSource(
        interruption,
        new File(['raw'], 'frame.RAF', { lastModified: 123 }),
      ),
    ).toBe(interruption.hint)
    expect(interruptionForSource(interruption, OTHER_SOURCE)).toBeNull()
    expect(
      interruptionForSource(
        interruption,
        new File(['raw'], 'frame.RAF', { lastModified: 124 }),
      ),
    ).toBeNull()
    expect(interruptionForSource(interruption, null)).toBeNull()
    expect(interruptionForSource(null, SOURCE)).toBeNull()
  })

  it('ignores a hint that carries no interruption', () => {
    expect(
      interruptionForSource(
        hintFor(SOURCE, {
          previousCrashLikeInterruption: false,
          previousResourceFailure: false,
          attempts: [],
        }),
        SOURCE,
      ),
    ).toBeNull()
  })

  it('projects the legacy recovery state from the same hint and source', () => {
    const interruption = hintFor(SOURCE, crashHint(['attempt-a', 'attempt-b']))

    expect(projectExportRecovery(interruption, SOURCE)).toEqual({
      status: 'ready-to-retry',
      exportId: 'attempt-a',
      message:
        'The browser interrupted the previous export. Your next export will use a safer low-memory setting.',
    })
    expect(projectExportRecovery(interruption, OTHER_SOURCE)).toEqual({
      status: 'none',
    })
    expect(projectExportRecovery(interruption, null)).toEqual({
      status: 'none',
    })
    expect(projectExportRecovery(null, SOURCE)).toEqual({ status: 'none' })
  })

  it('projects a resource failure as no interruption while keeping it for the plan', () => {
    const interruption = hintFor(SOURCE, {
      previousCrashLikeInterruption: false,
      previousResourceFailure: true,
      attempts: ['attempt-failed'],
    })

    expect(projectExportRecovery(interruption, SOURCE)).toEqual({
      status: 'none',
    })
    expect(interruptionForSource(interruption, SOURCE)).toBe(interruption.hint)
  })

  it('shows an old journal as the same interruption-only hint', () => {
    const recovery = createInterruptedExportRecovery(manifest())

    expect(recovery).toEqual(
      projectExportRecovery(hintFor(SOURCE, crashHint(['export-1'])), SOURCE),
    )
    expect(recovery).not.toHaveProperty('manifest')
    expect(recovery).not.toHaveProperty('expectedFileName')
    expect(recovery.message).not.toMatch(/reselect|resume|restor|reproduc/i)
  })

  it('reads a source hint from the markers without starting anything', async () => {
    const storage = new Map<string, string>()
    const markers = createExportInterruptionMarkers({
      getStorage: () =>
        ({
          get length() {
            return storage.size
          },
          key: (index: number) => Array.from(storage.keys())[index] ?? null,
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => {
            storage.set(key, value)
          },
          removeItem: (key: string) => {
            storage.delete(key)
          },
        }) as unknown as Storage,
      getLocks: () => null,
      createId: (kind) => `${kind}-1`,
      now: () => 1_000,
    })

    await expect(readSourceInterruption(markers, SOURCE)).resolves.toBeNull()

    const { attempt } = await markers.begin(SOURCE)
    markers.finish(attempt, 'resource-failure')

    await expect(readSourceInterruption(markers, SOURCE)).resolves.toEqual({
      source: encodeExportSourceHint(SOURCE),
      hint: {
        previousCrashLikeInterruption: false,
        previousResourceFailure: true,
        attempts: [attempt],
      },
    })
    await expect(
      readSourceInterruption(markers, OTHER_SOURCE),
    ).resolves.toBeNull()
  })

  it('leaves an explicit export untouched without interruption history', () => {
    expect(
      withInterruptionHistory({ quality: 'high', fidelity: 'balanced' }, null),
    ).toEqual({ quality: 'high', fidelity: 'balanced' })
  })

  it('sends the hint with the current choice and nothing from a journal', () => {
    const interruption = hintFor(SOURCE)
    const request = withInterruptionHistory(
      {
        quality: 'standard',
        fidelity: 'max',
        previousInterrupted: true,
        recoveredExportId: 'export-1',
        recoveredManifest: manifest(),
      } as Parameters<typeof withInterruptionHistory>[0],
      interruption,
    )

    expect(request).toEqual({
      quality: 'standard',
      fidelity: 'max',
      interruption,
    })
  })

  it.each([
    [
      { aborted: true, errorCode: 'FULL_RES_EXPORT_RESOURCE_FAILURE' },
      'cancelled',
    ],
    [{ aborted: false, errorCode: 'EXPORT_ABORTED' }, 'failed'],
    [
      { aborted: false, errorCode: 'FULL_RES_EXPORT_RESOURCE_FAILURE' },
      'resource-failure',
    ],
    [
      { aborted: false, errorCode: 'FULL_RES_EXPORT_WORKER_FAILED' },
      'resource-failure',
    ],
    [{ aborted: false, errorCode: 'EXPORT_RENDER_FAILED' }, 'failed'],
    [{ aborted: false, errorCode: 'EXPORT_POLICY_CANNOT_COMPLETE' }, 'failed'],
  ] as const)('classifies a failed attempt %j as %s', (input, outcome) => {
    expect(classifyExportAttemptOutcome(input)).toBe(outcome)
  })

  it('classifies an AbortError as a cancellation', () => {
    expect(
      classifyExportAttemptOutcome({
        aborted: false,
        errorCode: 'EXPORT_RENDER_FAILED',
        error: new DOMException('Aborted', 'AbortError'),
      }),
    ).toBe('cancelled')
  })
})

describe('export recovery reselection', () => {
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
