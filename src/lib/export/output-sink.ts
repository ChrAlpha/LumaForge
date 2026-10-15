import type {
  FileBackedOutputResult,
  JpegExportMetadata,
} from '@lumaforge/render-engine/export'
import { sha256Hex } from '@lumaforge/render-engine/manifest'

type OpfsStorage = Pick<StorageManager, 'getDirectory'>

export const OPFS_EXPORTS_DIRECTORY = '.lumaforge-exports'
export const OPFS_ACTIVE_DIRECTORY = 'active'
const DEFAULT_OPFS_OUTPUT_FILE = 'output.jpg'
const OPFS_OUTPUT_TEMP_SUFFIX = '.tmp'
export const OPFS_OUTPUT_FINALIZED_SUFFIX = '.finalized.json'

/**
 * An OPFS output lives at `active/<tabDirectory>/<exportId>/`. The tab
 * directory belongs to the page that reserved the output, so another tab can
 * tell whether its owner is still alive before collecting it.
 */
export type OpfsOutputAddress = {
  tabDirectory: string
  exportId: string
}

function getDefaultOpfsStorage(): OpfsStorage {
  const storage = globalThis.navigator?.storage
  if (!storage?.getDirectory) {
    throw new Error('OPFS_OUTPUT_STORAGE_UNAVAILABLE')
  }

  return storage
}

async function getOpfsExportDirectory(
  address: OpfsOutputAddress,
  storage: OpfsStorage = getDefaultOpfsStorage(),
) {
  const root = await storage.getDirectory()
  const exportsDirectory = await root.getDirectoryHandle(
    OPFS_EXPORTS_DIRECTORY,
    { create: true },
  )
  const activeDirectory = await exportsDirectory.getDirectoryHandle(
    OPFS_ACTIVE_DIRECTORY,
    { create: true },
  )
  const tabDirectory = await activeDirectory.getDirectoryHandle(
    address.tabDirectory,
    { create: true },
  )

  return tabDirectory.getDirectoryHandle(address.exportId, { create: true })
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
  data: Blob | Uint8Array<ArrayBuffer> | string,
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

/** Identity of the bytes published by `createOpfsOutputWritable().close()`. */
export type OpfsFinalizedOutput = {
  byteLength: number
  sha256: string
}

export type OpfsFinalizeOptions = {
  /**
   * Hash of the bytes as they will be delivered. Defaults to the SHA-256 of
   * the published file; producers that inject metadata lazily on delivery
   * hash the delivered layout instead.
   */
  hash?: (bytes: Uint8Array) => string
}

export async function createOpfsOutputWritable(
  input: OpfsOutputAddress & {
    outputFileName?: string
    storage?: OpfsStorage
  },
) {
  const exportDirectory = await getOpfsExportDirectory(input, input.storage)
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
    async close(options: OpfsFinalizeOptions = {}) {
      if (state !== 'open') throw new Error('OPFS_OUTPUT_WRITER_CLOSED')
      try {
        await writable.close()
        const tempFile = await fileHandle.getFile()
        // The publish step already loads the finalized bytes once; hashing
        // them here records the output identity without a second read.
        const bytes = new Uint8Array(await tempFile.arrayBuffer())
        const sha256 = (options.hash ?? sha256Hex)(bytes)
        await writeOpfsFile(exportDirectory, outputFileName, bytes)
        await writeOpfsFile(
          exportDirectory,
          finalizedFileName,
          JSON.stringify({
            version: 1,
            outputFileName,
            byteLength: bytes.byteLength,
            sha256,
            finalizedAt: new Date().toISOString(),
          }),
        )
        await removeOpfsEntryIfExists(exportDirectory, tempFileName)
        state = 'closed'
        return { byteLength: bytes.byteLength, sha256 }
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
  } satisfies Pick<FileSystemWritableFileStream, 'write' | 'abort'> & {
    close: (options?: OpfsFinalizeOptions) => Promise<OpfsFinalizedOutput>
  }
}

export function createOpfsFileBackedOutputResult(
  input: OpfsOutputAddress & {
    filename: string
    byteLength: number
    mimeType: string
    outputFileName?: string
    storage?: OpfsStorage
    sha256?: string
    deliveryMetadata?: JpegExportMetadata | null
  },
): FileBackedOutputResult {
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
    ...(input.deliveryMetadata !== undefined
      ? { deliveryMetadata: input.deliveryMetadata }
      : {}),
    async openBlob() {
      const exportDirectory = await getOpfsExportDirectory(input, input.storage)
      await exportDirectory.getFileHandle(finalizedFileName)
      const fileHandle = await exportDirectory.getFileHandle(outputFileName)
      const file = await fileHandle.getFile()
      const bytes = await file.arrayBuffer()
      const blob = new Blob([bytes], { type: input.mimeType })
      return blob
    },
    async cleanup() {
      const exportDirectory = await getOpfsExportDirectory(input, input.storage)
      await removeOpfsEntryIfExists(exportDirectory, tempFileName)
      await removeOpfsEntryIfExists(exportDirectory, finalizedFileName)
      await removeOpfsEntryIfExists(exportDirectory, outputFileName)
    },
  }
}
