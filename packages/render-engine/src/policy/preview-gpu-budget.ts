// PreviewGpuBudget — the per-source preview GPU budget interactive-policy.ts
// takes as input, and the GPU facts it is derived from. The engine owns these
// shapes and never detects GPU facts: the host reads its resolved preview
// backend and derives the budget.

export interface PreviewGpuCapabilitySnapshot {
  readonly webgpu: boolean
  readonly maxTextureSize: number
}

export interface PreviewGpuBudget {
  readonly boundedHqMaxPixels: number
  readonly dualGpuAllowed: boolean
  readonly originalReferenceSnapshotMaxPixels: number
}
