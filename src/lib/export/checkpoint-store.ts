import type { ExportFidelity } from '@lumaforge/render-engine'

import { detectCapabilityVector } from '~/lib/runtime/capability-vector'
import { snapshotExportRuntimeResources } from '~/lib/runtime/export-runtime-resources'

import type {
  ExportCheckpointMode,
  ExportExecutionPlan,
  ExportExecutionProfileName,
  ExportOutputSink,
} from './execution-profile'
import { selectExportExecutionPlan } from './execution-profile'
import type { SourceFingerprint } from './source-fingerprint'

export type SourceReacquisitionMode =
  | 'current-session-file'
  | 'persisted-file-handle'
  | 'user-reselect-required'
  | 'opfs-source-copy'

export type ExportCheckpointJpegState = 'restart-required' | 'resumable'

export type ExportCheckpointChunk = {
  index: number
  startRow: number
  rowCount: number
  byteLength: number
}

export type ExportCheckpointManifest = {
  version: 1
  exportId: string
  sourceFingerprint: SourceFingerprint
  fileName: string
  sourceSize: number
  sourceLastModified: number
  outputWidth: number
  outputHeight: number
  graphFingerprint: string
  // Stored profile is metadata only; resume policy is always re-derived.
  profile: ExportExecutionProfileName
  derivedLabel?: string
  attempt: number
  preferredRows: number
  totalRows: number
  recoveryMode: ExportCheckpointMode
  outputSink: ExportOutputSink
  sourceReacquisition: SourceReacquisitionMode
  completedRowsForDiagnostics: number
  nextRowForResume?: number
  jpegState: ExportCheckpointJpegState
  chunks?: ExportCheckpointChunk[]
  updatedAt: string
}

export type CheckpointBackend = {
  write: (exportId: string, manifest: ExportCheckpointManifest) => Promise<void>
  list: () => Promise<ExportCheckpointManifest[]>
  remove: (exportId: string) => Promise<void>
  removeManifest?: (exportId: string) => Promise<void>
}

type OpfsStorage = Pick<StorageManager, 'getDirectory'>

const EXPORT_PROFILES = new Set<ExportExecutionProfileName>([
  'ios-safe',
  'mobile-balanced',
  'desktop-fast',
])
const RECOVERY_MODES = new Set<ExportCheckpointMode>([
  'safe-retry',
  'row-resume',
])
const OUTPUT_SINKS = new Set<ExportOutputSink>([
  'opfs-file',
  'streaming',
  'blob-handoff',
])
const SOURCE_REACQUISITION_MODES = new Set<SourceReacquisitionMode>([
  'current-session-file',
  'persisted-file-handle',
  'user-reselect-required',
  'opfs-source-copy',
])
const JPEG_STATES = new Set<ExportCheckpointJpegState>([
  'restart-required',
  'resumable',
])
const OPFS_OUTPUT_FILE = 'output.jpg'
const OPFS_OUTPUT_TEMP_FILE = `${OPFS_OUTPUT_FILE}.tmp`
const OPFS_OUTPUT_FINALIZED_FILE = `${OPFS_OUTPUT_FILE}.finalized.json`

function cloneManifest(manifest: ExportCheckpointManifest) {
  return JSON.parse(JSON.stringify(manifest)) as ExportCheckpointManifest
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOptionalNumber(value: unknown) {
  return value === undefined || typeof value === 'number'
}

function isSourceFingerprint(value: unknown): value is SourceFingerprint {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.size === 'number' &&
    typeof value.lastModified === 'number' &&
    isOptionalNumber(value.width) &&
    isOptionalNumber(value.height) &&
    typeof value.hashPrefixHex === 'string'
  )
}

function isCheckpointChunk(value: unknown): value is ExportCheckpointChunk {
  return (
    isRecord(value) &&
    typeof value.index === 'number' &&
    typeof value.startRow === 'number' &&
    typeof value.rowCount === 'number' &&
    typeof value.byteLength === 'number'
  )
}

function isExportCheckpointManifest(
  value: unknown,
): value is ExportCheckpointManifest {
  if (!isRecord(value)) return false

  const chunks = value.chunks
  if (
    chunks !== undefined &&
    (!Array.isArray(chunks) || !chunks.every(isCheckpointChunk))
  ) {
    return false
  }

  return (
    value.version === 1 &&
    typeof value.exportId === 'string' &&
    isSourceFingerprint(value.sourceFingerprint) &&
    typeof value.fileName === 'string' &&
    typeof value.sourceSize === 'number' &&
    typeof value.sourceLastModified === 'number' &&
    typeof value.outputWidth === 'number' &&
    typeof value.outputHeight === 'number' &&
    typeof value.graphFingerprint === 'string' &&
    typeof value.profile === 'string' &&
    EXPORT_PROFILES.has(value.profile as ExportExecutionProfileName) &&
    (value.derivedLabel === undefined ||
      typeof value.derivedLabel === 'string') &&
    typeof value.attempt === 'number' &&
    typeof value.preferredRows === 'number' &&
    typeof value.totalRows === 'number' &&
    typeof value.recoveryMode === 'string' &&
    RECOVERY_MODES.has(value.recoveryMode as ExportCheckpointMode) &&
    typeof value.outputSink === 'string' &&
    OUTPUT_SINKS.has(value.outputSink as ExportOutputSink) &&
    typeof value.sourceReacquisition === 'string' &&
    SOURCE_REACQUISITION_MODES.has(
      value.sourceReacquisition as SourceReacquisitionMode,
    ) &&
    typeof value.completedRowsForDiagnostics === 'number' &&
    isOptionalNumber(value.nextRowForResume) &&
    typeof value.jpegState === 'string' &&
    JPEG_STATES.has(value.jpegState as ExportCheckpointJpegState) &&
    typeof value.updatedAt === 'string'
  )
}

