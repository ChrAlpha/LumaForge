// PreviewGpuBudget — type-only mirror of `src/lib/runtime/preview-gpu-budget.ts`.
//
// The DOM-bound DETECTION (the resolved WebGPU preview backend) stays in
// `src/`. The engine's policy decisions (interactive-policy.ts) take the
// derived budget as input, so the engine only needs the shape here.

export interface PreviewGpuCapabilitySnapshot {
  readonly webgpu: boolean
  readonly maxTextureSize: number
}

export interface PreviewGpuBudget {
  readonly boundedHqMaxPixels: number
  readonly dualGpuAllowed: boolean
  readonly originalReferenceSnapshotMaxPixels: number
}
