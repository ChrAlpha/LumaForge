import { describe, expect, it, vi } from 'vitest'

import { runProcessedWindowExportLifecycle } from './processed-window-export'

describe('runProcessedWindowExportLifecycle', () => {
  it('runs begin, export, and end before returning the export result', async () => {
    const order: string[] = []
    const beginProcessedWindowExport = vi.fn(async () => {
      order.push('begin')
    })
    const runExport = vi.fn(async () => {
      order.push('export')
      return 'exported'
    })
    const endProcessedWindowExport = vi.fn(async () => {
      order.push('end')
    })

    await expect(
      runProcessedWindowExportLifecycle({
        beginProcessedWindowExport,
        endProcessedWindowExport,
        runExport,
      }),
    ).resolves.toBe('exported')

    expect(order).toEqual(['begin', 'export', 'end'])
    expect(runExport).toHaveBeenCalledTimes(1)
    expect(endProcessedWindowExport).toHaveBeenCalledTimes(1)
  })

  it('passes the stage signal to begin only', async () => {
    const controller = new AbortController()
    const beginProcessedWindowExport = vi.fn(async () => undefined)
    const endProcessedWindowExport = vi.fn(async () => undefined)

    await runProcessedWindowExportLifecycle({
      beginProcessedWindowExport,
      endProcessedWindowExport,
      runExport: async () => 'exported',
      signal: controller.signal,
    })

    expect(beginProcessedWindowExport).toHaveBeenCalledWith(controller.signal)
    expect(endProcessedWindowExport).toHaveBeenCalledWith()
  })

  it('runs end and preserves the original export error when export fails', async () => {
    const exportError = new Error('EXPORT_FAILED')
    const endProcessedWindowExport = vi.fn(async () => undefined)

    await expect(
      runProcessedWindowExportLifecycle({
        beginProcessedWindowExport: async () => undefined,
        endProcessedWindowExport,
        runExport: async () => {
          throw exportError
        },
      }),
    ).rejects.toBe(exportError)
    expect(endProcessedWindowExport).toHaveBeenCalledTimes(1)
  })

  it('runs end without the aborted export signal after cancellation happens after begin', async () => {
    const controller = new AbortController()
    const endProcessedWindowExport = vi.fn(async () => undefined)

    await expect(
      runProcessedWindowExportLifecycle({
        beginProcessedWindowExport: async () => undefined,
        endProcessedWindowExport,
        runExport: async () => {
          controller.abort()
          throw new Error('FULL_RES_EXPORT_CANCELLED')
        },
        signal: controller.signal,
      }),
    ).rejects.toThrow('FULL_RES_EXPORT_CANCELLED')
    expect(endProcessedWindowExport).toHaveBeenCalledTimes(1)
    expect(endProcessedWindowExport).toHaveBeenCalledWith()
  })

  it('runs export without begin or end when the session has neither hook', async () => {
    const runExport = vi.fn(async () => 'exported')

    await expect(
      runProcessedWindowExportLifecycle({ runExport }),
    ).resolves.toBe('exported')
    expect(runExport).toHaveBeenCalledTimes(1)
  })

  it('runs export without end when begin is unavailable', async () => {
    const runExport = vi.fn(async () => 'exported')
    const endProcessedWindowExport = vi.fn(async () => undefined)

    await expect(
      runProcessedWindowExportLifecycle({
        endProcessedWindowExport,
        runExport,
      }),
    ).resolves.toBe('exported')
    expect(runExport).toHaveBeenCalledTimes(1)
    expect(endProcessedWindowExport).not.toHaveBeenCalled()
  })

  it('runs begin and export when end is unavailable', async () => {
    const beginProcessedWindowExport = vi.fn(async () => undefined)

    await expect(
      runProcessedWindowExportLifecycle({
        beginProcessedWindowExport,
        runExport: async () => 'exported',
      }),
    ).resolves.toBe('exported')
    expect(beginProcessedWindowExport).toHaveBeenCalledTimes(1)
  })

  it('does not run export or end when begin throws', async () => {
    const beginError = new Error('BEGIN_FAILED')
    const runExport = vi.fn(async () => 'exported')
    const endProcessedWindowExport = vi.fn(async () => undefined)

    await expect(
      runProcessedWindowExportLifecycle({
        beginProcessedWindowExport: async () => {
          throw beginError
        },
        endProcessedWindowExport,
        runExport,
      }),
    ).rejects.toBe(beginError)
    expect(runExport).not.toHaveBeenCalled()
    expect(endProcessedWindowExport).not.toHaveBeenCalled()
  })

  it('preserves the original export error when end also throws', async () => {
    const exportError = new Error('EXPORT_FAILED')
    const endProcessedWindowExport = vi.fn(async () => {
      throw new Error('END_FAILED')
    })

    await expect(
      runProcessedWindowExportLifecycle({
        beginProcessedWindowExport: async () => undefined,
        endProcessedWindowExport,
        runExport: async () => {
          throw exportError
        },
      }),
    ).rejects.toBe(exportError)
    expect(endProcessedWindowExport).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a string', 'EXPORT_FAILED'],
    ['undefined', undefined],
    ['null', null],
  ])(
    'keeps a non-Error export failure (%s) ahead of an end failure',
    async (_label, exportFailure) => {
      const endProcessedWindowExport = vi.fn(async () => {
        throw new Error('END_FAILED')
      })

      const outcome = await runProcessedWindowExportLifecycle({
        beginProcessedWindowExport: async () => undefined,
        endProcessedWindowExport,
        runExport: async () => {
          throw exportFailure
        },
      }).then(
        () => ({ settled: 'resolved' as const }),
        (error: unknown) => ({ settled: 'rejected' as const, error }),
      )

      expect(outcome).toEqual({ settled: 'rejected', error: exportFailure })
      expect(endProcessedWindowExport).toHaveBeenCalledTimes(1)
    },
  )

  it('fails before returning success when end throws after a successful export', async () => {
    const cleanupError = new Error('END_FAILED')

    await expect(
      runProcessedWindowExportLifecycle({
        beginProcessedWindowExport: async () => undefined,
        endProcessedWindowExport: async () => {
          throw cleanupError
        },
        runExport: async () => 'exported',
      }),
    ).rejects.toBe(cleanupError)
  })

  it('fails before returning success when end rejects with a non-Error value', async () => {
    const endFailure: unknown = undefined
    const outcome = await runProcessedWindowExportLifecycle({
      beginProcessedWindowExport: async () => undefined,
      endProcessedWindowExport: async () => {
        throw endFailure
      },
      runExport: async () => 'exported',
    }).then(
      (result) => ({ settled: 'resolved' as const, result }),
      (error: unknown) => ({ settled: 'rejected' as const, error }),
    )

    expect(outcome).toEqual({ settled: 'rejected', error: undefined })
  })
})
