// RenderBudget — type sketch.
//
// Type only: no unified back-pressure logic across preview / candidate /
// export consumes it yet.

export interface RenderBudget {
  /**
   * Maximum concurrent render units in flight across preview + candidate +
   * export. Each render unit consumes one slot; preview-quick is 1, an
   * export is `policy.concurrency`.
   */
  readonly maxConcurrent: number

  /**
   * Maximum candidate sweep size (`candidate-render` calls). Caps the array
   * of `RenderParams` accepted by `candidateRender(...)` before the
   * AsyncIterable starts producing.
   */
  readonly maxCandidatesPerSweep: number

  /**
   * Soft memory budget in MiB. Sinks and decode paths SHOULD respect it;
   * the engine does NOT enforce it (no monitoring) — it's a hint passed to
   * policy decisions (memory-aware strip slicing, etc.).
   */
  readonly softMemoryBudgetMiB: number
}
