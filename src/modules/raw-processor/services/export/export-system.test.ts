import type { ExportColorGraphDescriptor } from '@lumaforge/luma-color-runtime'
import { createBlobOutputResult } from '@lumaforge/render-engine/export'
import type {
  CapabilityVector,
  ExportRuntimeResources,
} from '@lumaforge/render-engine/policy'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { getExportModeCopy } from '~/lib/export/execution-profile'
import type { ExportExecutionPlan } from '~/lib/export/export-plan'
import { selectExportPlan } from '~/lib/export/export-plan'
import type { RunFullResolutionJpegExportInWorkerInput } from '~/lib/export/full-res-export-client'

import {
  buildExportFilename,
  buildPreviewExportFilename,
  EXPORT_JPEG_QUALITY,
  HQ_PREVIEW_EXPORT_MAX_PIXELS,
  planExportWithSampledFacts,
  recommendRetryLevel,
  resolveHqPreviewExportSize,
  runFullResolutionExportJob,
} from './export-system'

const FILE = new File(['raw'], 'frame.ARW')
const FILENAME = 'frame_neutral_fullres.jpg'
const GRAPH: ExportColorGraphDescriptor = {
  supported: true,
  outputGamut: 'srgb-rec709',
  outputTransfer: 'srgb',
  lutProfile: null,
  steps: [{ kind: 'input-linear-prophoto' }, { kind: 'output-srgb' }],
}
const OUTPUT = createBlobOutputResult({
  filename: FILENAME,
  blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
})
const OUTPUT_LOCATION = {
  sink: 'opfs-file',
  tabDirectory: 'tab-1',
  exportId: 'export-1',
} as const

const DESKTOP: CapabilityVector = {
  coi: true,
  pthread: true,
  deviceMemoryGB: 16,
  hwConcurrency: 8,
  webKitClass: 'chromium',
  deviceFormFactor: 'desktop',
  maybeOpfsSupported: true,
}
const MOBILE: CapabilityVector = {
  coi: false,
  pthread: false,
  deviceMemoryGB: null,
  hwConcurrency: 4,
  webKitClass: 'webkit-mobile',
  deviceFormFactor: 'mobile',
  maybeOpfsSupported: true,
}
const OPFS_RUNTIME: ExportRuntimeResources = {
  opfsSinkAvailable: true,
  opfsAvailableMB: 10_000,
  streamingSinkAvailable: false,
}
const BLOB_RUNTIME: ExportRuntimeResources = {
  opfsSinkAvailable: false,
  opfsAvailableMB: null,
  streamingSinkAvailable: false,
}
/** Above the large-export threshold, where a mobile blob handoff is refused. */
const LARGE = { width: 9000, height: 6700 }
const NORMAL = { width: 6000, height: 4000 }

function plan(
  capability: CapabilityVector,
  runtime: ExportRuntimeResources,
  source: { width: number; height: number },
) {
  return selectExportPlan({
    preference: 'balanced',
    source,
    capability,
    runtime,
  })
}

/** What a retry samples: the same device, unless a test says otherwise. */
function facts(capability: CapabilityVector, runtime: ExportRuntimeResources) {
  return vi.fn(async () => ({ capability, runtime }))
}

type Outcome = { error: unknown } | { output: typeof OUTPUT }

/** One fresh client per attempt, settling with the next scripted outcome. */
function scriptClients(...outcomes: Outcome[]) {
  const runs: RunFullResolutionJpegExportInWorkerInput[] = []
  const clients: Array<{
    run: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
  }> = []
  const order: string[] = []
  const clientFactory = vi.fn(() => {
    const outcome = outcomes[clients.length]
    if (!outcome) throw new Error('No scripted outcome for this attempt.')
    const client = {
      run: vi.fn(async (input: RunFullResolutionJpegExportInWorkerInput) => {
        order.push(`run:${input.executionPlan?.outputSink}`)
        runs.push(input)
        if ('error' in outcome) throw outcome.error
        return outcome.output
      }),
      dispose: vi.fn(),
    }
    clients.push(client)
    return client
  })

  return { runs, clients, order, clientFactory: clientFactory as never }
}

