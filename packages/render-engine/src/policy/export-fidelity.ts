// ExportFidelity.
//
// Discrete export-quality input that policy decisions branch on. Lives in
// engine policy so the pipeline-concurrency helper (now under
// `render-engine/src/export/`) can normalize concurrency without crossing
// back into `src/lib/gl/`. `src/lib/gl/export.ts` re-exports this type for
// back-compat with app-side consumers.

export type ExportFidelity = 'safe' | 'balanced' | 'max'
