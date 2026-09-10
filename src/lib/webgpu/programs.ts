import {
  createProcessShader,
  PREVIEW_OUTPUT_SHADER,
  VERTEX_SHADER,
} from '~/lib/webgpu/shaders'

import type { ShaderSpecialization } from './specialization'
import {
  getShaderSpecializationKey,
  MAX_CACHED_SHADER_SPECIALIZATIONS,
  MAX_PARALLEL_SHADER_COMPILATIONS,
  MAX_QUEUED_SHADER_SPECIALIZATIONS,
  normalizeShaderSpecialization,
  WEBGPU_SPECIALIZATION_BUSY,
} from './specialization'

export interface WebGPUPrograms {
  uniformLayout: GPUBindGroupLayout
  inputFloatLayout: GPUBindGroupLayout
  inputU16Layout: GPUBindGroupLayout
  lutLayout: GPUBindGroupLayout
  selectiveLayout: GPUBindGroupLayout
  outputLayout: GPUBindGroupLayout
  processFloat: GPURenderPipeline
  processU16: GPURenderPipeline
  output: GPURenderPipeline
  snapshotOutput: GPURenderPipeline
}

type Layouts = Pick<
  WebGPUPrograms,
  | 'uniformLayout'
  | 'inputFloatLayout'
  | 'inputU16Layout'
  | 'lutLayout'
  | 'selectiveLayout'
  | 'outputLayout'
>
type Outputs = Pick<WebGPUPrograms, 'output' | 'snapshotOutput'>
interface SharedPrograms extends Layouts {
  vertex: GPUShaderModule
  outputFragment: GPUShaderModule
  floatPipelineLayout: GPUPipelineLayout
  u16PipelineLayout: GPUPipelineLayout
  outputPipelineLayout: GPUPipelineLayout
  outputs?: Promise<Outputs>
}
interface FormatPrograms {
  shared?: Promise<SharedPrograms>
  pending: Map<string, Promise<WebGPUPrograms>>
  settled: Map<string, Promise<WebGPUPrograms>>
}
interface DevicePrograms {
  formats: Map<GPUTextureFormat, FormatPrograms>
  active: number
  queue: (() => void)[]
}
const programsByDevice = new WeakMap<GPUDevice, DevicePrograms>()

function scheduleCompilation(
  state: DevicePrograms,
  compile: () => Promise<WebGPUPrograms>,
): Promise<WebGPUPrograms> | null {
  if (
    state.active >= MAX_PARALLEL_SHADER_COMPILATIONS &&
    state.queue.length >= MAX_QUEUED_SHADER_SPECIALIZATIONS
  )
    return null
  return new Promise((resolve, reject) => {
    const run = () => {
      state.active++
      void Promise.resolve()
        .then(compile)
        .then(resolve, reject)
        .finally(() => {
          state.active--
          state.queue.shift()?.()
        })
    }
    if (state.active < MAX_PARALLEL_SHADER_COMPILATIONS) run()
    else state.queue.push(run)
  })
}

async function compileShader(device: GPUDevice, label: string, code: string) {
  const module = device.createShaderModule({ label, code })
  const info = await module.getCompilationInfo()
  const errors = info.messages.filter((message) => message.type === 'error')
  if (errors.length > 0) {
    const detail = errors
      .map(
        (message) => `${message.lineNum}:${message.linePos} ${message.message}`,
      )
      .join('\n')
    throw new Error(`WEBGPU_SHADER_COMPILATION_FAILED: ${label}\n${detail}`)
  }
  return module
}

function textureLayout(
  device: GPUDevice,
  sampleType: GPUTextureSampleType,
  viewDimension: GPUTextureViewDimension,
  sampler?: GPUSamplerBindingType,
): GPUBindGroupLayout {
  const entries: GPUBindGroupLayoutEntry[] = [
    {
      binding: 0,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType, viewDimension },
    },
  ]
  if (sampler) {
    entries.push({
      binding: 1,
      visibility: GPUShaderStage.FRAGMENT,
      sampler: { type: sampler },
    })
  }
  return device.createBindGroupLayout({ entries })
}

async function createSharedPrograms(
  device: GPUDevice,
): Promise<SharedPrograms> {
  const filterable = device.features.has('float32-filterable')
  const [vertex, outputFragment] = await Promise.all([
    compileShader(device, 'RAW fullscreen triangle', VERTEX_SHADER),
    compileShader(device, 'RAW output', PREVIEW_OUTPUT_SHADER),
  ])
  const uniformLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', minBindingSize: 240 },
      },
    ],
  })
  const inputFloatLayout = textureLayout(
    device,
    'unfilterable-float',
    '2d',
    'non-filtering',
  )
  const inputU16Layout = textureLayout(device, 'uint', '2d', 'non-filtering')
  const lutLayout = textureLayout(
    device,
    filterable ? 'float' : 'unfilterable-float',
    '3d',
    filterable ? 'filtering' : 'non-filtering',
  )
  const selectiveLayout = textureLayout(device, 'unfilterable-float', '2d')
  const outputLayout = textureLayout(device, 'float', '2d', 'filtering')

  const processingLayout = (input: GPUBindGroupLayout) =>
    device.createPipelineLayout({
      bindGroupLayouts: [uniformLayout, input, lutLayout, selectiveLayout],
    })
  return {
    uniformLayout,
    inputFloatLayout,
    inputU16Layout,
    lutLayout,
    selectiveLayout,
    outputLayout,
    vertex,
    outputFragment,
    floatPipelineLayout: processingLayout(inputFloatLayout),
    u16PipelineLayout: processingLayout(inputU16Layout),
    outputPipelineLayout: device.createPipelineLayout({
      bindGroupLayouts: [outputLayout],
    }),
  }
}

