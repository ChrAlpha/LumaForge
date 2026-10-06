// ExportRuntimeResources — the export storage snapshot export-policy.ts takes
// as input. The engine owns these shapes and never probes storage: the host
// probes OPFS / navigator.storage and fills them.

export interface ExportRuntimeResources {
  readonly opfsSinkAvailable: boolean
  readonly opfsAvailableMB: number | null
  readonly streamingSinkAvailable: boolean
}

export interface ExportRuntimeResourcesInput {
  streamingSinkAvailable: boolean
}
