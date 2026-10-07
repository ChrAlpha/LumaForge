export type ProcessedWindowExportLifecycleInput<Result> = {
  beginProcessedWindowExport?: (signal?: AbortSignal) => Promise<unknown>
  endProcessedWindowExport?: (signal?: AbortSignal) => Promise<unknown>
  runExport: () => Promise<Result>
  signal?: AbortSignal
}

/**
 * Brackets one processed-window export with the session's optional
 * begin/end hooks. End runs only after a successful begin and without the
 * stage signal, so a cancelled export still releases the session state. The
 * export only counts when end succeeds too: an end failure rejects an
 * otherwise successful export, but never replaces the export's own failure,
 * whatever value it was rejected with.
 */
export async function runProcessedWindowExportLifecycle<Result>({
  beginProcessedWindowExport,
  endProcessedWindowExport,
  runExport,
  signal,
}: ProcessedWindowExportLifecycleInput<Result>): Promise<Result> {
  let processedWindowExportActive = false

  if (beginProcessedWindowExport) {
    await beginProcessedWindowExport(signal)
    processedWindowExportActive = true
  }

  let failure: { error: unknown } | null = null
  let result: Result | undefined

  try {
    result = await runExport()
  } catch (error) {
    failure = { error }
  }

  if (processedWindowExportActive && endProcessedWindowExport) {
    try {
      await endProcessedWindowExport()
    } catch (error) {
      failure ??= { error }
    }
  }

  if (failure) {
    throw failure.error
  }

  return result as Result
}
