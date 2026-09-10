type Resource = { destroy: () => void }

/** Own asynchronous readback allocations until completion or synchronous
 * evacuation. Destroying a pending MAP_READ buffer cancels its map request. */
export class GPUReadbackScope {
  private resources = new Map<Resource, () => number>()
  private closed = false

  constructor(private readonly onClose: () => void = () => {}) {}

  assertActive() {
    if (this.closed) throw new Error('GPU_READBACK_CANCELLED')
  }

  track<T extends Resource>(resource: T, bytes: number | (() => number)): T {
    if (this.closed) {
      resource.destroy()
      this.assertActive()
    }
    this.resources.set(
      resource,
      typeof bytes === 'number' ? () => bytes : bytes,
    )
    return resource
  }

  release(resource: Resource | null) {
    if (resource && this.resources.delete(resource)) resource.destroy()
  }

  get estimatedBytes() {
    return [...this.resources.values()].reduce((sum, bytes) => sum + bytes(), 0)
  }

  dispose() {
    if (this.closed) return
    this.closed = true
    for (const resource of this.resources.keys()) resource.destroy()
    this.resources.clear()
    this.onClose()
  }
}

export class GPUReadbackJobs {
  private scopes = new Set<GPUReadbackScope>()

  create() {
    const scope = new GPUReadbackScope(() => this.scopes.delete(scope))
    this.scopes.add(scope)
    return scope
  }

  get estimatedBytes() {
    return [...this.scopes].reduce(
      (sum, scope) => sum + scope.estimatedBytes,
      0,
    )
  }

  dispose() {
    for (const scope of this.scopes) scope.dispose()
  }
}
