import type { z } from 'zod'

import type { LmfgErrorCode } from '../protocol/errors'
import { LmfgError } from '../protocol/errors'
import { readJson, readJsonOrNull } from './atomic-fs'

export type StoredRecordIssue = {
  /** Dotted path of the offending field; empty for the whole record. */
  path: string
  message: string
  /** The schema issue code, when a schema check found the issue. */
  code?: string
}

/**
 * A workspace file that does not hold the record its reader expects. The
 * error names the file and every offending field, so a damaged or foreign
 * record is reported as that file, not as invalid command input.
 */
export function storedRecordError(
  recordPath: string,
  issues: readonly StoredRecordIssue[],
  code: LmfgErrorCode = 'schema.invalid',
): LmfgError {
  const summary = issues
    .map((issue) => `${issue.path || '(root)'}: ${issue.message}`)
    .join('; ')
  return new LmfgError(code, {
    message: `Stored workspace record ${recordPath} is invalid: ${summary}`,
    details: { record_path: recordPath, issues: [...issues] },
  })
}

/** Hold a value read from `recordPath` to its schema; nothing is coerced. */
export function parseStoredRecord<S extends z.ZodType>(
  recordPath: string,
  schema: S,
  value: unknown,
): z.output<S> {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  throw storedRecordError(
    recordPath,
    parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
      code: issue.code,
    })),
  )
}

/** Read and validate a JSON record; a missing file is `file.not_found`. */
export async function readStoredRecord<S extends z.ZodType>(
  recordPath: string,
  schema: S,
): Promise<z.output<S>> {
  return parseStoredRecord(recordPath, schema, await readJson(recordPath))
}

/** Read and validate a JSON record; a missing file reads as `null`. */
export async function readStoredRecordOrNull<S extends z.ZodType>(
  recordPath: string,
  schema: S,
): Promise<z.output<S> | null> {
  const raw = await readJsonOrNull(recordPath)
  return raw === null ? null : parseStoredRecord(recordPath, schema, raw)
}
