import { NEUTRAL_USER_COLOR_INTENT } from '@lumaforge/luma-color-runtime'
import { act, render, waitFor } from '@testing-library/react'

import type { DecodedPreviewFrame } from '~/lib/preview/preview-frame'
import type { DecodedImage } from '~/lib/raw/decoder'

import { createTestDecodedImage } from '../test-support/builders'
import { OriginalGpuLayer } from './OriginalGpuLayer'

const decodedImage = createTestDecodedImage()

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
    expect(dispose).toHaveBeenCalledOnce()
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
        output: 'technical-original',
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
      output: 'technical-original',
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
    expect(dispose).toHaveBeenCalled()
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
      expect(pipeline.dispose).toHaveBeenCalledOnce()
      expect(onPipelineChange).toHaveBeenLastCalledWith(null)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
