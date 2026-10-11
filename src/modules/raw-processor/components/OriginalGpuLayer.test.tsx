import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { act, render, waitFor } from '@testing-library/react'

import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'
import type { DecodedImage } from '~/lib/raw/decoder'

import { OriginalGpuLayer } from './OriginalGpuLayer'

const decodedImage: DecodedImage = {
  width: 400,
  height: 300,
  channels: 3,
  bitsPerChannel: 16,
  data: new Uint16Array(400 * 300 * 3),
  layout: 'rgb-u16',
  colorSpace: 'linear-prophoto-rgb',
  source: 'quick',
  metadata: {
    width: 400,
    height: 300,
  },
  renderExposure: { ev: 0, multiplier: 1, source: 'identity' },
}

/** The accepted descriptor tests pair with an image version. */
function testFrame(imageVersion: number): DecodedPreviewFrame {
  return {
    sessionId: 'session-1',
    frameId: `decoded-frame-${imageVersion}`,
    stage: 'quick',
    width: decodedImage.width,
    height: decodedImage.height,
    exposure: { kind: 'unpinned', value: decodedImage.renderExposure },
    quickPredecessorFrameId: null,
  }
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function createPipelineMock(
  overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {},
) {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    uploadImage: vi.fn(),
    setParams: vi.fn(),
    render: vi.fn(),
    waitForGpu: vi.fn().mockResolvedValue(undefined),
    resize: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  }
}

function captureResizeObservers() {
  const callbacks: ResizeObserverCallback[] = []
  vi.stubGlobal(
    'ResizeObserver',
    vi.fn().mockImplementation((callback: ResizeObserverCallback) => ({
      observe: vi.fn(() => {
        callbacks.push(callback)
      }),
      disconnect: vi.fn(),
    })),
  )
  return callbacks
}

function fireResize(
  callback: ResizeObserverCallback | undefined,
  width: number,
  height: number,
) {
  callback?.(
    [{ contentRect: { width, height } } as ResizeObserverEntry],
    {} as ResizeObserver,
  )
}

/** Sets the device pixel ratio the backing store reads until restored. */
function stubDevicePixelRatio(value: number) {
  const original = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')
  Object.defineProperty(window, 'devicePixelRatio', {
    configurable: true,
    value,
  })
  return () => {
    if (original) {
      Object.defineProperty(window, 'devicePixelRatio', original)
    } else {
      Reflect.deleteProperty(window, 'devicePixelRatio')
    }
  }
}