const OPFS_UNAVAILABLE = {
  error: new Error('FULL_RES_EXPORT_OPFS_OUTPUT_UNAVAILABLE'),
}
const RESOURCE_FAILURE = {
  error: new Error('FULL_RES_EXPORT_RESOURCE_FAILURE'),
}
const SUCCESS = { output: OUTPUT }

describe('export naming and sizing', () => {
  it('names full-resolution and HQ preview files apart', () => {
    expect(buildExportFilename('frame.ARW', 'Neutral')).toBe(
      'frame_Neutral_fullres.jpg',
    )
    expect(buildPreviewExportFilename('frame.ARW', 'Neutral')).toBe(
      'frame_Neutral_hq-preview.jpg',
    )
  })

  it('caps an HQ preview export at 12MP, keeping its aspect ratio', () => {
    const size = resolveHqPreviewExportSize({ width: 6000, height: 4000 })
    expect(size.width * size.height).toBeLessThanOrEqual(
      HQ_PREVIEW_EXPORT_MAX_PIXELS,
    )
    expect(size.width * size.height).toBeGreaterThanOrEqual(11_900_000)
    expect(size.width / size.height).toBeCloseTo(1.5, 2)
    expect(resolveHqPreviewExportSize({ width: 3840, height: 2160 })).toEqual({
      width: 3840,
      height: 2160,
    })
  })

  it('recommends the next lower fidelity level on failure', () => {
    expect(recommendRetryLevel('max')).toBe('balanced')
    expect(recommendRetryLevel('balanced')).toBe('safe')
    expect(recommendRetryLevel('safe')).toBe(null)
  })
})

describe('runFullResolutionExportJob output location', () => {
  it('hands the reserved OPFS location to an opfs-file attempt', async () => {
    const executionPlan = plan(DESKTOP, OPFS_RUNTIME, NORMAL)
    expect(executionPlan.outputSink).toBe('opfs-file')
    const script = scriptClients(SUCCESS)
    const { signal } = new AbortController()

    const result = await runFullResolutionExportJob({
      file: FILE,
      filename: FILENAME,
      graph: GRAPH,
      executionPlan,
      outputLocation: OUTPUT_LOCATION,
      signal,
      beforeStart: async () => {
        script.order.push('before-start')
      },
      clientFactory: script.clientFactory,
    })

    expect(result).toEqual({ filename: FILENAME, output: OUTPUT, attempts: 1 })
    expect(script.order).toEqual(['before-start', 'run:opfs-file'])
    expect(script.runs).toEqual([
      expect.objectContaining({
        file: FILE,
        filename: FILENAME,
        graph: GRAPH,
        signal,
        executionPlan: expect.objectContaining({
          outputSink: 'opfs-file',
          preferredRows: executionPlan.preferredRows,
          concurrency: executionPlan.concurrency,
          runtimeMemoryProfile: executionPlan.runtimeMemoryProfile,
        }),
        outputLocation: OUTPUT_LOCATION,
      }),
    ])
    expect(script.runs[0]).not.toHaveProperty('checkpoint')
    expect(script.clients[0]!.dispose).toHaveBeenCalledTimes(1)
  })

  it('refuses an opfs-file plan without a reserved location before starting a worker', async () => {
    const script = scriptClients(SUCCESS)

    await expect(
      runFullResolutionExportJob({
        file: FILE,
        filename: FILENAME,
        graph: GRAPH,
        executionPlan: plan(DESKTOP, OPFS_RUNTIME, NORMAL),
        clientFactory: script.clientFactory,
      }),
    ).rejects.toThrow('FULL_RES_EXPORT_OUTPUT_LOCATION_INVALID')
    expect(script.clientFactory).not.toHaveBeenCalled()
  })

  it('keeps an ordinary blob export in memory', async () => {
    const executionPlan = plan(DESKTOP, BLOB_RUNTIME, NORMAL)
    expect(executionPlan.outputSink).toBe('blob-handoff')
    const script = scriptClients(SUCCESS)
    const onPlan = vi.fn()

    await runFullResolutionExportJob({
      file: FILE,
      filename: FILENAME,
      graph: GRAPH,
      executionPlan,
      outputLocation: OUTPUT_LOCATION,
      onPlan,
      clientFactory: script.clientFactory,
    })

    expect(script.runs).toHaveLength(1)
    expect(script.runs[0]).toMatchObject({
      executionPlan: { outputSink: 'blob-handoff' },
    })
    expect(script.runs[0]).not.toHaveProperty('checkpoint')
    expect(script.runs[0]!.outputLocation).toBeUndefined()
    expect(onPlan).not.toHaveBeenCalled()
  })
})

