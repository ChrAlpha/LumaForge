import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ExportInterruptionHint } from '../../../services/export/export-interruption'
import { encodeExportSourceHint } from '../../../services/export/export-interruption'
import type { ExportInterruptionMarkers } from '../../../services/export/export-recovery'
import { useExportInterruptionState } from './useExportInterruptionState'

const markersMock = vi.hoisted(() => ({
  current: null as ExportInterruptionMarkers | null,
}))

vi.mock('../../../services/export/export-recovery', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../services/export/export-recovery')
    >()
  return {
    ...actual,
    getExportInterruptionMarkers: () =>
      markersMock.current ?? actual.getExportInterruptionMarkers(),
  }
})

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

function renderInterruptionState(
  inspect: (source: {
    name: string
    size: number
    lastModified: number
  }) => Promise<ExportInterruptionHint>,
  initialSource: File | null,
) {
  const markers = {
    begin: vi.fn(),
    finish: vi.fn(),
    inspect: vi.fn(inspect),
    retire: vi.fn(),
  }
  markersMock.current = markers as unknown as ExportInterruptionMarkers
  const view = renderHook(
    (props: { sourceFile: File | null }) =>
      useExportInterruptionState(props.sourceFile),
    { initialProps: { sourceFile: initialSource } },
  )

  return { markers, view }
}

describe('useExportInterruptionState', () => {
  beforeEach(() => {
    markersMock.current = null
  })

  it('reads and ends attempts through the page markers', () => {
    const { markers, view } = renderInterruptionState(async () => NO_HINT, null)

    expect(view.result.current.interruptionMarkers).toBe(markers)
    // State and its imperative mirror are the whole surface: no continuation,
    // retry or reselection rides along with the hint.
    expect(Object.keys(view.result.current).sort()).toEqual([
      'exportInterruption',
      'exportInterruptionRef',
      'interruptionMarkers',
      'refreshExportInterruption',
    ])
  })

  it('reads no hint until a source is loaded', () => {
    const { markers, view } = renderInterruptionState(
      async () => CRASH_HINT,
      null,
    )

    expect(markers.inspect).not.toHaveBeenCalled()
    expect(view.result.current.exportInterruption).toBeNull()
    expect(view.result.current.exportInterruptionRef.current).toBeNull()
  })

  it('reads the hint for the loaded source tuple only, mirrored into the ref', async () => {
    const { markers, view } = renderInterruptionState(
      async () => CRASH_HINT,
      SOURCE,
    )
    const expected = {
      source: encodeExportSourceHint(SOURCE),
      hint: CRASH_HINT,
    }

    await waitFor(() => {
      expect(view.result.current.exportInterruption).toEqual(expected)
    })
    expect(view.result.current.exportInterruptionRef.current).toEqual(expected)
    expect(markers.inspect).toHaveBeenCalledTimes(1)
    expect(markers.inspect).toHaveBeenCalledWith({
      name: 'frame.dng',
      size: SOURCE.size,
      lastModified: 123,
    })
    // Reading a hint only reads: no attempt begins, ends or retires.
    expect(markers.begin).not.toHaveBeenCalled()
    expect(markers.finish).not.toHaveBeenCalled()
    expect(markers.retire).not.toHaveBeenCalled()
  })

  it('records nothing for a source without an interruption', async () => {
    const { markers, view } = renderInterruptionState(
      async () => NO_HINT,
      SOURCE,
    )

    await waitFor(() => {
      expect(markers.inspect).toHaveBeenCalledTimes(1)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(view.result.current.exportInterruption).toBeNull()
  })

  it('drops a read that lands after the source changed', async () => {
    const reads = new Map<
      string,
      ReturnType<typeof deferred<ExportInterruptionHint>>
    >()
    const { view } = renderInterruptionState((source) => {
      const read = deferred<ExportInterruptionHint>()
      reads.set(source.name, read)
      return read.promise
    }, SOURCE)

    view.rerender({ sourceFile: OTHER_SOURCE })
    await act(async () => {
      reads.get('other.dng')?.resolve(NO_HINT)
      await Promise.resolve()
    })
    await act(async () => {
      reads.get('frame.dng')?.resolve(CRASH_HINT)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(view.result.current.exportInterruption).toBeNull()
    expect(view.result.current.exportInterruptionRef.current).toBeNull()
  })

  it('clears the hint once the source is unloaded', async () => {
    const { view } = renderInterruptionState(async () => CRASH_HINT, SOURCE)
    await waitFor(() => {
      expect(view.result.current.exportInterruption?.hint).toEqual(CRASH_HINT)
    })

    view.rerender({ sourceFile: null })

    expect(view.result.current.exportInterruption).toBeNull()
    expect(view.result.current.exportInterruptionRef.current).toBeNull()
  })

  it('reads again when the workflow asks for a refresh', async () => {
    let hint = CRASH_HINT
    const { markers, view } = renderInterruptionState(async () => hint, SOURCE)
    await waitFor(() => {
      expect(view.result.current.exportInterruption?.hint).toEqual(CRASH_HINT)
    })

    hint = NO_HINT
    act(() => {
      view.result.current.refreshExportInterruption()
    })

    await waitFor(() => {
      expect(view.result.current.exportInterruption).toBeNull()
    })
    expect(markers.inspect).toHaveBeenCalledTimes(2)
  })

  it('treats a failed read as no hint', async () => {
    const { markers, view } = renderInterruptionState(async () => {
      throw new Error('storage unavailable')
    }, SOURCE)

    await waitFor(() => {
      expect(markers.inspect).toHaveBeenCalledTimes(1)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(view.result.current.exportInterruption).toBeNull()
  })
})
