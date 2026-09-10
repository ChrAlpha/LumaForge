import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/lib/webgpu/shaders', () => ({
  VERTEX_SHADER: 'vertex',
  PREVIEW_OUTPUT_SHADER: 'output',
  createProcessShader: (integerInput: boolean, filterable: boolean) =>
    `process:${integerInput}:${filterable}`,
}))

function createDevice(filterable = false) {
  const messages = new Map<string, GPUCompilationMessage[]>()
  const device = {
    features: new Set(filterable ? ['float32-filterable'] : []),
    createShaderModule: vi.fn(({ code, label }) => ({
      label,
      getCompilationInfo: vi.fn(async () => ({
        messages: messages.get(code) ?? [],
      })),
    })),
    createBindGroupLayout: vi.fn((descriptor) => descriptor),
    createPipelineLayout: vi.fn((descriptor) => descriptor),
    createRenderPipelineAsync: vi.fn(async (descriptor) => descriptor),
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(),
  }
  return { device: device as unknown as GPUDevice, mocks: device, messages }
}

function compilationMessage(type: GPUCompilationMessageType) {
  return {
    type,
    message: 'unexpected token',
    lineNum: 3,
    linePos: 8,
  } as GPUCompilationMessage
}

let getPrograms: typeof import('./programs').getWebGPUPrograms

