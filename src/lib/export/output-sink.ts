export type BlobOutputResult = {
  kind: 'blob'
  filename: string
  blob: Blob
  byteLength: number
  mimeType: string
  /** SHA-256 hex of the delivered bytes when the producer hashed them. */
  sha256?: string
}

export type FileBackedOutputResult = {
  kind: 'file-backed'
  exportId: string
  filename: string
  byteLength: number
  mimeType: string
  openBlob: () => Promise<Blob>
  cleanup?: () => Promise<void>
  /** SHA-256 hex of the delivered bytes, hashed at write time so the file never has to be reopened. */
  sha256?: string
}

export type BytesOutputResult = {
  kind: 'bytes'
  filename: string
  bytes: Uint8Array
  byteLength: number
  mimeType: string
  sha256?: string
}

export type ExportOutputResult =
  | BlobOutputResult
  | FileBackedOutputResult
  | BytesOutputResult

type OpfsStorage = Pick<StorageManager, 'getDirectory'>

const OPFS_EXPORTS_DIR = '.lumaforge-exports'
const OPFS_ACTIVE_DIR = 'active'
const DEFAULT_OPFS_OUTPUT_FILE = 'output.jpg'
const OPFS_OUTPUT_TEMP_SUFFIX = '.tmp'
const OPFS_OUTPUT_FINALIZED_SUFFIX = '.finalized.json'

function getDefaultOpfsStorage(): OpfsStorage {
  const storage = globalThis.navigator?.storage
  if (!storage?.getDirectory) {
    throw new Error('OPFS_OUTPUT_STORAGE_UNAVAILABLE')
  }

  return storage
}

