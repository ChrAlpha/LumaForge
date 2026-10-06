import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ExportInterruptionHint } from '../../../services/export/export-interruption'
import { encodeExportSourceHint } from '../../../services/export/export-interruption'
import type { SourceInterruptionHint } from '../../../services/export/export-recovery'
import { useExportRecoveryDiscovery } from './useExportRecoveryDiscovery'

const SOURCE = new File(['raw'], 'frame.dng', { lastModified: 123 })
const OTHER_SOURCE = new File(['other'], 'other.dng', { lastModified: 456 })

const CRASH_HINT: ExportInterruptionHint = {
  previousCrashLikeInterruption: true,
  previousResourceFailure: false,
  attempts: ['attempt-a'],
}
const NO_HINT: ExportInterruptionHint = {
  previousCrashLikeInterruption: false,
  previousResourceFailure: false,
  attempts: [],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

type DiscoveryProps = {
  sourceFile: File | null
  interruptionCheck: number
}

function renderDiscovery(
  inspect: (source: {
    name: string
    size: number
    lastModified: number
  }) => Promise<ExportInterruptionHint>,
  initialProps: DiscoveryProps,
) {
  const state: { interruption: SourceInterruptionHint | null | undefined } = {
    interruption: undefined,
  }
  const markers = { inspect: vi.fn(inspect) }
  const setExportInterruption = vi.fn((next: SourceInterruptionHint | null) => {
    state.interruption = next
  })
  const view = renderHook(
    (props: DiscoveryProps) =>
      useExportRecoveryDiscovery({
        ...props,
        markers,
        setExportInterruption,
      }),
    { initialProps },
  )

  return { state, markers, setExportInterruption, view }
}

describe('useExportRecoveryDiscovery', () => {
  it('reads no hint until a source is loaded', () => {
    const { state, markers } = renderDiscovery(async () => CRASH_HINT, {
      sourceFile: null,
      interruptionCheck: 0,
    })

    expect(markers.inspect).not.toHaveBeenCalled()
    expect(state.interruption).toBeNull()
  })

  it('reads the hint for the loaded source tuple only', async () => {
    const { state, markers } = renderDiscovery(async () => CRASH_HINT, {
      sourceFile: SOURCE,
      interruptionCheck: 0,
    })

    await waitFor(() => {
      expect(state.interruption).toEqual({
        source: encodeExportSourceHint(SOURCE),
        hint: CRASH_HINT,
      })
    })
    expect(markers.inspect).toHaveBeenCalledTimes(1)
    expect(markers.inspect).toHaveBeenCalledWith({
      name: 'frame.dng',
      size: SOURCE.size,
      lastModified: 123,
    })
  })

  it('records nothing for a source without an interruption', async () => {
    const { state, markers } = renderDiscovery(async () => NO_HINT, {
      sourceFile: SOURCE,
      interruptionCheck: 0,
    })

    await waitFor(() => {
      expect(markers.inspect).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(state.interruption).toBeNull()
    })
  })

  it('drops a read that lands after the source changed', async () => {
    const reads = new Map<
      string,
      ReturnType<typeof deferred<ExportInterruptionHint>>
    >()
    const { state, view } = renderDiscovery(
      (source) => {
        const read = deferred<ExportInterruptionHint>()
        reads.set(source.name, read)
        return read.promise
      },
      { sourceFile: SOURCE, interruptionCheck: 0 },
    )

    view.rerender({ sourceFile: OTHER_SOURCE, interruptionCheck: 0 })
    reads.get('other.dng')?.resolve(NO_HINT)
    await waitFor(() => {
      expect(state.interruption).toBeNull()
    })
    reads.get('frame.dng')?.resolve(CRASH_HINT)
    await Promise.resolve()
    await Promise.resolve()

    expect(state.interruption).toBeNull()
  })

  it('reads again when the workflow asks for a refresh', async () => {
    let hint = CRASH_HINT
    const { state, markers, view } = renderDiscovery(async () => hint, {
      sourceFile: SOURCE,
      interruptionCheck: 0,
    })
    await waitFor(() => {
      expect(state.interruption?.hint).toEqual(CRASH_HINT)
    })

    hint = NO_HINT
    view.rerender({ sourceFile: SOURCE, interruptionCheck: 1 })

    await waitFor(() => {
      expect(state.interruption).toBeNull()
    })
    expect(markers.inspect).toHaveBeenCalledTimes(2)
  })

  it('treats a failed read as no hint', async () => {
    const { state } = renderDiscovery(
      async () => {
        throw new Error('storage unavailable')
      },
      { sourceFile: SOURCE, interruptionCheck: 0 },
    )

    await waitFor(() => {
      expect(state.interruption).toBeNull()
    })
  })
})