beforeEach(async () => {
  vi.resetModules()
  vi.stubGlobal('GPUShaderStage', { FRAGMENT: 2 })
  getPrograms = (await import('./programs')).getWebGPUPrograms
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('cached WebGPU programs', () => {
  it('deduplicates concurrent compilation for one device and canvas format', async () => {
    const { device, mocks } = createDevice()
    const first = getPrograms(device, 'bgra8unorm')
    const second = getPrograms(device, 'bgra8unorm')
    expect(first).toBe(second)
    const [programs, same] = await Promise.all([first, second])
    expect(programs).toBe(same)
    expect(await getPrograms(device, 'bgra8unorm')).toBe(programs)
    expect(mocks.createShaderModule).toHaveBeenCalledTimes(4)
    expect(mocks.createRenderPipelineAsync).toHaveBeenCalledTimes(4)
    expect(mocks.pushErrorScope).not.toHaveBeenCalled()
    expect(mocks.popErrorScope).not.toHaveBeenCalled()
  })

  it('uses independent caches for devices and output formats', async () => {
    const first = createDevice()
    const second = createDevice()
    const programs = await getPrograms(first.device, 'bgra8unorm')
    const alternate = await getPrograms(first.device, 'rgba16float')
    const otherDevice = await getPrograms(second.device, 'bgra8unorm')
    expect(alternate).not.toBe(programs)
    expect(otherDevice).not.toBe(programs)
    expect(first.mocks.createRenderPipelineAsync).toHaveBeenCalledTimes(8)
    expect(second.mocks.createRenderPipelineAsync).toHaveBeenCalledTimes(4)
  })

  it.each([false, true])(
    'matches shader resources with filterable=%s',
    async (filterable) => {
      const { device, mocks } = createDevice(filterable)
      const programs = await getPrograms(device, 'bgra8unorm')
      const layout = (value: GPUBindGroupLayout) =>
        value as unknown as GPUBindGroupLayoutDescriptor

      expect(layout(programs.uniformLayout).entries).toEqual([
        {
          binding: 0,
          visibility: 2,
          buffer: { type: 'uniform', minBindingSize: 240 },
        },
      ])
      for (const [value, sampleType] of [
        [programs.inputFloatLayout, 'unfilterable-float'],
        [programs.inputU16Layout, 'uint'],
      ] as const) {
        expect(layout(value).entries).toEqual([
          {
            binding: 0,
            visibility: 2,
            texture: { sampleType, viewDimension: '2d' },
          },
          { binding: 1, visibility: 2, sampler: { type: 'non-filtering' } },
        ])
      }
      expect(layout(programs.lutLayout).entries).toEqual([
        {
          binding: 0,
          visibility: 2,
          texture: {
            sampleType: filterable ? 'float' : 'unfilterable-float',
            viewDimension: '3d',
          },
        },
        {
          binding: 1,
          visibility: 2,
          sampler: { type: filterable ? 'filtering' : 'non-filtering' },
        },
      ])
      expect(layout(programs.selectiveLayout).entries).toEqual([
        {
          binding: 0,
          visibility: 2,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
      ])
      expect(layout(programs.outputLayout).entries).toEqual([
        {
          binding: 0,
          visibility: 2,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
      ])
      expect(
        mocks.createShaderModule.mock.calls.map(
          ([descriptor]) => descriptor.code,
        ),
      ).toEqual(
        expect.arrayContaining([
          `process:false:${filterable}`,
          `process:true:${filterable}`,
        ]),
      )
    },
  )

  it('keeps both source formats in RGBA16F and uses buffer-free fullscreen triangles', async () => {
    const { device, mocks } = createDevice()
    const programs = await getPrograms(device, 'bgra8unorm')
    const descriptor = (value: GPURenderPipeline) =>
      value as unknown as GPURenderPipelineDescriptor
    for (const value of [programs.processFloat, programs.processU16]) {
      expect(descriptor(value).fragment?.targets).toEqual([
        { format: 'rgba16float' },
      ])
    }
    for (const [value, inputLayout] of [
      [programs.processFloat, programs.inputFloatLayout],
      [programs.processU16, programs.inputU16Layout],
    ] as const) {
      expect(descriptor(value).layout).toEqual({
        bindGroupLayouts: [
          programs.uniformLayout,
          inputLayout,
          programs.lutLayout,
          programs.selectiveLayout,
        ],
      })
    }
    expect(descriptor(programs.output).fragment?.targets).toEqual([
      { format: 'bgra8unorm' },
    ])
    expect(descriptor(programs.snapshotOutput).fragment?.targets).toEqual([
      { format: 'rgba8unorm' },
    ])
    for (const [value] of mocks.createRenderPipelineAsync.mock.calls) {
      expect(value.vertex.buffers).toEqual([])
      expect(value.vertex.entryPoint).toBe('main')
      expect(value.fragment.entryPoint).toBe('main')
      expect(value.primitive.topology).toBe('triangle-list')
    }
  })

  it('reuses the output pipeline when the canvas format matches snapshot output', async () => {
    const { device, mocks } = createDevice()
    const programs = await getPrograms(device, 'rgba8unorm')
    expect(programs.snapshotOutput).toBe(programs.output)
    expect(mocks.createRenderPipelineAsync).toHaveBeenCalledTimes(3)
  })

  it('rejects shader compilation errors with their source location and permits retry', async () => {
    const { device, messages, mocks } = createDevice()
    messages.set('process:false:false', [compilationMessage('error')])
    await expect(getPrograms(device, 'bgra8unorm')).rejects.toThrow(
      '3:8 unexpected token',
    )
    expect(mocks.createRenderPipelineAsync).not.toHaveBeenCalled()
    messages.clear()
    await expect(getPrograms(device, 'bgra8unorm')).resolves.toBeDefined()
    expect(mocks.createRenderPipelineAsync).toHaveBeenCalledTimes(4)
  })

  it('allows compilation warnings', async () => {
    const { device, messages } = createDevice()
    messages.set('vertex', [compilationMessage('warning')])
    await expect(getPrograms(device, 'bgra8unorm')).resolves.toBeDefined()
  })

  it('rejects asynchronous pipeline validation failures and removes only that format', async () => {
    const { device, mocks } = createDevice()
    const ready = await getPrograms(device, 'rgba8unorm')
    const failure = new Error('pipeline validation failed')
    mocks.createRenderPipelineAsync.mockRejectedValueOnce(failure)
    await expect(getPrograms(device, 'bgra8unorm')).rejects.toBe(failure)
    expect(await getPrograms(device, 'rgba8unorm')).toBe(ready)
    await expect(getPrograms(device, 'bgra8unorm')).resolves.toBeDefined()
  })
})
