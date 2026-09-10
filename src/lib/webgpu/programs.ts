import {
  createProcessShader,
  PREVIEW_OUTPUT_SHADER,
  VERTEX_SHADER,
} from '~/lib/webgpu/shaders'

import type { ShaderSpecialization } from './specialization'
import {
  getShaderSpecializationKey,
  normalizeShaderSpecialization,
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
  shared: Promise<SharedPrograms>
  variants: Map<string, Promise<WebGPUPrograms>>
}
const programsByDevice = new WeakMap<
  GPUDevice,
  Map<GPUTextureFormat, FormatPrograms>
>()

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

/** At most 24 feature variants plus generic per device/format; no slider values. */
export function getWebGPUPrograms(
  device: GPUDevice,
  canvasFormat: GPUTextureFormat,
  specialization?: ShaderSpecialization,
): Promise<WebGPUPrograms> {
  let formats = programsByDevice.get(device)
  if (!formats) {
    formats = new Map()
    programsByDevice.set(device, formats)
  }
  let cache = formats.get(canvasFormat)
  if (!cache) {
    cache = { shared: createSharedPrograms(device), variants: new Map() }
    formats.set(canvasFormat, cache)
    const captured = cache
    void cache.shared.catch(() => {
      if (formats.get(canvasFormat) === captured) formats.delete(canvasFormat)
    })
  }
  const normalized = specialization
    ? normalizeShaderSpecialization(specialization)
    : undefined
  const key = getShaderSpecializationKey(normalized)
  const cached = cache.variants.get(key)
  if (cached) return cached
  const pending = createPrograms(device, canvasFormat, cache, normalized)
  cache.variants.set(key, pending)
  const variants = cache.variants
  void pending.catch(() => {
    if (variants.get(key) === pending) variants.delete(key)
  })
  return pending
}