function makePipeline(
  device: GPUDevice,
  vertex: GPUShaderModule,
  label: string,
  module: GPUShaderModule,
  layout: GPUPipelineLayout,
  format: GPUTextureFormat,
) {
  return device.createRenderPipelineAsync({
    label,
    layout,
    vertex: { module: vertex, entryPoint: 'main', buffers: [] },
    primitive: { topology: 'triangle-list' },
    fragment: { module, entryPoint: 'main', targets: [{ format }] },
  })
}

function getOutputs(
  device: GPUDevice,
  shared: SharedPrograms,
  canvasFormat: GPUTextureFormat,
): Promise<Outputs> {
  if (shared.outputs) return shared.outputs
  const output = makePipeline(
    device,
    shared.vertex,
    'RAW canvas output',
    shared.outputFragment,
    shared.outputPipelineLayout,
    canvasFormat,
  )
  const snapshot =
    canvasFormat === 'rgba8unorm'
      ? output
      : makePipeline(
          device,
          shared.vertex,
          'RAW snapshot output',
          shared.outputFragment,
          shared.outputPipelineLayout,
          'rgba8unorm',
        )
  const pending = Promise.all([output, snapshot]).then(
    ([output, snapshotOutput]) => ({ output, snapshotOutput }),
  )
  shared.outputs = pending
  void pending.catch(() => {
    if (shared.outputs === pending) shared.outputs = undefined
  })
  return pending
}

async function createPrograms(
  device: GPUDevice,
  canvasFormat: GPUTextureFormat,
  cache: FormatPrograms,
  specialization?: ShaderSpecialization,
): Promise<WebGPUPrograms> {
  const filterable = device.features.has('float32-filterable')
  if (!cache.shared) {
    const shared = createSharedPrograms(device)
    cache.shared = shared
    void shared.catch(() => {
      if (cache.shared === shared) cache.shared = undefined
    })
  }
  // Validate all shader modules before creating any render pipeline. Common
  // layouts/output modules survive a failed process variant and are reusable.
  const [shared, floatFragment, u16Fragment] = await Promise.all([
    cache.shared,
    compileShader(
      device,
      'RAW float process',
      createProcessShader(false, filterable, specialization),
    ),
    compileShader(
      device,
      'RAW uint16 process',
      createProcessShader(true, filterable, specialization),
    ),
  ])
  const [outputs, processFloat, processU16] = await Promise.all([
    getOutputs(device, shared, canvasFormat),
    makePipeline(
      device,
      shared.vertex,
      'RAW float process',
      floatFragment,
      shared.floatPipelineLayout,
      'rgba16float',
    ),
    makePipeline(
      device,
      shared.vertex,
      'RAW uint16 process',
      u16Fragment,
      shared.u16PipelineLayout,
      'rgba16float',
    ),
  ])
  return {
    uniformLayout: shared.uniformLayout,
    inputFloatLayout: shared.inputFloatLayout,
    inputU16Layout: shared.inputU16Layout,
    lutLayout: shared.lutLayout,
    selectiveLayout: shared.selectiveLayout,
    outputLayout: shared.outputLayout,
    ...outputs,
    processFloat,
    processU16,
  }
}

/** Share layouts/output; only process variants enter the bounded compiler queue. */
export function getWebGPUPrograms(
  device: GPUDevice,
  canvasFormat: GPUTextureFormat,
  specialization?: ShaderSpecialization,
): Promise<WebGPUPrograms> {
  let state = programsByDevice.get(device)
  if (!state) {
    state = { formats: new Map(), active: 0, queue: [] }
    programsByDevice.set(device, state)
  }
  let cache = state.formats.get(canvasFormat)
  if (!cache) {
    cache = { pending: new Map(), settled: new Map() }
    state.formats.set(canvasFormat, cache)
  }
  const normalized = specialization
    ? normalizeShaderSpecialization(specialization)
    : undefined
  const key = getShaderSpecializationKey(normalized)
  const pendingHit = cache.pending.get(key)
  if (pendingHit) return pendingHit
  const settledHit = cache.settled.get(key)
  if (settledHit) {
    cache.settled.delete(key)
    cache.settled.set(key, settledHit)
    return settledHit
  }
  const captured = cache
  const pending = scheduleCompilation(state, () =>
    createPrograms(device, canvasFormat, captured, normalized),
  )
  if (!pending) return Promise.reject(new Error(WEBGPU_SPECIALIZATION_BUSY))
  cache.pending.set(key, pending)
  void pending.then(
    () => {
      if (captured.pending.get(key) === pending) captured.pending.delete(key)
      captured.settled.set(key, pending)
      while (captured.settled.size > MAX_CACHED_SHADER_SPECIALIZATIONS) {
        // Keep the generic fallback once ready; only settled specialized programs
        // are evicted, so rapid controls cannot duplicate in-flight compilation.
        const oldest = [...captured.settled.keys()].find(
          (value) => value !== 'generic',
        )
        if (oldest === undefined) break
        captured.settled.delete(oldest)
      }
    },
    () => {
      if (captured.pending.get(key) === pending) captured.pending.delete(key)
    },
  )
  return pending
}

export function getWebGPUProgramCacheStats(
  device: GPUDevice,
  canvasFormat: GPUTextureFormat,
) {
  const state = programsByDevice.get(device)
  const cache = state?.formats.get(canvasFormat)
  return {
    settledPrograms: cache?.settled.size ?? 0,
    pendingPrograms: cache?.pending.size ?? 0,
    activeCompilations: state?.active ?? 0,
    queuedCompilations: state?.queue.length ?? 0,
  }
}
