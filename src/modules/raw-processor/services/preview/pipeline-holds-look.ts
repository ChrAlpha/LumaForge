import type {
  ColorGraphIntent,
  LUTData,
  RawRenderExposure,
} from '@lumaforge/luma-color-runtime'
import { colorGraphIntentSignature } from '@lumaforge/luma-color-runtime'

import type { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'

import { hasSameRawRenderExposure } from '../export/export-state'

/** What a preview pipeline tells about the look it draws now. */
type LookHoldingPipeline = Pick<
  RawProcessingPipeline,
  'getParams' | 'getLutData'
>

/**
 * Whether the pipeline holds this color and this LUT. A pipeline follows the
 * store only once the preview's effects run, so a write that has not reached
 * it yet would put other pixels under the store's look. The LUT counts only
 * when the look draws one; a table counts as held only when the pipeline
 * holds the same table, domain and contract. A pipeline that cannot answer
 * holds nothing.
 */
function holdsColorAndLut(
  pipeline: LookHoldingPipeline,
  intent: ColorGraphIntent,
  lut: LUTData | null,
): boolean {
  let held: ColorGraphIntent
  try {
    held = pipeline.getParams()
  } catch {
    return false
  }
  if (colorGraphIntentSignature(held) !== colorGraphIntentSignature(intent)) {
    return false
  }
  if (intent.styleKind !== 'custom') return true
  const heldLut = pipeline.getLutData()
  if (!heldLut || !lut) return heldLut === lut
  return (
    heldLut.data === lut.data &&
    heldLut.size === lut.size &&
    heldLut.domainMin === lut.domainMin &&
    heldLut.domainMax === lut.domainMax &&
    heldLut.profileResolution === lut.profileResolution
  )
}

type PipelineHoldsLookInput = Readonly<{
  /** The pipeline that renders, captured when the render was asked for. */
  pipeline: LookHoldingPipeline
  /** The pipeline the preview publishes now. */
  publishedPipeline: LookHoldingPipeline | null
  /** The RAW render exposure of the frame the preview draws now. */
  frameExposure: RawRenderExposure | null
  intent: ColorGraphIntent
  lut: LUTData | null
  rawRenderExposure: RawRenderExposure | null
}>

/**
 * Whether pixels the pipeline renders now stand for this color, LUT and RAW
 * render exposure: the preview still publishes this very pipeline, it holds
 * the color and the LUT, and the frame it draws carries the exposure. Ask it
 * before a hidden render and again after every await, right before the
 * pixels are used; a replaced or released pipeline never vouches for a
 * render, even one holding the same look.
 */
export function pipelineHoldsLook({
  pipeline,
  publishedPipeline,
  frameExposure,
  intent,
  lut,
  rawRenderExposure,
}: PipelineHoldsLookInput): boolean {
  return (
    publishedPipeline === pipeline &&
    !!frameExposure &&
    hasSameRawRenderExposure(frameExposure, rawRenderExposure) &&
    holdsColorAndLut(pipeline, intent, lut)
  )
}
