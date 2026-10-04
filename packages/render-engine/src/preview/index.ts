// `@lumaforge/render-engine/preview` subpath entry.
//
// CPU preview path: preview-render.ts, preview-plan.ts, and the
// worker-bridge module (CPU preview Worker abstraction), plus the
// candidate-render and contact-sheet primitives built on top of them.

export {
  BOUNDED_HQ_PREVIEW_MAX_PIXELS,
  type BoundedHqPreviewTarget,
  createProgressivePreviewPlan,
  decideBoundedHqPreview,
  type ProgressivePreviewPlan,
  QUICK_PREVIEW_MAX_PIXELS,
  type QuickPreviewTarget,
} from './preview-plan'
export {
  renderCpuPreviewFrame,
  type RenderCpuPreviewFrameInput,
} from './preview-render'
export {
  CpuPreviewClient,
  type CpuPreviewFrame,
  type CpuPreviewWorkerLike,
} from './worker-bridge/bridge'
export type {
  CpuPreviewFailureReason,
  CpuPreviewRequest,
  CpuPreviewResponse,
  CpuPreviewVariant,
} from './worker-bridge/protocol'

// Candidate render + contact sheet
export {
  type CandidateParams,
  candidateRender,
  type CandidateRenderOptions,
  type CandidateRenderSource,
  type CandidateResult,
} from './candidate-render'
export {
  composeContactSheet,
  type ComposeContactSheetInput,
  type ContactSheet,
  type ContactSheetTile,
} from './contact-sheet'
export {
  encodePreviewFrameToJpeg,
  type EncodePreviewFrameToJpegInput,
  type PreviewJpegEncoder,
  type PreviewJpegEncoderFactory,
} from './preview-jpeg-encode'
