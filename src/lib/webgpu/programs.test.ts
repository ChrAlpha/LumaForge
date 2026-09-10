import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ShaderSpecialization } from './specialization'
import {
  MAX_CACHED_SHADER_SPECIALIZATIONS,
  MAX_PARALLEL_SHADER_COMPILATIONS,
  MAX_QUEUED_SHADER_SPECIALIZATIONS,
  WEBGPU_SPECIALIZATION_BUSY,
} from './specialization'

vi.mock('~/lib/webgpu/shaders', () => ({
  VERTEX_SHADER: 'vertex',
  PREVIEW_OUTPUT_SHADER: 'output',
  createProcessShader: (
    integerInput: boolean,
    filterable: boolean,
    specialization?: ShaderSpecialization,
  ) =>
    `process:${integerInput}:${filterable}${specialization ? `:${specialization.styleKind}:${Number(specialization.saturationActive)}` : ''}`,
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
let getCacheStats: typeof import('./programs').getWebGPUProgramCacheStats

function profileVariant(index: number): ShaderSpecialization {
  return {
    styleKind: 2,
    useLut: true,
    selectiveColorActive: false,
    saturationActive: false,
    vibranceActive: false,
    lutRole: 1,
    lutInputTransfer: index % 22,
    lutOutputTransfer: Math.floor(index / 22),
    lutInputRange: 0,
    lutOutputRange: 0,
  }
}

beforeEach(async () => {
  vi.resetModules()
  vi.stubGlobal('GPUShaderStage', { FRAGMENT: 2 })
  const programs = await import('./programs')
  getPrograms = programs.getWebGPUPrograms
  getCacheStats = programs.getWebGPUProgramCacheStats
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('cached WebGPU programs', () => {
  it('bounds per-device compilation to two active and 32 queued jobs without evicting pending requests', async () => {
    const { device, mocks } = createDevice()
    let release!: () => void
    const gate = new Promise<{ messages: never[] }>((resolve) => {
      release = () => resolve({ messages: [] })
    })
    mocks.createShaderModule.mockImplementation(({ label }) => ({
      label,
      getCompilationInfo: vi.fn(() => gate),
    }))
    const count =
      MAX_PARALLEL_SHADER_COMPILATIONS + MAX_QUEUED_SHADER_SPECIALIZATIONS
    const requests = Array.from({ length: count }, (_, index) =>
      getPrograms(device, 'rgba8unorm', profileVariant(index)),
    )
    const busy = getPrograms(device, 'rgba8unorm', profileVariant(count)).catch(
      (error) => error,
    )
    expect(getPrograms(device, 'rgba8unorm', profileVariant(0))).toBe(
      requests[0],
    )
    expect(getCacheStats(device, 'rgba8unorm')).toEqual({
      settledPrograms: 0,
      pendingPrograms: 34,
      activeCompilations: 2,
      queuedCompilations: 32,
    })
    expect((await busy).message).toBe(WEBGPU_SPECIALIZATION_BUSY)
    const independent = createDevice()
    await expect(
      getPrograms(independent.device, 'rgba8unorm'),
    ).resolves.toBeDefined()
    release()
    await Promise.all(requests)
    await vi.waitFor(() =>
      expect(getCacheStats(device, 'rgba8unorm')).toEqual({
        settledPrograms: MAX_CACHED_SHADER_SPECIALIZATIONS,
        pendingPrograms: 0,
        activeCompilations: 0,
        queuedCompilations: 0,
      }),
    )
    await expect(
      getPrograms(device, 'rgba8unorm', profileVariant(count)),
    ).resolves.toBeDefined()
  })

  it('evicts only settled least-recent variants and pins the ready generic fallback', async () => {
    const { device, mocks } = createDevice()
    const generic = await getPrograms(device, 'rgba8unorm')
    const first = await getPrograms(device, 'rgba8unorm', profileVariant(0))
    for (let index = 1; index <= MAX_CACHED_SHADER_SPECIALIZATIONS; index++)
      await getPrograms(device, 'rgba8unorm', profileVariant(index))
    expect(getCacheStats(device, 'rgba8unorm').settledPrograms).toBe(
      MAX_CACHED_SHADER_SPECIALIZATIONS,
    )
    expect(await getPrograms(device, 'rgba8unorm')).toBe(generic)
    const count = mocks.createRenderPipelineAsync.mock.calls.length
    expect(await getPrograms(device, 'rgba8unorm', profileVariant(0))).not.toBe(
      first,
    )
    expect(mocks.createRenderPipelineAsync).toHaveBeenCalledTimes(count + 2)
    expect(getCacheStats(device, 'rgba8unorm').settledPrograms).toBe(
      MAX_CACHED_SHADER_SPECIALIZATIONS,
    )
    expect(mocks.createBindGroupLayout).toHaveBeenCalledTimes(6)
  })

  it('shares common layouts/output and only compiles two process pipelines for each new feature key', async () => {
    const { device, mocks } = createDevice()
    const neutral: ShaderSpecialization = {
      styleKind: 0,
      useLut: false,
      selectiveColorActive: false,
      saturationActive: false,
      vibranceActive: false,
    }
    const first = await getPrograms(device, 'bgra8unorm', neutral)
    const layouts = mocks.createBindGroupLayout.mock.calls.length
    const active = await getPrograms(device, 'bgra8unorm', {
      ...neutral,
      styleKind: 1,
      saturationActive: true,
    })
    expect(mocks.createShaderModule).toHaveBeenCalledTimes(6)
    expect(mocks.createRenderPipelineAsync).toHaveBeenCalledTimes(6)
    expect(mocks.createBindGroupLayout).toHaveBeenCalledTimes(layouts)
    for (const field of [
      'uniformLayout',
      'inputFloatLayout',
      'inputU16Layout',
      'lutLayout',
      'selectiveLayout',
      'outputLayout',
      'output',
      'snapshotOutput',
    ] as const)
      expect(active[field]).toBe(first[field])
    expect(active.processFloat).not.toBe(first.processFloat)
    expect(
      await getPrograms(device, 'bgra8unorm', { ...neutral, useLut: true }),
    ).toBe(first)
    const generic = await getPrograms(device, 'bgra8unorm')
    expect(generic.output).toBe(first.output)
    expect(mocks.createShaderModule).toHaveBeenCalledTimes(8)
    expect(mocks.createRenderPipelineAsync).toHaveBeenCalledTimes(8)
  })

  it('removes only a failed feature variant while preserving ready variants', async () => {
    const { device, mocks } = createDevice()
    const generic = await getPrograms(device, 'rgba8unorm')
    const neutral: ShaderSpecialization = {
      styleKind: 0,
      useLut: false,
      selectiveColorActive: false,
      saturationActive: false,
      vibranceActive: false,
    }
    mocks.createRenderPipelineAsync.mockRejectedValueOnce(
      new Error('variant failed'),
    )
    await expect(getPrograms(device, 'rgba8unorm', neutral)).rejects.toThrow(
      'variant failed',
    )
    expect(await getPrograms(device, 'rgba8unorm')).toBe(generic)
    const retry = await getPrograms(device, 'rgba8unorm', neutral)
    expect(retry.output).toBe(generic.output)
    expect(mocks.createBindGroupLayout).toHaveBeenCalledTimes(6)
  })
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