function getDefaultOpfsStorage(): OpfsStorage {
  const storage = globalThis.navigator?.storage
  if (!storage?.getDirectory) {
    throw new Error('OPFS_CHECKPOINT_STORAGE_UNAVAILABLE')
  }

  return storage
}

async function getActiveDirectory(storage: OpfsStorage) {
  const root = await storage.getDirectory()
  const exportsDirectory = await root.getDirectoryHandle('.lumaforge-exports', {
    create: true,
  })

  return exportsDirectory.getDirectoryHandle('active', { create: true })
}

async function removeOpfsEntryIfExists(
  directory: FileSystemDirectoryHandle,
  name: string,
) {
  try {
    await directory.removeEntry(name)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      return
    }
    throw error
  }
}

async function hasOpfsFile(directory: FileSystemDirectoryHandle, name: string) {
  try {
    await directory.getFileHandle(name)
    return true
  } catch {
    return false
  }
}

async function removeUnfinalizedOpfsOutput(
  directory: FileSystemDirectoryHandle,
) {
  const hasFinalizedMarker = await hasOpfsFile(
    directory,
    OPFS_OUTPUT_FINALIZED_FILE,
  )
  await removeOpfsEntryIfExists(directory, OPFS_OUTPUT_TEMP_FILE)
  if (!hasFinalizedMarker) {
    await removeOpfsEntryIfExists(directory, OPFS_OUTPUT_FILE)
  }
}

function readBlobAsText(blob: Blob) {
  if (typeof blob.text === 'function') return blob.text()

  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () =>
      reject(reader.error ?? new Error('CHECKPOINT_MANIFEST_READ_FAILED'))
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.readAsText(blob)
  })
}

export function createMemoryCheckpointBackend(): CheckpointBackend {
  const manifests = new Map<string, ExportCheckpointManifest>()

  return {
    async write(exportId, manifest) {
      manifests.set(exportId, cloneManifest(manifest))
    },
    async list() {
      return Array.from(manifests.values(), cloneManifest)
    },
    async remove(exportId) {
      manifests.delete(exportId)
    },
    async removeManifest(exportId) {
      manifests.delete(exportId)
    },
  }
}

export function createOpfsCheckpointBackend(
  storage: OpfsStorage = getDefaultOpfsStorage(),
): CheckpointBackend {
  return {
    async write(exportId, manifest) {
      const active = await getActiveDirectory(storage)
      const exportDirectory = await active.getDirectoryHandle(exportId, {
        create: true,
      })
      const file = await exportDirectory.getFileHandle('manifest.json', {
        create: true,
      })
      const writable = await file.createWritable()

      await writable.write(JSON.stringify(manifest))
      await writable.close()
    },
    async list() {
      const active = await getActiveDirectory(storage)
      const manifests: ExportCheckpointManifest[] = []

      for await (const [, handle] of active.entries()) {
        if (handle.kind !== 'directory') continue

        try {
          const fileHandle = await handle.getFileHandle('manifest.json')
          const file = await fileHandle.getFile()
          const parsed = JSON.parse(await readBlobAsText(file))
          if (isExportCheckpointManifest(parsed)) {
            manifests.push(parsed)
          }
        } catch {
          continue
        }
      }

      return manifests
    },
    async remove(exportId) {
      const active = await getActiveDirectory(storage)
      await active.removeEntry(exportId, { recursive: true })
    },
    async removeManifest(exportId) {
      const active = await getActiveDirectory(storage)
      const exportDirectory = await active.getDirectoryHandle(exportId)
      await exportDirectory.removeEntry('manifest.json')
      await removeUnfinalizedOpfsOutput(exportDirectory)
    },
  }
}

export function normalizeSafeRetryManifest(
  manifest: ExportCheckpointManifest,
): ExportCheckpointManifest {
  const {
    chunks: _chunks,
    nextRowForResume: _nextRowForResume,
    ...rest
  } = manifest

  return {
    ...rest,
    recoveryMode: 'safe-retry',
    jpegState: 'restart-required',
  }
}

export async function selectCheckpointResumeExecutionPlan(input: {
  manifest: ExportCheckpointManifest
  fidelity: ExportFidelity
}): Promise<ExportExecutionPlan> {
  const capability = await detectCapabilityVector()
  const runtime = await snapshotExportRuntimeResources({
    streamingSinkAvailable: false,
  })

  return selectExportExecutionPlan({
    performancePreference: input.fidelity,
    sourceWidth: input.manifest.outputWidth,
    sourceHeight: input.manifest.outputHeight,
    previousCrashLikeInterruption: true,
    previousResourceFailure: false,
    previousUserInterrupted: false,
    capability,
    runtime,
  })
}

export function createCheckpointStore(backend: CheckpointBackend) {
  return {
    writeActive(manifest: ExportCheckpointManifest) {
      return backend.write(
        manifest.exportId,
        normalizeSafeRetryManifest(manifest),
      )
    },
    listActive() {
      return backend.list()
    },
    async listSafeRetryCandidates() {
      return (await backend.list()).filter(
        (manifest) =>
          manifest.recoveryMode === 'safe-retry' &&
          manifest.jpegState === 'restart-required',
      )
    },
    remove(exportId: string) {
      return backend.remove(exportId)
    },
    removeActiveManifest(exportId: string) {
      return backend.removeManifest
        ? backend.removeManifest(exportId)
        : backend.remove(exportId)
    },
  }
}