describe('runFullResolutionExportJob plan safety', () => {
  it('refuses an initial plan that cannot safely complete before starting a worker', async () => {
    const executionPlan = plan(MOBILE, BLOB_RUNTIME, LARGE)
    expect(executionPlan.productCopy).toBe('cannot-safely-complete')
    const script = scriptClients(SUCCESS)

    await expect(
      runFullResolutionExportJob({
        file: FILE,
        filename: FILENAME,
        graph: GRAPH,
        executionPlan,
        sampleFacts: facts(MOBILE, BLOB_RUNTIME),
        clientFactory: script.clientFactory,
      }),
    ).rejects.toMatchObject({
      code: 'EXPORT_POLICY_CANNOT_COMPLETE',
      message: getExportModeCopy('cannot-safely-complete'),
    })
    expect(script.clientFactory).not.toHaveBeenCalled()
  })

  it('refuses a retry plan that cannot safely complete instead of starting another worker', async () => {
    // OPFS is gone by the time the retry samples the device again.
    const executionPlan = plan(MOBILE, OPFS_RUNTIME, LARGE)
    expect(executionPlan.outputSink).toBe('opfs-file')
    expect(executionPlan.productCopy).not.toBe('cannot-safely-complete')
    const script = scriptClients(RESOURCE_FAILURE, SUCCESS)
    const onPlan = vi.fn()
    const onAttempt = vi.fn()

    await expect(
      runFullResolutionExportJob({
        file: FILE,
        filename: FILENAME,
        graph: GRAPH,
        executionPlan,
        outputLocation: OUTPUT_LOCATION,
        onPlan,
        onAttempt,
        sampleFacts: facts(MOBILE, BLOB_RUNTIME),
        clientFactory: script.clientFactory,
      }),
    ).rejects.toMatchObject({ code: 'EXPORT_POLICY_CANNOT_COMPLETE' })
    expect(script.clientFactory).toHaveBeenCalledTimes(1)
    expect(script.clients[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(onPlan).not.toHaveBeenCalled()
    // A refused replacement is never announced as a scheduled retry.
    expect(onAttempt.mock.calls.map(([event]) => event.phase)).toEqual([
      'started',
      'disposed',
    ])
  })

  it('reports the blob plan and continues on a fresh worker when the OPFS output cannot open and policy allows it', async () => {
    const executionPlan = plan(DESKTOP, OPFS_RUNTIME, NORMAL)
    const script = scriptClients(OPFS_UNAVAILABLE, SUCCESS)
    const onPlan = vi.fn((next: ExportExecutionPlan) => {
      script.order.push(`plan:${next.outputSink}`)
    })
    const onAttempt = vi.fn()

    const result = await runFullResolutionExportJob({
      file: FILE,
      filename: FILENAME,
      graph: GRAPH,
      executionPlan,
      outputLocation: OUTPUT_LOCATION,
      onPlan,
      onAttempt,
      sampleFacts: facts(DESKTOP, OPFS_RUNTIME),
      clientFactory: script.clientFactory,
    })

    expect(result).toEqual({ filename: FILENAME, output: OUTPUT, attempts: 2 })
    expect(script.order).toEqual([
      'run:opfs-file',
      'plan:blob-handoff',
      'run:blob-handoff',
    ])
    const fallback = onPlan.mock.calls[0]![0]
    expect(fallback).toMatchObject({
      outputSink: 'blob-handoff',
      // Losing the sink is not memory pressure: the strip budget holds.
      preferredRows: executionPlan.preferredRows,
      concurrency: executionPlan.concurrency,
      runtimeMemoryProfile: executionPlan.runtimeMemoryProfile,
    })
    expect(fallback.productCopy).not.toBe('cannot-safely-complete')
    expect(script.runs[1]).toMatchObject({
      executionPlan: {
        outputSink: 'blob-handoff',
        preferredRows: executionPlan.preferredRows,
        concurrency: executionPlan.concurrency,
      },
    })
    expect(script.runs[1]).not.toHaveProperty('checkpoint')
    expect(script.runs[1]!.outputLocation).toBeUndefined()
    expect(
      script.clients.map((client) => client.dispose.mock.calls.length),
    ).toEqual([1, 1])
    expect(onAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        phase: 'retry-scheduled',
        retryReason: 'FULL_RES_EXPORT_OPFS_OUTPUT_UNAVAILABLE',
        freshWorker: true,
      }),
    )
  })

  it('refuses with cannot-safely-complete when the OPFS output cannot open for a large mobile export', async () => {
    const executionPlan = plan(MOBILE, OPFS_RUNTIME, LARGE)
    expect(executionPlan.outputSink).toBe('opfs-file')
    const script = scriptClients(OPFS_UNAVAILABLE, SUCCESS)
    const onPlan = vi.fn()
    const onAttempt = vi.fn()

    await expect(
      runFullResolutionExportJob({
        file: FILE,
        filename: FILENAME,
        graph: GRAPH,
        executionPlan,
        outputLocation: OUTPUT_LOCATION,
        onPlan,
        onAttempt,
        sampleFacts: facts(MOBILE, OPFS_RUNTIME),
        clientFactory: script.clientFactory,
      }),
    ).rejects.toMatchObject({
      code: 'EXPORT_POLICY_CANNOT_COMPLETE',
      message: getExportModeCopy('cannot-safely-complete'),
    })
    expect(script.clientFactory).toHaveBeenCalledTimes(1)
    expect(script.clients[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(onPlan).not.toHaveBeenCalled()
    expect(onAttempt.mock.calls.map(([event]) => event.phase)).toEqual([
      'started',
      'disposed',
    ])
  })

  it('keeps the OPFS sink and location across a fresh-worker resource retry and reports the retry plan', async () => {
    const executionPlan = plan(DESKTOP, OPFS_RUNTIME, NORMAL)
    const script = scriptClients(RESOURCE_FAILURE, SUCCESS)
    const onPlan = vi.fn()
    const onAttempt = vi.fn()

    await runFullResolutionExportJob({
      file: FILE,
      filename: FILENAME,
      graph: GRAPH,
      executionPlan,
      outputLocation: OUTPUT_LOCATION,
      onPlan,
      onAttempt,
      sampleFacts: facts(DESKTOP, OPFS_RUNTIME),
      clientFactory: script.clientFactory,
    })

    // The retry is scheduled before the failed worker is let go, the next
    // attempt starts on a fresh one, and each worker is let go once.
    expect(
      onAttempt.mock.calls.map(([event]) => [event.attempt, event.phase]),
    ).toEqual([
      [1, 'started'],
      [1, 'retry-scheduled'],
      [1, 'disposed'],
      [2, 'started'],
      [2, 'disposed'],
    ])
    expect(
      script.clients.map((client) => client.dispose.mock.calls.length),
    ).toEqual([1, 1])

    expect(script.runs[1]).toMatchObject({
      executionPlan: { outputSink: 'opfs-file', concurrency: 1 },
      outputLocation: OUTPUT_LOCATION,
    })
    expect(onPlan).toHaveBeenCalledTimes(1)
    expect(onPlan.mock.calls[0]![0]).toMatchObject({
      outputSink: 'opfs-file',
      preferredRows: script.runs[1]!.executionPlan!.preferredRows,
      concurrency: 1,
    })
  })

  it('encodes every attempt at the fixed JPEG quality, retries and sink fallbacks included', async () => {
    expect(EXPORT_JPEG_QUALITY).toBe(0.92)
    const executionPlan = plan(DESKTOP, OPFS_RUNTIME, NORMAL)
    const script = scriptClients(RESOURCE_FAILURE, OPFS_UNAVAILABLE, SUCCESS)

    await runFullResolutionExportJob({
      file: FILE,
      filename: FILENAME,
      graph: GRAPH,
      quality: EXPORT_JPEG_QUALITY,
      executionPlan,
      outputLocation: OUTPUT_LOCATION,
      sampleFacts: facts(DESKTOP, OPFS_RUNTIME),
      clientFactory: script.clientFactory,
    })

    expect(script.runs).toHaveLength(3)
    expect(script.runs.map((run) => run.quality)).toEqual([0.92, 0.92, 0.92])
  })

  it('keeps a sink fallback within the strip budget a resource retry already reduced', async () => {
    const executionPlan = plan(DESKTOP, OPFS_RUNTIME, NORMAL)
    const script = scriptClients(
      {
        error: Object.assign(new Error('FULL_RES_EXPORT_RESOURCE_FAILURE'), {
          nextRows: 128,
        }),
      },
      OPFS_UNAVAILABLE,
      SUCCESS,
    )
    const onPlan = vi.fn()
    const onAttempt = vi.fn()

    await runFullResolutionExportJob({
      file: FILE,
      filename: FILENAME,
      graph: GRAPH,
      executionPlan,
      outputLocation: OUTPUT_LOCATION,
      onPlan,
      onAttempt,
      sampleFacts: facts(DESKTOP, OPFS_RUNTIME),
      clientFactory: script.clientFactory,
    })

    expect(script.order).toEqual([
      'run:opfs-file',
      'run:opfs-file',
      'run:blob-handoff',
    ])
    expect(script.runs[1]).toMatchObject({
      executionPlan: { preferredRows: 128, concurrency: 1 },
    })
    expect(script.runs[2]).toMatchObject({
      preferredRows: 128,
      concurrency: 1,
      executionPlan: {
        outputSink: 'blob-handoff',
        preferredRows: 128,
        concurrency: 1,
      },
    })
    expect(onPlan).toHaveBeenCalledTimes(2)
    expect(onPlan.mock.calls[1]![0]).toMatchObject({
      outputSink: 'blob-handoff',
      preferredRows: 128,
      concurrency: 1,
    })
    expect(onAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 2,
        phase: 'retry-scheduled',
        retryReason: 'FULL_RES_EXPORT_OPFS_OUTPUT_UNAVAILABLE',
        nextRows: 128,
        nextConcurrency: 1,
      }),
    )
  })

  it('stays off OPFS for later retries and still bounds the attempts after a sink fallback', async () => {
    const executionPlan = plan(DESKTOP, OPFS_RUNTIME, NORMAL)
    const script = scriptClients(
      OPFS_UNAVAILABLE,
      RESOURCE_FAILURE,
      RESOURCE_FAILURE,
      SUCCESS,
    )
    const onPlan = vi.fn()

    await expect(
      runFullResolutionExportJob({
        file: FILE,
        filename: FILENAME,
        graph: GRAPH,
        executionPlan,
        outputLocation: OUTPUT_LOCATION,
        onPlan,
        sampleFacts: facts(DESKTOP, OPFS_RUNTIME),
        clientFactory: script.clientFactory,
      }),
    ).rejects.toThrow('FULL_RES_EXPORT_RESOURCE_FAILURE')
    expect(script.order).toEqual([
      'run:opfs-file',
      'run:blob-handoff',
      'run:blob-handoff',
    ])
    expect(script.runs.slice(1).map((run) => run.outputLocation)).toEqual([
      undefined,
      undefined,
    ])
    expect(onPlan.mock.calls.map(([next]) => next.outputSink)).toEqual([
      'blob-handoff',
      'blob-handoff',
    ])
    expect(
      script.clients.map((client) => client.dispose.mock.calls.length),
    ).toEqual([1, 1, 1])
  })
})

