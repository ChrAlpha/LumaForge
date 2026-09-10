import {
  createProcessShader,
  PREVIEW_OUTPUT_SHADER,
  VERTEX_SHADER,
} from '~/lib/webgpu/shaders'

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

const programsByDevice = new WeakMap<
  GPUDevice,
  Map<GPUTextureFormat, Promise<WebGPUPrograms>>
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

async function createPrograms(
  device: GPUDevice,
  canvasFormat: GPUTextureFormat,
): Promise<WebGPUPrograms> {
  const filterable = device.features.has('float32-filterable')
  const [vertex, floatFragment, u16Fragment, outputFragment] =
    await Promise.all([
      compileShader(device, 'RAW fullscreen triangle', VERTEX_SHADER),
      compileShader(
        device,
        'RAW float process',
        createProcessShader(false, filterable),
      ),
      compileShader(
        device,
        'RAW uint16 process',
        createProcessShader(true, filterable),
      ),
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

  const vertexState: GPUVertexState = {
    module: vertex,
    entryPoint: 'main',
    buffers: [],
  }
  const primitive: GPUPrimitiveState = { topology: 'triangle-list' }
  const makePipeline = (
    label: string,
    module: GPUShaderModule,
    layout: GPUPipelineLayout,
    format: GPUTextureFormat,
  ) =>
    device.createRenderPipelineAsync({
      label,
      layout,
      vertex: vertexState,
      primitive,
      fragment: { module, entryPoint: 'main', targets: [{ format }] },
    })
  const processingLayout = (input: GPUBindGroupLayout) =>
    device.createPipelineLayout({
      bindGroupLayouts: [uniformLayout, input, lutLayout, selectiveLayout],
    })
  const outputPipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [outputLayout],
  })
  const outputPromise = makePipeline(
    'RAW canvas output',
    outputFragment,
    outputPipelineLayout,
    canvasFormat,
  )
  const [processFloat, processU16, output, snapshotOutput] = await Promise.all([
    makePipeline(
      'RAW float process',
      floatFragment,
      processingLayout(inputFloatLayout),
      'rgba16float',
    ),
    makePipeline(
      'RAW uint16 process',
      u16Fragment,
      processingLayout(inputU16Layout),
      'rgba16float',
    ),
    outputPromise,
    canvasFormat === 'rgba8unorm'
      ? outputPromise
      : makePipeline(
          'RAW snapshot output',
          outputFragment,
          outputPipelineLayout,
          'rgba8unorm',
        ),
  ])
  return {
    uniformLayout,
    inputFloatLayout,
    inputU16Layout,
    lutLayout,
    selectiveLayout,
    outputLayout,
    processFloat,
    processU16,
    output,
    snapshotOutput,
  }
}

/** Async compilation errors are per-pipeline; no shared device error scopes. */
export function getWebGPUPrograms(
  device: GPUDevice,
  canvasFormat: GPUTextureFormat,
): Promise<WebGPUPrograms> {
  let formats = programsByDevice.get(device)
  if (!formats) {
    formats = new Map()
    programsByDevice.set(device, formats)
  }
  const cached = formats.get(canvasFormat)
  if (cached) return cached
  const pending = createPrograms(device, canvasFormat)
  formats.set(canvasFormat, pending)
  void pending.catch(() => {
    if (formats.get(canvasFormat) === pending) formats.delete(canvasFormat)
  })
  return pending
}
