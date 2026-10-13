/**
 * What the WebGPU preview draws for the selected look, and the LUT uniforms it
 * draws a LUT with.
 */

import type {
  ColorGraphIntent,
  ExportColorGraphStep,
  LookSelection,
  LUTData,
  SupportedExportColorGraphDescriptor,
} from '@lumaforge/luma-color-runtime'
import { mat3Identity, mat3ToColumnMajor } from '@lumaforge/luma-color-runtime'
import {
  LUT_RANGE_UNIFORMS,
  LUT_ROLE_UNIFORMS,
  LUT_TRANSFER_UNIFORMS,
} from '@lumaforge/luma-color-runtime/wgsl'
import { resolvePreviewColorPlan } from '@lumaforge/render-engine/preview'

export interface LUTPipelineProfileUniforms {
  inputToLutGamut: Float32Array
  lutOutputToDisplayGamut: Float32Array
  lutInputTransfer: number
  lutOutputTransfer: number
  lutRole: number
  lutInputRange: number
  lutOutputRange: number
}

export interface GpuPreviewLook {
  /** The look the shader draws: the selection, or no look. */
  look: LookSelection
  /** The LUT the shader samples; null unless a custom look is drawn. */
  lut: LUTData | null
  uniforms: LUTPipelineProfileUniforms
}

const IDENTITY = mat3ToColumnMajor(mat3Identity())

const NO_LUT_UNIFORMS: LUTPipelineProfileUniforms = {
  inputToLutGamut: IDENTITY,
  lutOutputToDisplayGamut: IDENTITY,
  lutInputTransfer: LUT_TRANSFER_UNIFORMS.srgb,
  lutOutputTransfer: LUT_TRANSFER_UNIFORMS.srgb,
  lutRole: LUT_ROLE_UNIFORMS['display-look'],
  lutInputRange: LUT_RANGE_UNIFORMS.full,
  lutOutputRange: LUT_RANGE_UNIFORMS.full,
}

function graphStep<Kind extends ExportColorGraphStep['kind']>(
  graph: SupportedExportColorGraphDescriptor | null,
  kind: Kind,
): Extract<ExportColorGraphStep, { kind: Kind }> {
  const step = graph?.steps.find(
    (candidate): candidate is Extract<ExportColorGraphStep, { kind: Kind }> =>
      candidate.kind === kind,
  )
  if (!step) throw new Error(`A drawn LUT has no ${kind} export step.`)
  return step
}

/**
 * The look the WebGPU preview draws, read from the shared preview color
 * policy. A custom LUT draws only when export would run it; otherwise the
 * shader draws no look over the user's adjustments, at any strength. Built-in
 * presets draw as selected. A drawn LUT takes its gamut matrices, transfers,
 * ranges and role from the LUT steps of the export graph that runs it.
 */
export function resolveGpuPreviewLook(
  intent: ColorGraphIntent,
  lut: LUTData | null,
): GpuPreviewLook {
  const plan = resolvePreviewColorPlan({ intent, lut, executor: 'webgpu' })
  if (!plan.lut)
    return { look: plan.effective, lut: null, uniforms: NO_LUT_UNIFORMS }
  const input = graphStep(plan.graph, 'gamut-to-lut-input')
  const encode = graphStep(plan.graph, 'encode-lut-transfer')
  const output = graphStep(plan.graph, 'lut-output-to-srgb')
  return {
    look: plan.effective,
    lut: plan.lut,
    uniforms: {
      inputToLutGamut: mat3ToColumnMajor(input.matrix),
      lutOutputToDisplayGamut: mat3ToColumnMajor(output.matrix),
      lutInputTransfer: LUT_TRANSFER_UNIFORMS[encode.transfer],
      lutOutputTransfer: LUT_TRANSFER_UNIFORMS[output.transfer],
      lutRole: LUT_ROLE_UNIFORMS[output.role],
      lutInputRange: LUT_RANGE_UNIFORMS[encode.range],
      lutOutputRange: LUT_RANGE_UNIFORMS[output.range],
    },
  }
}