describe('originalGpuLayer', () => {
  it('reports only the latest generation after its GPU work completes', async () => {
    const firstFrame = deferred()
    const secondFrame = deferred()
    const onReady = vi.fn()
    const onError = vi.fn()
    const pipeline = {
      initialize: vi.fn().mockResolvedValue(undefined),
      uploadImage: vi.fn(),
      setParams: vi.fn(),
      render: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
      waitForGpu: vi
        .fn()
        .mockReturnValueOnce(firstFrame.promise)
        .mockReturnValueOnce(secondFrame.promise),
    }
    const createPipeline = () => pipeline as never
    const props = {
      imageRef: { current: decodedImage },
      decodedFrame: testFrame(1),
      generationKey: '1',
      createPipeline,
      onReady,
      onError,
    }
    const { rerender } = render(<OriginalGpuLayer {...props} />)
    await waitFor(() => expect(pipeline.waitForGpu).toHaveBeenCalledOnce())
    expect(onReady).not.toHaveBeenCalled()

    rerender(
      <OriginalGpuLayer
        {...props}
        decodedFrame={testFrame(2)}
        generationKey="2"
      />,
    )
    await waitFor(() => expect(pipeline.waitForGpu).toHaveBeenCalledTimes(2))
    await act(async () => firstFrame.reject(new Error('stale GPU failure')))
    expect(onReady).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(pipeline.dispose).not.toHaveBeenCalled()

    await act(async () => secondFrame.resolve())
    expect(onReady).toHaveBeenCalledExactlyOnceWith('2')
    expect(pipeline.render).toHaveBeenCalled()
  })

  it.each(['unmount', 'evacuate'] as const)(
    'ignores GPU completion after %s',
    async (stop) => {
      const frame = deferred()
      const onReady = vi.fn()
      const onError = vi.fn()
      const onPipelineChange = vi.fn()
      const pipeline = {
        initialize: vi.fn().mockResolvedValue(undefined),
        uploadImage: vi.fn(),
        setParams: vi.fn(),
        render: vi.fn(),
        resize: vi.fn(),
        dispose: vi.fn(),
        waitForGpu: vi.fn(() => frame.promise),
      }
      const { unmount } = render(
        <OriginalGpuLayer
          imageRef={{ current: decodedImage }}
          decodedFrame={testFrame(1)}
          generationKey="1"
          createPipeline={() => pipeline as never}
          onReady={onReady}
          onError={onError}
          onPipelineChange={onPipelineChange}
        />,
      )
      await waitFor(() => expect(pipeline.waitForGpu).toHaveBeenCalledOnce())
      if (stop === 'unmount') unmount()
      else act(() => onPipelineChange.mock.calls.at(-1)![0].dispose())
      await act(async () => frame.resolve())

      expect(pipeline.dispose).toHaveBeenCalledOnce()
      expect(onReady).not.toHaveBeenCalled()
      expect(onError).not.toHaveBeenCalled()
    },
  )

  it('reports a current GPU completion failure and disposes its pipeline', async () => {
    const frame = deferred()
    const onReady = vi.fn()
    const onError = vi.fn()
    const dispose = vi.fn()
    const waitForGpu = vi.fn(() => frame.promise)
    render(
      <OriginalGpuLayer
        imageRef={{ current: decodedImage }}
        decodedFrame={testFrame(1)}
        generationKey="1"
        createPipeline={() =>
          ({
            initialize: vi.fn().mockResolvedValue(undefined),
            uploadImage: vi.fn(),
            setParams: vi.fn(),
            render: vi.fn(),
            resize: vi.fn(),
            dispose,
            waitForGpu,
          }) as never
        }
        onReady={onReady}
        onError={onError}
      />,
    )
    await waitFor(() => expect(waitForGpu).toHaveBeenCalledOnce())
    const failure = new Error('GPU completion failed')
    await act(async () => frame.reject(failure))
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure, '1')
    expect(dispose).toHaveBeenCalledExactlyOnceWith({ releaseContext: true })
    expect(onReady).not.toHaveBeenCalled()
  })

  it('renders technical-base original params into a left GPU canvas', async () => {
    const setParams = vi.fn()
    const renderPipeline = vi.fn()

    render(
      <OriginalGpuLayer
        imageRef={{ current: decodedImage }}
        decodedFrame={testFrame(1)}
        generationKey="1"
        createPipeline={() =>
          ({
            initialize: vi.fn().mockResolvedValue(undefined),
            uploadImage: vi.fn(),
            setParams,
            render: renderPipeline,
            waitForGpu: vi.fn().mockResolvedValue(undefined),
            resize: vi.fn(),
            dispose: vi.fn(),
          }) as never
        }
      />,
    )

    await waitFor(() => expect(renderPipeline).toHaveBeenCalled())
    expect(setParams).toHaveBeenCalledWith(
      expect.objectContaining({
        viewMode: 'original',
        styleKind: 'none',
        intensity: 0,
      }),
    )
  })

  it('draws the technical original: neutral user color, the RAW render exposure kept', async () => {
    const uploadImage = vi.fn()
    const setParams = vi.fn()
    const onReady = vi.fn()
    const image = {
      ...decodedImage,
      renderExposure: {
        ev: 1.25,
        multiplier: 2 ** 1.25,
        source: 'image-statistics',
      },
    } as DecodedImage

    render(
      <OriginalGpuLayer
        imageRef={{ current: image }}
        decodedFrame={testFrame(1)}
        generationKey="1"
        onReady={onReady}
        createPipeline={() =>
          ({
            initialize: vi.fn().mockResolvedValue(undefined),
            uploadImage,
            setParams,
            render: vi.fn(),
            waitForGpu: vi.fn().mockResolvedValue(undefined),
            resize: vi.fn(),
            dispose: vi.fn(),
          }) as never
        }
      />,
    )

    await waitFor(() => expect(onReady).toHaveBeenCalledWith('1'))
    expect(uploadImage).toHaveBeenCalledWith(
      expect.objectContaining({
        renderExposureEv: 1.25,
        renderExposureMultiplier: 2 ** 1.25,
      }),
    )
    // Every user field is set neutral; none is left to the pipeline default.
    expect(setParams).toHaveBeenCalledExactlyOnceWith({
      viewMode: 'original',
      styleKind: 'none',
      builtinPreset: null,
      intensity: 0,
      ...NEUTRAL_USER_COLOR_INTENT,
    })
  })

  it('reports ready after rendering a replacement image version', async () => {
    const onReady = vi.fn()
    const renderPipeline = vi.fn()
    const createPipeline = () =>
      ({
        initialize: vi.fn().mockResolvedValue(undefined),
        uploadImage: vi.fn(),
        setParams: vi.fn(),
        render: renderPipeline,
        waitForGpu: vi.fn().mockResolvedValue(undefined),
        resize: vi.fn(),
        dispose: vi.fn(),
      }) as never

    const { rerender } = render(
      <OriginalGpuLayer
        imageRef={{ current: decodedImage }}
        decodedFrame={testFrame(1)}
        generationKey="1"
        createPipeline={createPipeline}
        onReady={onReady}
      />,
    )

    await waitFor(() => {
      expect(renderPipeline).toHaveBeenCalled()
      expect(onReady).toHaveBeenCalled()
    })
    onReady.mockClear()
    renderPipeline.mockClear()

    rerender(
      <OriginalGpuLayer
        imageRef={{ current: decodedImage }}
        decodedFrame={testFrame(2)}
        generationKey="2"
        createPipeline={createPipeline}
        onReady={onReady}
      />,
    )

    await waitFor(() => {
      expect(renderPipeline).toHaveBeenCalled()
      expect(onReady).toHaveBeenCalled()
    })
  })

  it('does not force GPU context loss on ordinary unmount', async () => {
    const dispose = vi.fn()
    const renderPipeline = vi.fn()
    const { unmount } = render(
      <OriginalGpuLayer
        imageRef={{ current: decodedImage }}
        decodedFrame={testFrame(1)}
        generationKey="1"
        createPipeline={() =>
          ({
            initialize: vi.fn().mockResolvedValue(undefined),
            uploadImage: vi.fn(),
            setParams: vi.fn(),
            render: renderPipeline,
            waitForGpu: vi.fn().mockResolvedValue(undefined),
            resize: vi.fn(),
            dispose,
          }) as never
        }
      />,
    )

    await waitFor(() => expect(renderPipeline).toHaveBeenCalled())

    unmount()

    expect(dispose).toHaveBeenCalledWith()
  })

  it('publishes an evacuation handle and clears it after disposal', async () => {
    const dispose = vi.fn()
    const onPipelineChange = vi.fn()

    render(
      <OriginalGpuLayer
        imageRef={{ current: decodedImage }}
        decodedFrame={testFrame(1)}
        generationKey="1"
        createPipeline={() =>
          ({
            initialize: vi.fn().mockResolvedValue(undefined),
            uploadImage: vi.fn(),
            setParams: vi.fn(),
            render: vi.fn(),
            waitForGpu: vi.fn().mockResolvedValue(undefined),
            resize: vi.fn(),
            dispose,
          }) as never
        }
        onPipelineChange={onPipelineChange}
      />,
    )

    await waitFor(() => {
      expect(onPipelineChange).toHaveBeenCalledWith(
        expect.objectContaining({ dispose: expect.any(Function) }),
      )
    })

    const handle = onPipelineChange.mock.calls.find(
      ([value]) => value && typeof value === 'object',
    )?.[0] as { dispose: () => void }

    act(() => {
      handle.dispose()
    })

    expect(dispose).toHaveBeenCalledWith({ releaseContext: true })
    expect(onPipelineChange).toHaveBeenLastCalledWith(null)
  })

  it('never publishes a pipeline whose layer unmounted while it initialized', async () => {
    const initialized = deferred()
    const pipeline = createPipelineMock({
      initialize: vi.fn(() => initialized.promise),
    })
    const onPipelineChange = vi.fn()
    const onReady = vi.fn()
    const onError = vi.fn()
    const { unmount } = render(
      <OriginalGpuLayer
        imageRef={{ current: decodedImage }}
        decodedFrame={testFrame(1)}
        generationKey="1"
        createPipeline={() => pipeline as never}
        onPipelineChange={onPipelineChange}
        onReady={onReady}
        onError={onError}
      />,
    )

    unmount()
    expect(pipeline.dispose).toHaveBeenCalledExactlyOnceWith()
    await act(async () => initialized.resolve())

    expect(onPipelineChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ dispose: expect.any(Function) }),
    )
    expect(pipeline.uploadImage).not.toHaveBeenCalled()
    expect(pipeline.dispose).toHaveBeenCalledOnce()
    expect(onReady).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('releases once however often its evacuation handle runs, and a stale handle spares the next layer', async () => {
    const first = createPipelineMock()
    const second = createPipelineMock()
    const onPipelineChange = vi.fn()
    const handles = () =>
      onPipelineChange.mock.calls
        .map(([value]) => value as { dispose: () => void } | null)
        .filter((value) => value !== null)
    const props = {
      imageRef: { current: decodedImage },
      decodedFrame: testFrame(1),
      generationKey: '1',
      onPipelineChange,
    }
    const { rerender, unmount } = render(
      <OriginalGpuLayer {...props} createPipeline={() => first as never} />,
    )
    await waitFor(() => expect(handles()).toHaveLength(1))
    const [firstHandle] = handles()

    act(() => firstHandle!.dispose())
    act(() => firstHandle!.dispose())
    expect(first.dispose).toHaveBeenCalledExactlyOnceWith({
      releaseContext: true,
    })
    const nulls = () =>
      onPipelineChange.mock.calls.filter(([value]) => value === null).length
    expect(nulls()).toBe(1)

    rerender(
      <OriginalGpuLayer {...props} createPipeline={() => second as never} />,
    )
    await waitFor(() => expect(handles()).toHaveLength(2))
    const nullsBefore = nulls()
    act(() => firstHandle!.dispose())
    expect(second.dispose).not.toHaveBeenCalled()
    expect(first.dispose).toHaveBeenCalledOnce()
    expect(nulls()).toBe(nullsBefore)

    unmount()
    expect(second.dispose).toHaveBeenCalledExactlyOnceWith()
    expect(first.dispose).toHaveBeenCalledOnce()
  })

  it('reports pipeline creation failures without leaking an async rejection', async () => {
    const onError = vi.fn()

    render(
      <OriginalGpuLayer
        imageRef={{ current: decodedImage }}
        decodedFrame={testFrame(1)}
        generationKey="1"
        createPipeline={() => {
          throw new Error('WebGPU is not supported on this device')
        }}
        onError={onError}
      />,
    )

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'WebGPU is not supported on this device',
        }),
        '1',
      )
    })
  })

  it('reports render failures and releases the original GPU context', async () => {
    const dispose = vi.fn()
    const onError = vi.fn()

    render(
      <OriginalGpuLayer
        imageRef={{ current: decodedImage }}
        decodedFrame={testFrame(1)}
        generationKey="1"
        createPipeline={() =>
          ({
            initialize: vi.fn().mockResolvedValue(undefined),
            uploadImage: vi.fn(() => {
              throw new Error('Original upload failed')
            }),
            setParams: vi.fn(),
            render: vi.fn(),
            waitForGpu: vi.fn().mockResolvedValue(undefined),
            resize: vi.fn(),
            dispose,
          }) as never
        }
        onError={onError}
      />,
    )

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Original upload failed' }),
        '1',
      )
    })
    expect(dispose).toHaveBeenCalledWith({ releaseContext: true })
  })
  it('draws no decoded pixels until an accepted frame names them', async () => {
    const pipeline = createPipelineMock()
    const onReady = vi.fn()
    const props = {
      imageRef: { current: decodedImage },
      createPipeline: () => pipeline as never,
      onReady,
    }
    const { rerender } = render(
      <OriginalGpuLayer {...props} decodedFrame={null} generationKey="none" />,
    )
    await waitFor(() => expect(pipeline.initialize).toHaveBeenCalledOnce())
    await act(async () => {
      await Promise.resolve()
    })
    expect(pipeline.uploadImage).not.toHaveBeenCalled()
    expect(pipeline.render).not.toHaveBeenCalled()
    expect(onReady).not.toHaveBeenCalled()

    rerender(
      <OriginalGpuLayer
        {...props}
        decodedFrame={testFrame(1)}
        generationKey="1"
      />,
    )
    await waitFor(() => expect(onReady).toHaveBeenCalledExactlyOnceWith('1'))
    expect(pipeline.uploadImage).toHaveBeenCalledOnce()
    expect(pipeline.render).toHaveBeenCalledOnce()
  })

  it('draws every accepted frame, even one its owner keyed the same', async () => {
    const pipeline = createPipelineMock()
    const imageRef = { current: decodedImage }
    const props = {
      imageRef,
      generationKey: 'frame',
      createPipeline: () => pipeline as never,
    }
    const { rerender } = render(
      <OriginalGpuLayer {...props} decodedFrame={testFrame(1)} />,
    )
    await waitFor(() => expect(pipeline.uploadImage).toHaveBeenCalledOnce())

    imageRef.current = { ...decodedImage, width: 420, height: 320 }
    rerender(
      <OriginalGpuLayer
        {...props}
        decodedFrame={{ ...testFrame(1), sessionId: 'session-2' }}
      />,
    )
    await waitFor(() => expect(pipeline.uploadImage).toHaveBeenCalledTimes(2))
    expect(pipeline.uploadImage).toHaveBeenLastCalledWith(
      expect.objectContaining({ width: 420, height: 320 }),
    )
  })

  it('does one upload, draw, and fence per generation, and none for callback-only changes', async () => {
    const pipeline = createPipelineMock()
    const createPipeline = () => pipeline as never
    const onReady = vi.fn()
    const props = {
      imageRef: { current: decodedImage },
      decodedFrame: testFrame(1),
      generationKey: '1:quick:dual:compare:active',
      createPipeline,
    }
    const { rerender } = render(
      <OriginalGpuLayer {...props} onReady={onReady} />,
    )
    await waitFor(() =>
      expect(onReady).toHaveBeenCalledExactlyOnceWith(
        '1:quick:dual:compare:active',
      ),
    )
    expect(pipeline.initialize).toHaveBeenCalledOnce()
    expect(pipeline.uploadImage).toHaveBeenCalledOnce()
    expect(pipeline.setParams).toHaveBeenCalledOnce()
    expect(pipeline.render).toHaveBeenCalledOnce()
    expect(pipeline.waitForGpu).toHaveBeenCalledOnce()

    // The parent passes fresh callbacks on every render; the technical
    // original carries no color, so they never redraw it.
    const nextOnReady = vi.fn()
    await act(async () => {
      rerender(
        <OriginalGpuLayer
          {...props}
          onReady={nextOnReady}
          onError={vi.fn()}
          onPipelineChange={vi.fn()}
        />,
      )
    })
    expect(pipeline.uploadImage).toHaveBeenCalledOnce()
    expect(pipeline.render).toHaveBeenCalledOnce()
    expect(nextOnReady).not.toHaveBeenCalled()

    // A new generation key redraws the same image version once.
    await act(async () => {
      rerender(
        <OriginalGpuLayer
          {...props}
          generationKey="1:bounded-hq:dual:compare:active"
          onReady={nextOnReady}
        />,
      )
    })
    expect(nextOnReady).toHaveBeenCalledExactlyOnceWith(
      '1:bounded-hq:dual:compare:active',
    )
    expect(pipeline.uploadImage).toHaveBeenCalledTimes(2)
    expect(pipeline.render).toHaveBeenCalledTimes(2)
    expect(pipeline.waitForGpu).toHaveBeenCalledTimes(2)
    expect(pipeline.initialize).toHaveBeenCalledOnce()
    expect(pipeline.dispose).not.toHaveBeenCalled()
  })

  it('draws only the latest image once a late initialization completes', async () => {
    const initialized = deferred()
    const pipeline = createPipelineMock({
      initialize: vi.fn(() => initialized.promise),
    })
    const onReady = vi.fn()
    const onPipelineChange = vi.fn()
    const imageRef = { current: decodedImage }
    const props = {
      imageRef,
      createPipeline: () => pipeline as never,
      onReady,
      onPipelineChange,
    }
    const { rerender } = render(
      <OriginalGpuLayer
        {...props}
        decodedFrame={testFrame(1)}
        generationKey="1"
      />,
    )
    imageRef.current = { ...decodedImage, width: 420, height: 320 }
    rerender(
      <OriginalGpuLayer
        {...props}
        decodedFrame={testFrame(2)}
        generationKey="2"
      />,
    )
    expect(pipeline.uploadImage).not.toHaveBeenCalled()
    expect(onPipelineChange).not.toHaveBeenCalled()

    await act(async () => initialized.resolve())

    await waitFor(() => expect(onReady).toHaveBeenCalledExactlyOnceWith('2'))
    expect(pipeline.uploadImage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ width: 420, height: 320 }),
    )
    expect(pipeline.render).toHaveBeenCalledOnce()
    expect(onPipelineChange).toHaveBeenCalledOnce()
  })

  it('reports an initialization failure against the generation current when it fails', async () => {
    const initialized = deferred()
    const pipeline = createPipelineMock({
      initialize: vi.fn(() => initialized.promise),
    })
    const onError = vi.fn()
    const onReady = vi.fn()
    const props = {
      imageRef: { current: decodedImage },
      decodedFrame: testFrame(1),
      generationKey: '1',
      createPipeline: () => pipeline as never,
      onError,
      onReady,
    }
    const { rerender } = render(
      <OriginalGpuLayer {...props} generationKey="1:quick" />,
    )
    rerender(<OriginalGpuLayer {...props} generationKey="1:bounded-hq" />)

    const failure = new Error('Original adapter lost')
    await act(async () => initialized.reject(failure))

    expect(onError).toHaveBeenCalledExactlyOnceWith(failure, '1:bounded-hq')
    expect(onReady).not.toHaveBeenCalled()
    expect(pipeline.uploadImage).not.toHaveBeenCalled()
    expect(pipeline.dispose).toHaveBeenCalledOnce()
  })

  it('reports readiness only inside its published pipeline lifetime and its release before a failure', async () => {
    const events: string[] = []
    const secondFrame = deferred()
    const pipeline = createPipelineMock({
      waitForGpu: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockReturnValueOnce(secondFrame.promise),
    })
    const props = {
      imageRef: { current: decodedImage },
      decodedFrame: testFrame(1),
      generationKey: '1',
      createPipeline: () => pipeline as never,
      onReady: (key: string) => events.push(`ready:${key}`),
      onError: (_: unknown, key: string) => events.push(`error:${key}`),
      onPipelineChange: (handle: unknown) =>
        events.push(handle ? 'publish' : 'release'),
    }
    const { rerender } = render(<OriginalGpuLayer {...props} />)
    await waitFor(() => expect(events).toEqual(['publish', 'ready:1']))

    rerender(
      <OriginalGpuLayer
        {...props}
        decodedFrame={testFrame(2)}
        generationKey="2"
      />,
    )
    await waitFor(() => expect(pipeline.waitForGpu).toHaveBeenCalledTimes(2))
    await act(async () => secondFrame.reject(new Error('Original lost')))

    // The owner forgets the drawn frame before it records the failure.
    expect(events).toEqual(['publish', 'ready:1', 'release', 'error:2'])
    expect(pipeline.dispose).toHaveBeenCalledExactlyOnceWith({
      releaseContext: true,
    })
  })

  it('reports the release of a pipeline that failed to initialize before the failure', async () => {
    const events: string[] = []
    const pipeline = createPipelineMock({
      initialize: vi.fn().mockRejectedValue(new Error('No adapter')),
    })
    render(
      <OriginalGpuLayer
        imageRef={{ current: decodedImage }}
        decodedFrame={testFrame(1)}
        generationKey="1"
        createPipeline={() => pipeline as never}
        onReady={(key) => events.push(`ready:${key}`)}
        onError={(_, key) => events.push(`error:${key}`)}
        onPipelineChange={(handle) =>
          events.push(handle ? 'publish' : 'release')
        }
      />,
    )

    await waitFor(() => expect(events).toEqual(['release', 'error:1']))
    expect(pipeline.dispose).toHaveBeenCalledOnce()
  })

  it('redraws a settled resize without a new upload or a second ready report', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn().mockImplementation((callback: ResizeObserverCallback) => ({
        observe: vi.fn(() => {
          resizeCallbacks.push(callback)
        }),
        disconnect: vi.fn(),
      })),
    )
    try {
      const pipeline = createPipelineMock()
      const onReady = vi.fn()
      render(
        <OriginalGpuLayer
          imageRef={{ current: decodedImage }}
          decodedFrame={testFrame(1)}
          generationKey="1"
          createPipeline={() => pipeline as never}
          onReady={onReady}
        />,
      )
      await waitFor(() => expect(onReady).toHaveBeenCalledOnce())
      const observer = resizeCallbacks.at(-1)!
      pipeline.render.mockClear()

      act(() => {
        observer(
          [
            {
              contentRect: { width: 200, height: 150 },
            } as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        )
      })

      expect(pipeline.resize).toHaveBeenLastCalledWith(
        200 * Math.min(window.devicePixelRatio || 1, 2),
        150 * Math.min(window.devicePixelRatio || 1, 2),
      )
      expect(pipeline.render).toHaveBeenCalledOnce()
      expect(pipeline.uploadImage).toHaveBeenCalledOnce()
      expect(pipeline.waitForGpu).toHaveBeenCalledOnce()
      expect(onReady).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports a resize redraw failure as its own failure and releases only its context', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn().mockImplementation((callback: ResizeObserverCallback) => ({
        observe: vi.fn(() => {
          resizeCallbacks.push(callback)
        }),
        disconnect: vi.fn(),
      })),
    )
    try {
      const pipeline = createPipelineMock()
      const onReady = vi.fn()
      const onError = vi.fn()
      const onPipelineChange = vi.fn()
      render(
        <OriginalGpuLayer
          imageRef={{ current: decodedImage }}
          decodedFrame={testFrame(1)}
          generationKey="1:quick:dual:compare:active"
          createPipeline={() => pipeline as never}
          onReady={onReady}
          onError={onError}
          onPipelineChange={onPipelineChange}
        />,
      )
      await waitFor(() => expect(onReady).toHaveBeenCalledOnce())
      const failure = new Error('Original device lost')
      pipeline.render.mockImplementation(() => {
        throw failure
      })

      act(() => {
        resizeCallbacks.at(-1)!(
          [
            {
              contentRect: { width: 200, height: 150 },
            } as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        )
      })

      expect(onError).toHaveBeenCalledExactlyOnceWith(
        failure,
        '1:quick:dual:compare:active',
      )
      expect(pipeline.dispose).toHaveBeenCalledExactlyOnceWith({
        releaseContext: true,
      })
      expect(onPipelineChange).toHaveBeenLastCalledWith(null)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  describe('backing store resize', () => {
    async function renderReadyLayer() {
      const resizeCallbacks = captureResizeObservers()
      const pipeline = createPipelineMock()
      const onReady = vi.fn()
      const result = render(
        <OriginalGpuLayer
          imageRef={{ current: decodedImage }}
          decodedFrame={testFrame(1)}
          generationKey="1"
          createPipeline={() => pipeline as never}
          onReady={onReady}
        />,
      )
      await waitFor(() => expect(onReady).toHaveBeenCalledOnce())
      const canvas = result.container.querySelector('canvas')!
      pipeline.resize.mockClear()
      pipeline.render.mockClear()
      return { ...result, resizeCallbacks, pipeline, canvas }
    }

    afterEach(() => {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    })

    it('sizes the layer box at the capped pixel ratio without fitting it to the photo again', async () => {
      const restoreDpr = stubDevicePixelRatio(3)
      try {
        const { resizeCallbacks, pipeline, canvas } = await renderReadyLayer()

        act(() => fireResize(resizeCallbacks.at(-1), 300, 600))

        expect([canvas.width, canvas.height]).toEqual([600, 1200])
        expect(pipeline.resize).toHaveBeenCalledExactlyOnceWith(600, 1200)
        expect(pipeline.render).toHaveBeenCalledOnce()
      } finally {
        restoreDpr()
      }
    })

    it('rounds a fractional box and keeps a zero-size box at one pixel', async () => {
      const restoreDpr = stubDevicePixelRatio(1.5)
      try {
        const { resizeCallbacks, pipeline, canvas } = await renderReadyLayer()
        vi.useFakeTimers()

        act(() => fireResize(resizeCallbacks.at(-1), 333, 249.75))
        expect([canvas.width, canvas.height]).toEqual([500, 375])

        act(() => fireResize(resizeCallbacks.at(-1), 0, 0))
        act(() => vi.advanceTimersByTime(90))

        expect([canvas.width, canvas.height]).toEqual([1, 1])
        expect(pipeline.resize).toHaveBeenLastCalledWith(1, 1)
      } finally {
        restoreDpr()
      }
    })

    it('reads a missing pixel ratio as one', async () => {
      const restoreDpr = stubDevicePixelRatio(0)
      try {
        const { resizeCallbacks, canvas } = await renderReadyLayer()

        act(() => fireResize(resizeCallbacks.at(-1), 200, 150))

        expect([canvas.width, canvas.height]).toEqual([200, 150])
      } finally {
        restoreDpr()
      }
    })

    it('fits the first size at once, then settles rapid resizes into one resize and draw', async () => {
      const { resizeCallbacks, pipeline, canvas } = await renderReadyLayer()
      const callback = resizeCallbacks.at(-1)
      vi.useFakeTimers()

      act(() => fireResize(callback, 400, 300))
      expect(pipeline.resize).toHaveBeenCalledExactlyOnceWith(400, 300)
      expect(pipeline.render).toHaveBeenCalledOnce()

      act(() => fireResize(callback, 800, 300))
      act(() => vi.advanceTimersByTime(50))
      act(() => fireResize(callback, 600, 600))
      act(() => vi.advanceTimersByTime(50))
      act(() => fireResize(callback, 1000, 450))
      act(() => vi.advanceTimersByTime(89))

      expect([canvas.width, canvas.height]).toEqual([400, 300])
      expect(pipeline.resize).toHaveBeenCalledOnce()

      act(() => vi.advanceTimersByTime(1))

      expect([canvas.width, canvas.height]).toEqual([1000, 450])
      expect(pipeline.resize).toHaveBeenCalledTimes(2)
      expect(pipeline.resize).toHaveBeenLastCalledWith(1000, 450)
      expect(pipeline.render).toHaveBeenCalledTimes(2)
      expect(pipeline.uploadImage).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('flushes a pending settled resize on unmount and leaves no timer', async () => {
      const { resizeCallbacks, pipeline, canvas, unmount } =
        await renderReadyLayer()
      const callback = resizeCallbacks.at(-1)
      vi.useFakeTimers()

      act(() => fireResize(callback, 400, 300))
      act(() => fireResize(callback, 200, 150))
      expect(vi.getTimerCount()).toBe(1)
      pipeline.resize.mockClear()
      pipeline.render.mockClear()

      unmount()

      expect([canvas.width, canvas.height]).toEqual([200, 150])
      expect(pipeline.resize).not.toHaveBeenCalled()
      expect(pipeline.render).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('flushes a size pending at initialization and refits at once afterwards', async () => {
      const resizeCallbacks = captureResizeObservers()
      const initialization = deferred()
      const pipeline = createPipelineMock({
        initialize: vi.fn(() => initialization.promise),
      })
      const onReady = vi.fn()
      const { container } = render(
        <OriginalGpuLayer
          imageRef={{ current: decodedImage }}
          decodedFrame={testFrame(1)}
          generationKey="1"
          createPipeline={() => pipeline as never}
          onReady={onReady}
        />,
      )
      const canvas = container.querySelector('canvas')!
      const firstCallback = resizeCallbacks.at(-1)

      act(() => fireResize(firstCallback, 400, 300))
      act(() => fireResize(firstCallback, 200, 150))
      expect([canvas.width, canvas.height]).toEqual([400, 300])
      expect(pipeline.resize).not.toHaveBeenCalled()

      await act(async () => {
        initialization.resolve()
        await initialization.promise
      })
      await waitFor(() => expect(onReady).toHaveBeenCalledOnce())

      expect([canvas.width, canvas.height]).toEqual([200, 150])
      expect(pipeline.resize).toHaveBeenCalledExactlyOnceWith(200, 150)
      expect(pipeline.render).toHaveBeenCalledOnce()
      const nextCallback = resizeCallbacks.at(-1)
      expect(nextCallback).not.toBe(firstCallback)

      act(() => fireResize(nextCallback, 300, 300))

      expect([canvas.width, canvas.height]).toEqual([300, 300])
      expect(pipeline.resize).toHaveBeenLastCalledWith(300, 300)
      expect(pipeline.render).toHaveBeenCalledTimes(2)
    })
  })
})