async function getOpfsExportDirectory(
  exportId: string,
  storage: OpfsStorage = getDefaultOpfsStorage(),
) {
  const root = await storage.getDirectory()
  const exportsDirectory = await root.getDirectoryHandle(OPFS_EXPORTS_DIR, {
    create: true,
  })
  const activeDirectory = await exportsDirectory.getDirectoryHandle(
    OPFS_ACTIVE_DIR,
    { create: true },
  )

  return activeDirectory.getDirectoryHandle(exportId, { create: true })
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

async function writeOpfsFile(
  directory: FileSystemDirectoryHandle,
  name: string,
  data: Blob | string,
) {
  const fileHandle = await directory.getFileHandle(name, { create: true })
  const writable = await fileHandle.createWritable()
  try {
    await writable.write(data instanceof Blob ? await data.arrayBuffer() : data)
    await writable.close()
  } catch (error) {
    try {
      if ('abort' in writable && typeof writable.abort === 'function') {
        await writable.abort()
      }
    } catch {
      // Preserve the primary write/close failure.
    }
    throw error
  }
}

export function createBlobOutputResult(input: {
  filename: string
  blob: Blob
  sha256?: string
}): BlobOutputResult {
  return {
    kind: 'blob',
    filename: input.filename,
    blob: input.blob,
    byteLength: input.blob.size,
    mimeType: input.blob.type || 'image/jpeg',
    ...(input.sha256 ? { sha256: input.sha256 } : {}),
  }
}

export function createMemoryFileBackedOutputResult(input: {
  exportId: string
  filename: string
  mimeType: string
  bytes: Uint8Array
}): FileBackedOutputResult {
  const bytes = new Uint8Array(input.bytes)
  const openBlob = async () => {
    const byteBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer
    const blob = new Blob([byteBuffer], { type: input.mimeType })
    if (typeof blob.arrayBuffer !== 'function') {
      Object.defineProperty(blob, 'arrayBuffer', {
        value: async () => byteBuffer.slice(0),
      })
    }
    return blob
  }

  return {
    kind: 'file-backed',
    exportId: input.exportId,
    filename: input.filename,
    byteLength: bytes.byteLength,
    mimeType: input.mimeType,
    openBlob,
  }
}

export async function createOpfsOutputWritable(input: {
  exportId: string
  outputFileName?: string
  storage?: OpfsStorage
}) {
  const exportDirectory = await getOpfsExportDirectory(
    input.exportId,
    input.storage,
  )
  const outputFileName = input.outputFileName ?? DEFAULT_OPFS_OUTPUT_FILE
  const tempFileName = `${outputFileName}${OPFS_OUTPUT_TEMP_SUFFIX}`
  const finalizedFileName = `${outputFileName}${OPFS_OUTPUT_FINALIZED_SUFFIX}`
  await removeOpfsEntryIfExists(exportDirectory, tempFileName)
  await removeOpfsEntryIfExists(exportDirectory, finalizedFileName)
  await removeOpfsEntryIfExists(exportDirectory, outputFileName)

  const fileHandle = await exportDirectory.getFileHandle(tempFileName, {
    create: true,
  })
  const writable = await fileHandle.createWritable()
  let state: 'open' | 'closed' | 'aborted' = 'open'

  async function removeUnfinalizedOutput() {
    await removeOpfsEntryIfExists(exportDirectory, tempFileName)
    await removeOpfsEntryIfExists(exportDirectory, finalizedFileName)
    await removeOpfsEntryIfExists(exportDirectory, outputFileName)
  }

  return {
    async write(chunk) {
      if (state !== 'open') throw new Error('OPFS_OUTPUT_WRITER_CLOSED')
      await writable.write(chunk)
    },
    async close() {
      if (state !== 'open') throw new Error('OPFS_OUTPUT_WRITER_CLOSED')
      try {
        await writable.close()
        const tempFile = await fileHandle.getFile()
        await writeOpfsFile(exportDirectory, outputFileName, tempFile)
        await writeOpfsFile(
          exportDirectory,
          finalizedFileName,
          JSON.stringify({
            version: 1,
            outputFileName,
            byteLength: tempFile.size,
            finalizedAt: new Date().toISOString(),
          }),
        )
        await removeOpfsEntryIfExists(exportDirectory, tempFileName)
        state = 'closed'
      } catch (error) {
        state = 'aborted'
        try {
          if ('abort' in writable && typeof writable.abort === 'function') {
            await writable.abort()
          }
        } catch {
          // Preserve the primary finalize failure.
        }
        try {
          await removeUnfinalizedOutput()
        } catch {
          // Preserve the primary finalize failure.
        }
        throw error
      }
    },
    async abort() {
      if (state === 'closed' || state === 'aborted') return
      state = 'aborted'
      try {
        if ('abort' in writable && typeof writable.abort === 'function') {
          await writable.abort()
        }
      } finally {
        await removeUnfinalizedOutput()
      }
    },
  } satisfies Pick<FileSystemWritableFileStream, 'write' | 'close' | 'abort'>
}

export function createOpfsFileBackedOutputResult(input: {
  exportId: string
  filename: string
  byteLength: number
  mimeType: string
  outputFileName?: string
  storage?: OpfsStorage
  sha256?: string
}): FileBackedOutputResult {
  const outputFileName = input.outputFileName ?? DEFAULT_OPFS_OUTPUT_FILE
  const tempFileName = `${outputFileName}${OPFS_OUTPUT_TEMP_SUFFIX}`
  const finalizedFileName = `${outputFileName}${OPFS_OUTPUT_FINALIZED_SUFFIX}`

  return {
    kind: 'file-backed',
    exportId: input.exportId,
    filename: input.filename,
    byteLength: input.byteLength,
    mimeType: input.mimeType,
    ...(input.sha256 ? { sha256: input.sha256 } : {}),
    async openBlob() {
      const exportDirectory = await getOpfsExportDirectory(
        input.exportId,
        input.storage,
      )
      await exportDirectory.getFileHandle(finalizedFileName)
      const fileHandle = await exportDirectory.getFileHandle(outputFileName)
      const file = await fileHandle.getFile()
      const bytes = await file.arrayBuffer()
      const blob = new Blob([bytes], { type: input.mimeType })
      if (typeof blob.arrayBuffer !== 'function') {
        Object.defineProperty(blob, 'arrayBuffer', {
          value: async () => bytes.slice(0),
        })
      }
      return blob
    },
    async cleanup() {
      const exportDirectory = await getOpfsExportDirectory(
        input.exportId,
        input.storage,
      )
      await removeOpfsEntryIfExists(exportDirectory, tempFileName)
      await removeOpfsEntryIfExists(exportDirectory, finalizedFileName)
      await removeOpfsEntryIfExists(exportDirectory, outputFileName)
    },
  }
}

export async function materializeOutputBlob(
  result: ExportOutputResult,
): Promise<Blob> {
  if (result.kind === 'blob') return result.blob
  if (result.kind === 'bytes') {
    return new Blob([result.bytes as BlobPart], { type: result.mimeType })
  }
  return result.openBlob()
}