describe('runFullResolutionExportJob attempt diagnostics', () => {
  it('keeps a throwing attempt observer out of the export outcome', async () => {
    const onAttempt = vi.fn(() => {
      throw new Error('DIAGNOSTICS_FAILED')
    })
    const executionPlan = plan(DESKTOP, BLOB_RUNTIME, NORMAL)
    const done = scriptClients(SUCCESS)
    await expect(
      runFullResolutionExportJob({
        file: FILE,
        filename: FILENAME,
        graph: GRAPH,
        executionPlan,
        onAttempt,
        clientFactory: done.clientFactory,
      }),
    ).resolves.toEqual({ filename: FILENAME, output: OUTPUT, attempts: 1 })
    expect(done.clients[0]!.dispose).toHaveBeenCalledTimes(1)

    const fatal = new Error('FULL_RES_EXPORT_FATAL_FAILURE')
    const failed = scriptClients({ error: fatal })
    await expect(
      runFullResolutionExportJob({
        file: FILE,
        filename: FILENAME,
        graph: GRAPH,
        executionPlan,
        onAttempt,
        clientFactory: failed.clientFactory,
      }),
    ).rejects.toBe(fatal)
    expect(failed.clientFactory).toHaveBeenCalledTimes(1)
    expect(failed.clients[0]!.dispose).toHaveBeenCalledTimes(1)
  })
})

