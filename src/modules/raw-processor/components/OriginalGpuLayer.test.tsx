import { act, render, waitFor } from '@testing-library/react'

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

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
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
      imageVersion: 1,
      createPipeline,
      onReady,
      onError,
    }
    const { rerender } = render(<OriginalGpuLayer {...props} />)
    await waitFor(() => expect(pipeline.waitForGpu).toHaveBeenCalledOnce())
    expect(onReady).not.toHaveBeenCalled()

    rerender(<OriginalGpuLayer {...props} imageVersion={2} />)
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
          imageVersion={1}
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
        imageVersion={1}
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
        imageVersion={1}
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
        imageVersion={1}
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
        imageVersion={2}
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
        imageVersion={1}
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
        imageVersion={1}
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

  it('reports pipeline creation failures without leaking an async rejection', async () => {
    const onError = vi.fn()

    render(
      <OriginalGpuLayer
        imageRef={{ current: decodedImage }}
        imageVersion={1}
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
        imageVersion={1}
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
})
