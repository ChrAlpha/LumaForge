import type { ExportColorGraphDescriptor } from '@lumaforge/luma-color-runtime'
import { createBlobOutputResult } from '@lumaforge/render-engine/export'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { selectExportPlan } from '~/lib/export/export-plan'
import { resetCapabilityVectorForTest } from '~/lib/runtime/capability-vector'

import {
  buildExportFilename,
  buildPreviewExportFilename,
  HQ_PREVIEW_EXPORT_MAX_PIXELS,
  planExportWithSampledFacts,
  recommendRetryLevel,
  resolveHqPreviewExportSize,
  runFullResolutionExportJob,
} from '../services/export/export-system'

describe('export-system', () => {
  beforeEach(() => {
    vi.stubGlobal('crossOriginIsolated', true)
  })

  afterEach(() => {
    resetCapabilityVectorForTest()
    vi.unstubAllGlobals()
  })

  it('generates filenames for builtin and custom styles', () => {
    expect(buildExportFilename('frame.ARW', 'Neutral')).toBe(
      'frame_Neutral_fullres.jpg',
    )
    expect(buildExportFilename('frame.ARW', 'custom')).toBe(
      'frame_custom_fullres.jpg',
    )
  })

  it('generates distinct HQ preview filenames', () => {
    expect(buildPreviewExportFilename('frame.ARW', 'Neutral')).toBe(
      'frame_Neutral_hq-preview.jpg',
    )
  })

  it('caps HQ preview export size at 12MP while preserving aspect ratio', () => {
    const size = resolveHqPreviewExportSize({
      width: 6000,
      height: 4000,
    })

    expect(size.width * size.height).toBeLessThanOrEqual(
      HQ_PREVIEW_EXPORT_MAX_PIXELS,
    )
    expect(size.width * size.height).toBeGreaterThanOrEqual(11_900_000)
    expect(size.width / size.height).toBeCloseTo(1.5, 2)
  })

  it('keeps already bounded HQ preview export size unchanged', () => {
    expect(
      resolveHqPreviewExportSize({
        width: 3840,
        height: 2160,
      }),
    ).toEqual({
      width: 3840,
      height: 2160,
    })
  })

  it('recommends the next lower fidelity level on failure', () => {
    expect(recommendRetryLevel('max')).toBe('balanced')
    expect(recommendRetryLevel('balanced')).toBe('safe')
    expect(recommendRetryLevel('safe')).toBe(null)
  })

  it('returns safe fallback defaults for each fidelity with unknown capability', () => {
    const unknownCap = Object.freeze({
      coi: true,
      pthread: true,
      deviceMemoryGB: null,
      hwConcurrency: 1,
      webKitClass: 'unknown' as const,
      deviceFormFactor: 'unknown' as const,
      maybeOpfsSupported: false,
    })
    const noopfsRuntime = Object.freeze({
      opfsSinkAvailable: false,
      opfsAvailableMB: null,
      streamingSinkAvailable: false,
    })

    for (const fidelity of ['safe', 'balanced', 'max'] as const) {
      const plan = selectExportPlan({
        preference: fidelity,
        source: { width: 6000, height: 4000 },
        capability: unknownCap,
        runtime: noopfsRuntime,
      })
      expect(plan.preferredRows).toBe(512)
      expect(plan.concurrency).toBe(1)
    }
  })

  it('plans derived 100MP rows for a safe export on sampled facts', async () => {
    const plan = await planExportWithSampledFacts({
      preference: 'safe',
      source: { width: 11662, height: 8746 },
    })

    expect(plan.preferredRows).toBe(256)
    expect(plan.concurrency).toBe(1)
    expect(plan.checkpointMode).toBe('safe-retry')
  })

  it('does not report a streaming output sink from ambient Web Streams alone', async () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Chrome/126 Safari/537.36',
      maxTouchPoints: 0,
      storage: {},
      hardwareConcurrency: 8,
    })
    vi.stubGlobal('WritableStream', class WritableStream {})
    vi.stubGlobal('ReadableStream', class ReadableStream {})
    vi.stubGlobal('crossOriginIsolated', true)

    const plan = await planExportWithSampledFacts({
      preference: 'max',
      source: { width: 11662, height: 8746 },
    })

    expect(plan.runtimeMemoryProfile).toBe('desktop')
    expect(plan.derivedLabel).toContain('wkchromium')
    expect(plan.outputSink).toBe('blob-handoff')
  })

  it('samples ExportRuntimeResources at plan time, not boot time', async () => {
    const estimate = vi
      .fn()
      .mockResolvedValueOnce({ quota: 1_000_000_000, usage: 0 })
      .mockResolvedValueOnce({ quota: 100_000_000, usage: 0 })
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Chrome/126 Safari/537.36',
      maxTouchPoints: 0,
      hardwareConcurrency: 8,
      storage: {
        getDirectory: vi.fn(),
        estimate,
      },
    })
    vi.stubGlobal('SharedArrayBuffer', class SharedArrayBuffer {})
    vi.stubGlobal('crossOriginIsolated', true)

    const first = await planExportWithSampledFacts({
      preference: 'balanced',
      source: { width: 6000, height: 4000 },
    })
    const second = await planExportWithSampledFacts({
      preference: 'balanced',
      source: { width: 6000, height: 4000 },
    })

    expect(first.outputSink).toBe('opfs-file')
    expect(second.outputSink).toBe('blob-handoff')
    expect(estimate).toHaveBeenCalledTimes(2)
  })

  it('samples real storage again for a fresh-worker retry', async () => {
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
      storage: {
        getDirectory: vi.fn(),
        estimate,
      },
    })
    vi.stubGlobal('SharedArrayBuffer', class SharedArrayBuffer {})
    const output = createBlobOutputResult({
      filename: 'frame_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })
    const graph: ExportColorGraphDescriptor = {
      supported: true,
      outputGamut: 'srgb-rec709',
      outputTransfer: 'srgb',
      lutProfile: null,
      steps: [{ kind: 'input-linear-prophoto' }, { kind: 'output-srgb' }],
    }
    const executionPlan = await planExportWithSampledFacts({
      preference: 'balanced',
      source: { width: 6000, height: 4000 },
    })
    expect(executionPlan.outputSink).toBe('opfs-file')
    const first = {
      run: vi
        .fn()
        .mockRejectedValue(new Error('FULL_RES_EXPORT_RESOURCE_FAILURE')),
      dispose: vi.fn(),
    }
    const second = {
      run: vi.fn().mockResolvedValue(output),
      dispose: vi.fn(),
    }
    const clientFactory = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)

    await runFullResolutionExportJob({
      file: new File(['raw'], 'frame.ARW'),
      filename: 'frame_neutral_fullres.jpg',
      graph,
      executionPlan,
      outputLocation: {
        sink: 'opfs-file',
        tabDirectory: 'tab-1',
        exportId: 'export-1',
      },
      clientFactory: clientFactory as never,
    })

    expect(estimate).toHaveBeenCalledTimes(2)
    expect(second.run).toHaveBeenCalledWith(
      expect.objectContaining({
        executionPlan: expect.objectContaining({ outputSink: 'blob-handoff' }),
        outputLocation: undefined,
      }),
    )
  })

  it('runs the full-resolution export client and disposes it', async () => {
    const file = new File(['raw'], 'frame.ARW')
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' })
    const output = createBlobOutputResult({
      filename: 'frame_neutral_fullres.jpg',
      blob,
    })
    const run = vi.fn().mockResolvedValue(output)
    const dispose = vi.fn()
    const controller = new AbortController()
    const graph: ExportColorGraphDescriptor = {
      supported: true,
      outputGamut: 'srgb-rec709',
      outputTransfer: 'srgb',
      lutProfile: null,
      steps: [
        { kind: 'input-linear-prophoto' },
        { kind: 'raw-render-exposure', ev: 0, multiplier: 1 },
        { kind: 'output-srgb' },
      ],
    }

    const result = await runFullResolutionExportJob({
      file,
      filename: 'frame_neutral_fullres.jpg',
      graph,
      quality: 0.92,
      preferredRows: 1024,
      concurrency: 3,
      signal: controller.signal,
      clientFactory: () =>
        ({
          run,
          dispose,
        }) as never,
    })

    expect(run).toHaveBeenCalledTimes(1)
    const exportRequest = run.mock.calls[0]![0]

    expect(exportRequest.graph.steps).toContainEqual({
      kind: 'raw-render-exposure',
      ev: 0,
      multiplier: 1,
    })
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        file,
        filename: 'frame_neutral_fullres.jpg',
        graph,
        onProgress: undefined,
        preferredRows: 1024,
        concurrency: 3,
        quality: 0.92,
        signal: controller.signal,
      }),
    )
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      filename: 'frame_neutral_fullres.jpg',
      output,
      attempts: 1,
    })
  })

  it('runs the pre-export hook before starting the export client', async () => {
    const order: string[] = []
    const file = new File(['raw'], 'frame.ARW')
    const output = createBlobOutputResult({
      filename: 'frame_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })
    const run = vi.fn(async () => {
      order.push('export')
      return output
    })
    const dispose = vi.fn()
    const graph: ExportColorGraphDescriptor = {
      supported: true,
      outputGamut: 'srgb-rec709',
      outputTransfer: 'srgb',
      lutProfile: null,
      steps: [{ kind: 'input-linear-prophoto' }, { kind: 'output-srgb' }],
    }

    await runFullResolutionExportJob({
      file,
      filename: 'frame_neutral_fullres.jpg',
      graph,
      beforeStart: async () => {
        order.push('decode-terminate')
      },
      clientFactory: () =>
        ({
          run,
          dispose,
        }) as never,
    })

    expect(order).toEqual(['decode-terminate', 'export'])
  })

  it('passes execution plan to the worker client and returns attempt count', async () => {
    const file = new File(['raw'], 'frame.ARW')
    const output = createBlobOutputResult({
      filename: 'frame_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })
    const run = vi.fn().mockResolvedValue(output)
    const dispose = vi.fn()
    const graph: ExportColorGraphDescriptor = {
      supported: true,
      outputGamut: 'srgb-rec709',
      outputTransfer: 'srgb',
      lutProfile: null,
      steps: [{ kind: 'input-linear-prophoto' }, { kind: 'output-srgb' }],
    }
    const executionPlan = await planExportWithSampledFacts({
      preference: 'safe',
      source: { width: 11662, height: 8746 },
    })

    const result = await runFullResolutionExportJob({
      file,
      filename: 'frame_neutral_fullres.jpg',
      graph,
      executionPlan,
      clientFactory: () =>
        ({
          run,
          dispose,
        }) as never,
    })

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        executionPlan: {
          profileName: executionPlan.profile.name,
          preferredRows: executionPlan.preferredRows,
          concurrency: executionPlan.concurrency,
          runtimeMemoryProfile: executionPlan.runtimeMemoryProfile,
          outputSink: executionPlan.outputSink,
          checkpointMode: executionPlan.checkpointMode,
        },
      }),
    )
    expect(result).toEqual({
      filename: 'frame_neutral_fullres.jpg',
      output,
      attempts: 1,
    })
  })

  it('passes worker metrics through the job wrapper without a checkpoint identity', async () => {
    const file = new File(['raw'], 'frame.ARW')
    const output = createBlobOutputResult({
      filename: 'frame_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })
    const summaryMetric = {
      kind: 'summary' as const,
      requestId: 'request-1',
      width: 4,
      height: 4,
      megapixels: 0,
      timestamp: '2026-05-01T00:00:00.000Z',
      stripRows: 4,
      retries: 0,
      concurrency: 1,
      totalMs: 12,
      outputBytes: 128,
    }
    const run = vi.fn(async (request) => {
      request.onMetric?.(summaryMetric)
      return output
    })
    const dispose = vi.fn()
    const onMetric = vi.fn()
    const graph: ExportColorGraphDescriptor = {
      supported: true,
      outputGamut: 'srgb-rec709',
      outputTransfer: 'srgb',
      lutProfile: null,
      steps: [{ kind: 'input-linear-prophoto' }, { kind: 'output-srgb' }],
    }
    const executionPlan = await planExportWithSampledFacts({
      preference: 'safe',
      source: { width: 11662, height: 8746 },
    })

    await runFullResolutionExportJob({
      file,
      filename: 'frame_neutral_fullres.jpg',
      graph,
      executionPlan,
      onMetric,
      clientFactory: () =>
        ({
          run,
          dispose,
        }) as never,
    })

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ onMetric }))
    expect(run.mock.calls[0]![0]).not.toHaveProperty('checkpoint')
    expect(onMetric).toHaveBeenCalledWith(summaryMetric)
  })

  it('retries fresh workers for resource failures and disposes each client once', async () => {
    const file = new File(['raw'], 'frame.ARW')
    const output = createBlobOutputResult({
      filename: 'frame_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })
    const graph: ExportColorGraphDescriptor = {
      supported: true,
      outputGamut: 'srgb-rec709',
      outputTransfer: 'srgb',
      lutProfile: null,
      steps: [{ kind: 'input-linear-prophoto' }, { kind: 'output-srgb' }],
    }
    const executionPlan = await planExportWithSampledFacts({
      preference: 'safe',
      source: { width: 11662, height: 8746 },
    })
    const first = {
      run: vi
        .fn()
        .mockRejectedValue(new Error('FULL_RES_EXPORT_RESOURCE_FAILURE')),
      dispose: vi.fn(),
    }
    const second = {
      run: vi.fn().mockResolvedValue(output),
      dispose: vi.fn(),
    }
    const clientFactory = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)

    const result = await runFullResolutionExportJob({
      file,
      filename: 'frame_neutral_fullres.jpg',
      graph,
      executionPlan,
      clientFactory: clientFactory as never,
    })

    expect(clientFactory).toHaveBeenCalledTimes(2)
    expect(first.dispose).toHaveBeenCalledTimes(1)
    expect(second.dispose).toHaveBeenCalledTimes(1)
    expect(second.run).toHaveBeenCalledWith(
      expect.objectContaining({
        preferredRows: Math.max(
          executionPlan.profile.minRows,
          Math.floor(executionPlan.preferredRows / 2),
        ),
        concurrency: 1,
      }),
    )
    expect(result).toEqual({
      filename: 'frame_neutral_fullres.jpg',
      output,
      attempts: 2,
    })
  })

  it('uses worker-provided nextRows when retrying a fresh worker', async () => {
    const file = new File(['raw'], 'frame.ARW')
    const output = createBlobOutputResult({
      filename: 'frame_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })
    const graph: ExportColorGraphDescriptor = {
      supported: true,
      outputGamut: 'srgb-rec709',
      outputTransfer: 'srgb',
      lutProfile: null,
      steps: [{ kind: 'input-linear-prophoto' }, { kind: 'output-srgb' }],
    }
    const executionPlan = await planExportWithSampledFacts({
      preference: 'max',
      source: { width: 11662, height: 8746 },
      history: { previousResourceFailure: true },
    })
    const first = {
      run: vi.fn().mockRejectedValue(
        Object.assign(new Error('FULL_RES_EXPORT_RESOURCE_FAILURE'), {
          nextRows: 96,
        }),
      ),
      dispose: vi.fn(),
    }
    const second = {
      run: vi.fn().mockResolvedValue(output),
      dispose: vi.fn(),
    }
    const clientFactory = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)

    await runFullResolutionExportJob({
      file,
      filename: 'frame_neutral_fullres.jpg',
      graph,
      executionPlan,
      clientFactory: clientFactory as never,
    })

    expect(executionPlan.preferredRows).toBe(128)
    expect(second.run).toHaveBeenCalledWith(
      expect.objectContaining({
        preferredRows: 96,
        concurrency: 1,
      }),
    )
  })

  it('reports fresh worker attempt lifecycle during resource retry', async () => {
    const file = new File(['raw'], 'frame.ARW')
    const output = createBlobOutputResult({
      filename: 'frame_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })
    const graph: ExportColorGraphDescriptor = {
      supported: true,
      outputGamut: 'srgb-rec709',
      outputTransfer: 'srgb',
      lutProfile: null,
      steps: [{ kind: 'input-linear-prophoto' }, { kind: 'output-srgb' }],
    }
    const executionPlan = await planExportWithSampledFacts({
      preference: 'safe',
      source: { width: 11662, height: 8746 },
    })
    const first = {
      run: vi.fn().mockRejectedValue(
        Object.assign(new Error('FULL_RES_EXPORT_RESOURCE_FAILURE'), {
          nextRows: 64,
        }),
      ),
      dispose: vi.fn(),
    }
    const second = {
      run: vi.fn().mockResolvedValue(output),
      dispose: vi.fn(),
    }
    const clientFactory = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
    const onAttempt = vi.fn()

    const result = await runFullResolutionExportJob({
      file,
      filename: 'frame_neutral_fullres.jpg',
      graph,
      executionPlan,
      onAttempt,
      clientFactory: clientFactory as never,
    })

    expect(onAttempt).toHaveBeenNthCalledWith(1, {
      attempt: 1,
      profile: executionPlan.profile.name,
      preferredRows: executionPlan.preferredRows,
      concurrency: executionPlan.concurrency,
      phase: 'started',
      freshWorker: true,
    })
    expect(onAttempt).toHaveBeenNthCalledWith(2, {
      attempt: 1,
      profile: executionPlan.profile.name,
      preferredRows: executionPlan.preferredRows,
      concurrency: executionPlan.concurrency,
      phase: 'retry-scheduled',
      retryReason: 'FULL_RES_EXPORT_RESOURCE_FAILURE',
      previousRows: executionPlan.preferredRows,
      nextRows: 64,
      previousConcurrency: executionPlan.concurrency,
      nextConcurrency: 1,
      freshWorker: true,
      priorClientDisposed: false,
    })
    expect(onAttempt).toHaveBeenNthCalledWith(3, {
      attempt: 1,
      profile: executionPlan.profile.name,
      preferredRows: executionPlan.preferredRows,
      concurrency: executionPlan.concurrency,
      phase: 'disposed',
      freshWorker: false,
      priorClientDisposed: true,
    })
    expect(onAttempt).toHaveBeenNthCalledWith(4, {
      attempt: 2,
      profile: executionPlan.profile.name,
      preferredRows: 64,
      concurrency: 1,
      phase: 'started',
      freshWorker: true,
    })
    expect(first.dispose).toHaveBeenCalledTimes(1)
    expect(second.dispose).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      filename: 'frame_neutral_fullres.jpg',
      output,
      attempts: 2,
    })
  })

  it('ignores attempt diagnostics failures during successful export and disposes client', async () => {
    const file = new File(['raw'], 'frame.ARW')
    const output = createBlobOutputResult({
      filename: 'frame_neutral_fullres.jpg',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })
    const run = vi.fn().mockResolvedValue(output)
    const dispose = vi.fn()
    const graph: ExportColorGraphDescriptor = {
      supported: true,
      outputGamut: 'srgb-rec709',
      outputTransfer: 'srgb',
      lutProfile: null,
      steps: [{ kind: 'input-linear-prophoto' }, { kind: 'output-srgb' }],
    }
    const onAttempt = vi.fn(() => {
      throw new Error('DIAGNOSTICS_FAILED')
    })

    const result = await runFullResolutionExportJob({
      file,
      filename: 'frame_neutral_fullres.jpg',
      graph,
      onAttempt,
      clientFactory: () =>
        ({
          run,
          dispose,
        }) as never,
    })

    expect(result).toEqual({
      filename: 'frame_neutral_fullres.jpg',
      output,
      attempts: 1,
    })
    expect(run).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('preserves original non-retry export error when attempt diagnostics fail and disposes client', async () => {
    const file = new File(['raw'], 'frame.ARW')
    const exportError = new Error('FULL_RES_EXPORT_FATAL_FAILURE')
    const run = vi.fn().mockRejectedValue(exportError)
    const dispose = vi.fn()
    const graph: ExportColorGraphDescriptor = {
      supported: true,
      outputGamut: 'srgb-rec709',
      outputTransfer: 'srgb',
      lutProfile: null,
      steps: [{ kind: 'input-linear-prophoto' }, { kind: 'output-srgb' }],
    }
    const onAttempt = vi.fn(() => {
      throw new Error('DIAGNOSTICS_FAILED')
    })

    await expect(
      runFullResolutionExportJob({
        file,
        filename: 'frame_neutral_fullres.jpg',
        graph,
        onAttempt,
        clientFactory: () =>
          ({
            run,
            dispose,
          }) as never,
      }),
    ).rejects.toBe(exportError)

    expect(run).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
  })
  describe('retry facts', () => {
    const graph: ExportColorGraphDescriptor = {
      supported: true,
      outputGamut: 'srgb-rec709',
      outputTransfer: 'srgb',
      lutProfile: null,
      steps: [{ kind: 'input-linear-prophoto' }, { kind: 'output-srgb' }],
    }
    const capability = Object.freeze({
      coi: true,
      pthread: true,
      deviceMemoryGB: 16,
      hwConcurrency: 8,
      webKitClass: 'chromium' as const,
      deviceFormFactor: 'desktop' as const,
      maybeOpfsSupported: true,
    })
    const noOpfsFacts = {
      capability,
      runtime: {
        opfsSinkAvailable: false,
        opfsAvailableMB: null,
        streamingSinkAvailable: false,
      },
    }
    const roomyOpfsFacts = {
      capability,
      runtime: {
        opfsSinkAvailable: true,
        opfsAvailableMB: 100_000,
        streamingSinkAvailable: false,
      },
    }

    it('keeps a retry on blob handoff when the job reserved no OPFS location', async () => {
      const executionPlan = selectExportPlan({
        preference: 'balanced',
        source: { width: 6000, height: 4000 },
        ...noOpfsFacts,
      })
      expect(executionPlan.outputSink).toBe('blob-handoff')
      // The storage recovers by the retry; the job still has no OPFS address.
      expect(
        selectExportPlan({
          preference: 'safe',
          source: { width: 6000, height: 4000 },
          history: { previousResourceFailure: true },
          ...roomyOpfsFacts,
        }).outputSink,
      ).toBe('opfs-file')
      const output = createBlobOutputResult({
        filename: 'frame_neutral_fullres.jpg',
        blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
      })
      const first = {
        run: vi
          .fn()
          .mockRejectedValue(new Error('FULL_RES_EXPORT_RESOURCE_FAILURE')),
        dispose: vi.fn(),
      }
      const second = {
        run: vi.fn().mockResolvedValue(output),
        dispose: vi.fn(),
      }
      const clientFactory = vi
        .fn()
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second)

      const result = await runFullResolutionExportJob({
        file: new File(['raw'], 'frame.ARW'),
        filename: 'frame_neutral_fullres.jpg',
        graph,
        executionPlan,
        sampleFacts: async () => roomyOpfsFacts,
        clientFactory: clientFactory as never,
      })

      expect(result.attempts).toBe(2)
      expect(second.run).toHaveBeenCalledWith(
        expect.objectContaining({
          executionPlan: expect.objectContaining({
            outputSink: 'blob-handoff',
          }),
          outputLocation: undefined,
        }),
      )
    })

    it('starts no further attempt when the job is aborted while retry facts are sampled', async () => {
      const executionPlan = selectExportPlan({
        preference: 'balanced',
        source: { width: 6000, height: 4000 },
        ...noOpfsFacts,
      })
      const controller = new AbortController()
      let resolveFacts!: (facts: typeof noOpfsFacts) => void
      let samplingStarted!: () => void
      const sampling = new Promise<void>((resolve) => {
        samplingStarted = resolve
      })
      const sampleFacts = vi.fn(
        () =>
          new Promise<typeof noOpfsFacts>((resolve) => {
            resolveFacts = resolve
            samplingStarted()
          }),
      )
      const first = {
        run: vi
          .fn()
          .mockRejectedValue(new Error('FULL_RES_EXPORT_RESOURCE_FAILURE')),
        dispose: vi.fn(),
      }
      const clientFactory = vi.fn().mockReturnValue(first)
      const beforeStart = vi.fn()
      const onPlan = vi.fn()
      const onAttempt = vi.fn()

      const job = runFullResolutionExportJob({
        file: new File(['raw'], 'frame.ARW'),
        filename: 'frame_neutral_fullres.jpg',
        graph,
        executionPlan,
        signal: controller.signal,
        beforeStart,
        onPlan,
        onAttempt,
        sampleFacts,
        clientFactory: clientFactory as never,
      })
      await sampling
      controller.abort()
      resolveFacts(noOpfsFacts)

      await expect(job).rejects.toMatchObject({ name: 'AbortError' })
      expect(beforeStart).toHaveBeenCalledTimes(1)
      expect(clientFactory).toHaveBeenCalledTimes(1)
      expect(onPlan).not.toHaveBeenCalled()
      expect(onAttempt).not.toHaveBeenCalledWith(
        expect.objectContaining({ phase: 'retry-scheduled' }),
      )
    })
  })
})