describe('runFullResolutionExportJob retry facts', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('samples real storage when the export plans and again for its retry', async () => {
    // Room for the output at plan time; almost none by the retry.
    const estimate = vi
      .fn()
      .mockResolvedValueOnce({ quota: 1_000_000_000, usage: 0 })
      .mockResolvedValueOnce({ quota: 100_000_000, usage: 0 })
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Chrome/126 Safari/537.36',
      maxTouchPoints: 0,
      hardwareConcurrency: 8,
      storage: { getDirectory: vi.fn(), estimate },
    })
    vi.stubGlobal('SharedArrayBuffer', class SharedArrayBuffer {})
    vi.stubGlobal('crossOriginIsolated', true)
    const executionPlan = await planExportWithSampledFacts({
      preference: 'balanced',
      source: NORMAL,
    })
    expect(executionPlan.outputSink).toBe('opfs-file')
    expect(estimate).toHaveBeenCalledTimes(1)
    const script = scriptClients(RESOURCE_FAILURE, SUCCESS)

    await runFullResolutionExportJob({
      file: FILE,
      filename: FILENAME,
      graph: GRAPH,
      executionPlan,
      outputLocation: OUTPUT_LOCATION,
      clientFactory: script.clientFactory,
    })

    expect(estimate).toHaveBeenCalledTimes(2)
    expect(script.order).toEqual(['run:opfs-file', 'run:blob-handoff'])
    expect(script.runs[1]!.outputLocation).toBeUndefined()
  })

  it('keeps a retry on blob handoff when the job reserved no OPFS location', async () => {
    const executionPlan = plan(DESKTOP, BLOB_RUNTIME, NORMAL)
    expect(executionPlan.outputSink).toBe('blob-handoff')
    const script = scriptClients(RESOURCE_FAILURE, SUCCESS)

    // The storage recovers by the retry; the job still has no OPFS address.
    const result = await runFullResolutionExportJob({
      file: FILE,
      filename: FILENAME,
      graph: GRAPH,
      executionPlan,
      sampleFacts: facts(DESKTOP, OPFS_RUNTIME),
      clientFactory: script.clientFactory,
    })

    expect(result.attempts).toBe(2)
    expect(script.order).toEqual(['run:blob-handoff', 'run:blob-handoff'])
    expect(script.runs[1]!.outputLocation).toBeUndefined()
  })

  it('starts no further attempt when the job is aborted while retry facts are sampled', async () => {
    const controller = new AbortController()
    let resolveFacts!: (value: {
      capability: CapabilityVector
      runtime: ExportRuntimeResources
    }) => void
    let samplingStarted!: () => void
    const sampling = new Promise<void>((resolve) => {
      samplingStarted = resolve
    })
    const sampleFacts = vi.fn(
      () =>
        new Promise<{
          capability: CapabilityVector
          runtime: ExportRuntimeResources
        }>((resolve) => {
          resolveFacts = resolve
          samplingStarted()
        }),
    )
    const script = scriptClients(RESOURCE_FAILURE, SUCCESS)
    const beforeStart = vi.fn()
    const onPlan = vi.fn()
    const onAttempt = vi.fn()

    const job = runFullResolutionExportJob({
      file: FILE,
      filename: FILENAME,
      graph: GRAPH,
      executionPlan: plan(DESKTOP, BLOB_RUNTIME, NORMAL),
      signal: controller.signal,
      beforeStart,
      onPlan,
      onAttempt,
      sampleFacts,
      clientFactory: script.clientFactory,
    })
    await sampling
    controller.abort()
    resolveFacts({ capability: DESKTOP, runtime: BLOB_RUNTIME })

    await expect(job).rejects.toMatchObject({ name: 'AbortError' })
    expect(beforeStart).toHaveBeenCalledTimes(1)
    expect(script.clientFactory).toHaveBeenCalledTimes(1)
    expect(onPlan).not.toHaveBeenCalled()
    expect(onAttempt).not.toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'retry-scheduled' }),
    )
  })

  it('samples the device again for a resource retry instead of reusing the first plan facts', async () => {
    const executionPlan = plan(DESKTOP, OPFS_RUNTIME, NORMAL)
    expect(executionPlan.outputSink).toBe('opfs-file')
    const script = scriptClients(RESOURCE_FAILURE, SUCCESS)
    // OPFS went away between the first attempt and the retry.
    const sampleFacts = vi.fn(async () => ({
      capability: DESKTOP,
      runtime: BLOB_RUNTIME,
    }))

    await runFullResolutionExportJob({
      file: FILE,
      filename: FILENAME,
      graph: GRAPH,
      executionPlan,
      outputLocation: OUTPUT_LOCATION,
      sampleFacts,
      clientFactory: script.clientFactory,
    })

    expect(sampleFacts).toHaveBeenCalledTimes(1)
    expect(script.order).toEqual(['run:opfs-file', 'run:blob-handoff'])
    expect(script.runs[1]!.outputLocation).toBeUndefined()
  })

  it('samples the device again for a sink fallback and keeps OPFS off for it', async () => {
    const executionPlan = plan(DESKTOP, OPFS_RUNTIME, NORMAL)
    const script = scriptClients(OPFS_UNAVAILABLE, SUCCESS)
    // The fresh sample is a phone: the fallback is planned for it, not for
    // the desktop the first attempt saw.
    const sampleFacts = vi.fn(async () => ({
      capability: MOBILE,
      runtime: OPFS_RUNTIME,
    }))
    const onPlan = vi.fn()

    await runFullResolutionExportJob({
      file: FILE,
      filename: FILENAME,
      graph: GRAPH,
      executionPlan,
      outputLocation: OUTPUT_LOCATION,
      onPlan,
      sampleFacts,
      clientFactory: script.clientFactory,
    })

    expect(sampleFacts).toHaveBeenCalledTimes(1)
    expect(onPlan.mock.calls[0]![0]).toMatchObject({
      outputSink: 'blob-handoff',
      runtimeMemoryProfile: 'low-memory',
      concurrency: 1,
    })
  })
})
