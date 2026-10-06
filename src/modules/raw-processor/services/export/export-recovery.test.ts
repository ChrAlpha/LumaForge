import { describe, expect, it } from 'vitest'

import type { ExportInterruptionHint } from './export-interruption'
import {
  createExportInterruptionMarkers,
  encodeExportSourceHint,
} from './export-interruption'
import type { SourceInterruptionHint } from './export-recovery'
import {
  classifyExportAttemptOutcome,
  interruptionForSource,
  isInterruptedSource,
  readSourceInterruption,
  withInterruptionHistory,
} from './export-recovery'

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

  it('notes an interruption only for the file tuple the hint was read for', () => {
    const interruption = hintFor(SOURCE, crashHint(['attempt-a', 'attempt-b']))

    expect(isInterruptedSource(interruption, SOURCE)).toBe(true)
    expect(isInterruptedSource(interruption, OTHER_SOURCE)).toBe(false)
    expect(isInterruptedSource(interruption, null)).toBe(false)
    expect(isInterruptedSource(null, SOURCE)).toBe(false)
  })

  it('notes a resource failure as no interruption while keeping it for the plan', () => {
    const interruption = hintFor(SOURCE, {
      previousCrashLikeInterruption: false,
      previousResourceFailure: true,
      attempts: ['attempt-failed'],
    })

    expect(isInterruptedSource(interruption, SOURCE)).toBe(false)
    expect(interruptionForSource(interruption, SOURCE)).toBe(interruption.hint)
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

  it('sends an explicit export with nothing without interruption history', () => {
    expect(withInterruptionHistory(null)).toEqual({})
  })

  it('sends only the hint, with no quality choice and nothing from a journal', () => {
    const interruption = hintFor(SOURCE)

    expect(withInterruptionHistory(interruption)).toEqual({ interruption })
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
