import { randomBytes } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { open, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'

import type {
  JpegExportMetadata,
  JpegMetadataInjectionPlan,
} from '@lumaforge/render-engine/export'
import {
  JPEG_HEADER_SCAN_BYTES,
  planJpegMetadataInjection,
} from '@lumaforge/render-engine/export'
import { createStreamingSha256 } from '@lumaforge/render-engine/manifest'

import type { CleanupFailure } from '../protocol/errors'
import {
  attemptCleanup,
  LmfgError,
  withCleanupFailures,
} from '../protocol/errors'
import { ensureDir, renameWithRetry } from '../workspace/atomic-fs'

export type StreamedJpegFile = {
  /** Final path the file will occupy after `commit()`. */
  path: string
  tmpPath: string
  byteLength: number
  sha256: string
  /**
   * Rename the validated temp file into place (replaces an existing file). A
   * failed rename drops the temp file and publishes nothing; once the file
   * was dropped, commit rejects instead of reporting a publication.
   */
  commit: () => Promise<void>
  /**
   * Remove the temp file without publishing. Rejects when it could not be
   * removed; calling it again retries.
   */
  discard: () => Promise<void>
}

export type StreamingJpegFileWriter = {
  write: (bytes: Uint8Array) => Promise<void>
  finish: () => Promise<StreamedJpegFile>
  /** Drop the partial file; resolves the cleanup steps that failed. */
  abort: () => Promise<CleanupFailure[]>
}

/**
 * Refuse anything that is not a complete SOI…EOI stream without reading the
 * whole file. A refusal keeps its code when closing the file fails too.
 */
export async function assertJpegFile(path: string): Promise<void> {
  let handle: FileHandle | null = null
  let failure: { error: unknown } | null = null
  try {
    handle = await open(path, 'r')
    const { size } = await handle.stat()
    const head = new Uint8Array(2)
    const tail = new Uint8Array(2)
    if (size >= 4) {
      await handle.read(head, 0, 2, 0)
      await handle.read(tail, 0, 2, size - 2)
    }
    const ok =
      size >= 4 &&
      head[0] === 0xFF &&
      head[1] === 0xD8 &&
      tail[0] === 0xFF &&
      tail[1] === 0xD9
    if (!ok) {
      throw new LmfgError('export.refused', {
        message:
          'The export produced an incomplete JPEG stream; refusing to keep it.',
        retryable: true,
      })
    }
  } catch (error) {
    failure = { error }
  }
  const opened = handle
  if (!failure) {
    await opened?.close()
    return
  }
  const failures: CleanupFailure[] = []
  if (opened) {
    await attemptCleanup(failures, 'close_temp_file', () => opened.close())
  }
  throw withCleanupFailures(failure.error, failures)
}

/**
 * Streams encoder chunks to `<path>.<pid>.<rand>.tmp`, inserting the EXIF
 * segment that `preserveJpegMetadataBytes` would insert and hashing the
 * delivered layout on the way. `finish()` validates the temp file and hands
 * back `commit()` so callers publish only after their own checks (manifest
 * verification) pass; an existing file at `path` is never touched before
 * that. Only the leading 64 KiB are ever buffered, so export memory no
 * longer scales with the JPEG.
 */
export function createStreamingJpegFileWriter(input: {
  path: string
  metadata?: JpegExportMetadata | null
  width: number
  height: number
}): StreamingJpegFileWriter {
  const tmp = `${input.path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const hasher = createStreamingSha256()
  let handle: FileHandle | null = null
  let head: Uint8Array[] = []
  let headLength = 0
  let planned = false
  let byteLength = 0
  let created = false
  let state: 'open' | 'finished' | 'aborted' = 'open'

  async function ensureHandle(): Promise<FileHandle> {
    if (!handle) {
      await ensureDir(dirname(input.path))
      handle = await open(tmp, 'w')
      created = true
    }
    return handle
  }

  async function writeHashed(bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength === 0) return
    const target = await ensureHandle()
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await target.write(
        bytes,
        offset,
        bytes.byteLength - offset,
      )
      offset += bytesWritten
    }
    hasher.update(bytes)
    byteLength += bytes.byteLength
  }

  async function flushHead(): Promise<void> {
    if (planned) return
    planned = true
    const header = new Uint8Array(headLength)
    let offset = 0
    for (const part of head) {
      header.set(part, offset)
      offset += part.byteLength
    }
    head = []
    const plan: JpegMetadataInjectionPlan | null = planJpegMetadataInjection({
      header: header.subarray(
        0,
        Math.min(header.byteLength, JPEG_HEADER_SCAN_BYTES),
      ),
      fullSize: header.byteLength,
      metadata: input.metadata,
      width: input.width,
      height: input.height,
    })
    if (!plan) {
      await writeHashed(header)
      return
    }
    await writeHashed(header.subarray(0, plan.insertionOffset))
    await writeHashed(plan.segment)
    await writeHashed(header.subarray(plan.insertionOffset))
  }

  /** Closes and removes the partial file, recording the steps that fail. */
  async function dropTemp(failures: CleanupFailure[]): Promise<void> {
    const opened = handle
    handle = null
    if (opened) {
      await attemptCleanup(failures, 'close_temp_file', () => opened.close())
    }
    if (created) {
      await attemptCleanup(failures, 'remove_temp_file', () =>
        rm(tmp, { force: true }),
      )
    }
  }

  return {
    async write(bytes) {
      if (state !== 'open') throw new Error('JPEG_FILE_WRITER_CLOSED')
      if (planned) {
        await writeHashed(bytes)
        return
      }
      // Copy: the encoder may reuse its chunk buffer after the callback.
      head.push(new Uint8Array(bytes))
      headLength += bytes.byteLength
      if (headLength >= JPEG_HEADER_SCAN_BYTES) await flushHead()
    },
    async finish() {
      if (state !== 'open') throw new Error('JPEG_FILE_WRITER_CLOSED')
      try {
        await flushHead()
        const target = await ensureHandle()
        // A failed close is not retried: the descriptor is gone either way.
        handle = null
        await target.close()
        // Validate the temp file; the final path is untouched until commit().
        await assertJpegFile(tmp)
        state = 'finished'
      } catch (error) {
        state = 'aborted'
        const failures: CleanupFailure[] = []
        await dropTemp(failures)
        throw withCleanupFailures(error, failures)
      }
      let published = false
      let discarded = false
      return {
        path: input.path,
        tmpPath: tmp,
        byteLength,
        sha256: hasher.digestHex(),
        async commit() {
          if (published) return
          if (discarded) {
            throw new LmfgError('export.refused', {
              message: 'The export was discarded; nothing was published.',
            })
          }
          try {
            await renameWithRetry(tmp, input.path)
          } catch (error) {
            discarded = true
            const failures: CleanupFailure[] = []
            await attemptCleanup(failures, 'remove_temp_file', () =>
              rm(tmp, { force: true }),
            )
            throw withCleanupFailures(error, failures)
          }
          published = true
        },
        async discard() {
          if (published) return
          discarded = true
          await rm(tmp, { force: true })
        },
      }
    },
    async abort() {
      if (state !== 'open') return []
      state = 'aborted'
      const failures: CleanupFailure[] = []
      await dropTemp(failures)
      return failures
    },
  }
}
