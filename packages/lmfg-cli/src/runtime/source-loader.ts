import { readFile, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import type { LumaRawNodeSourceInput } from '@lumaforge/luma-raw-runtime/node'
import { sourceContentIdFromBytes } from '@lumaforge/render-engine'

import { LmfgError } from '../protocol/errors'
import type { SessionRecord } from '../schemas/results'

export type LoadedSource = {
  absolutePath: string
  filename: string
  bytes: Uint8Array
  byteSize: number
  sha256: string
  input: LumaRawNodeSourceInput
}

export async function loadSourceFile(
  path: string,
  cwd: string,
): Promise<LoadedSource> {
  const absolutePath = resolve(cwd, path)
  let info
  try {
    info = await stat(absolutePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new LmfgError('file.not_found', {
        message: `Source file not found: ${absolutePath}`,
      })
    }
    throw error
  }
  if (!info.isFile()) {
    throw new LmfgError('args.invalid', {
      message: `Source path is not a file: ${absolutePath}`,
    })
  }
  const buffer = await readFile(absolutePath)
  const bytes = new Uint8Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  )
  const identity = await sourceContentIdFromBytes(bytes)
  const filename = basename(absolutePath)
  return {
    absolutePath,
    filename,
    bytes,
    byteSize: identity.byteSize,
    sha256: identity.sha256,
    input: { data: bytes, name: filename, size: identity.byteSize },
  }
}

export function verifySourceIdentity(
  source: LoadedSource,
  expectedSha256: string,
): void {
  if (source.sha256 === expectedSha256) return
  throw new LmfgError('hash.mismatch', {
    message: `Source bytes changed since the session was created (expected sha256 ${expectedSha256.slice(0, 12)}…, got ${source.sha256.slice(0, 12)}…).`,
    suggestedNextActions: [`lmfg session init --source ${source.absolutePath}`],
    details: { expected_sha256: expectedSha256, actual_sha256: source.sha256 },
  })
}

export async function loadSessionSource(
  session: Pick<SessionRecord, 'source'>,
): Promise<LoadedSource> {
  const source = await loadSourceFile(session.source.path, '/')
  verifySourceIdentity(source, session.source.sha256)
  return source
}
