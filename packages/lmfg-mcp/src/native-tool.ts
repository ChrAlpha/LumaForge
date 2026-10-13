import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'

import type { SessionRecord } from '@lumaforge/lmfg-cli'
import { SessionRecordSchema, workspacePaths } from '@lumaforge/lmfg-cli'
import type { RenderManifest } from '@lumaforge/render-engine'
import { parseRenderManifest } from '@lumaforge/render-engine/manifest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

const MAX_RECORD_BYTES = 1024 * 1024

export async function assertCanonical(path: string): Promise<void> {
  if ((await realpath(path)) !== path)
    throw new Error(
      'Workspace paths must be canonical and contain no symlinks.',
    )
}

/**
 * Reads a regular file of at most `limit` bytes at a canonical path, opened
 * without following a symlink, and refuses it if it changes or is replaced
 * while it is read.
 */
export async function readCapturedFile(
  path: string,
  limit: number,
): Promise<Buffer> {
  await assertCanonical(path)
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > limit)
      throw new Error(
        `Workspace files must be regular files of at most ${limit} bytes.`,
      )
    const bytes = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    const after = await handle.stat()
    await assertCanonical(path)
    const current = await lstat(path)
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      current.isSymbolicLink()
    )
      throw new Error('Workspace file changed while it was being read.')
    return bytes.subarray(0, length)
  } finally {
    await handle.close()
  }
}

export async function readJsonRecord(path: string): Promise<unknown> {
  return JSON.parse(
    (await readCapturedFile(path, MAX_RECORD_BYTES)).toString('utf8'),
  )
}

/** A manifest that passes its seal over the whole file and the full v1 structure. */
export async function readSealedManifest(
  path: string,
): Promise<RenderManifest> {
  const parsed = parseRenderManifest(await readJsonRecord(path))
  if (parsed.ok) return parsed.manifest
  if (parsed.issues.some((issue) => issue.path === 'manifest_sha256'))
    throw new Error('Manifest canonical hash does not match its full content.')
  throw new Error(
    `Manifest is not a valid render manifest: ${parsed.issues
      .map((issue) => `${issue.path} ${issue.message}`)
      .join(' ')}`,
  )
}

export async function loadSession(
  root: string,
  session: string,
): Promise<SessionRecord> {
  const record = SessionRecordSchema.parse(
    await readJsonRecord(workspacePaths.sessionFile(root, session)),
  )
  if (record.id !== session)
    throw new Error(
      'Session record identity does not match the requested session.',
    )
  return record
}

export function nativeResult(
  schema: string,
  result: Record<string, unknown>,
  image: { mimeType: string; bytes: Buffer },
): CallToolResult {
  const structured = { schema, ok: true, result }
  return {
    content: [
      { type: 'text', text: JSON.stringify(structured) },
      {
        type: 'image',
        mimeType: image.mimeType,
        data: image.bytes.toString('base64'),
      },
    ],
    structuredContent: structured,
    isError: false,
  }
}

export function nativeError(
  code: string,
  error: unknown,
  fallback: string,
): CallToolResult {
  const structured = {
    schema: 'lmfg.error.v1',
    ok: false,
    error: { code, message: error instanceof Error ? error.message : fallback },
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError: true,
  }
}
