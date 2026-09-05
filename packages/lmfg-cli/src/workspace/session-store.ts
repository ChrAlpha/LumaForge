import { basename } from 'node:path'

import { LmfgError } from '../protocol/errors'
import type { SessionRecord } from '../schemas/results'
import { SessionRecordSchema } from '../schemas/results'
import {
  ensureDir,
  fileExists,
  listDirs,
  readJson,
  writeJsonAtomic,
} from './atomic-fs'
import { createSessionId } from './ids'
import { workspacePaths } from './paths'

export type SessionInitInput = {
  sourcePath: string
  sha256: string
  byteSize: number
  now?: Date
  random?: () => string
}

export type SessionCounter = 'previews' | 'iterations' | 'exports'

export type SessionStore = {
  readonly root: string
  init: (input: SessionInitInput) => Promise<SessionRecord>
  load: (id: string) => Promise<SessionRecord>
  list: () => Promise<SessionRecord[]>
  update: (
    id: string,
    patch: (record: SessionRecord) => SessionRecord,
  ) => Promise<SessionRecord>
  allocate: (id: string, counter: SessionCounter) => Promise<number>
}

export function createSessionStore(root: string): SessionStore {
  async function load(id: string): Promise<SessionRecord> {
    const file = workspacePaths.sessionFile(root, id)
    if (!(await fileExists(file))) {
      throw new LmfgError('session.not_found', {
        message: `Session "${id}" was not found under ${root}.`,
        suggestedNextActions: ['lmfg session list'],
      })
    }
    return SessionRecordSchema.parse(await readJson(file))
  }

  async function write(record: SessionRecord): Promise<void> {
    await writeJsonAtomic(workspacePaths.sessionFile(root, record.id), record)
  }

  return {
    root,
    async init(input) {
      const now = input.now ?? new Date()
      const id = createSessionId(now, input.random)
      const record: SessionRecord = {
        schema: 'lmfg.session.v1',
        id,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        workspace_root: root,
        source: {
          path: input.sourcePath,
          filename: basename(input.sourcePath),
          byte_size: input.byteSize,
          sha256: input.sha256,
        },
        decoded_dimensions: null,
        counters: { previews: 0, iterations: 0, exports: 0 },
        status: 'initialized',
      }
      await ensureDir(workspacePaths.source(root, id))
      await ensureDir(workspacePaths.previews(root, id))
      await ensureDir(workspacePaths.iterations(root, id))
      await ensureDir(workspacePaths.exports(root, id))
      await writeJsonAtomic(workspacePaths.sourceIdentityFile(root, id), {
        schema: 'lmfg.source-identity.v1',
        ...record.source,
      })
      await write(record)
      return record
    },
    load,
    async list() {
      const ids = await listDirs(workspacePaths.sessions(root))
      const records: SessionRecord[] = []
      for (const id of ids) {
        if (await fileExists(workspacePaths.sessionFile(root, id)))
          records.push(await load(id))
      }
      return records.sort((a, b) => a.created_at.localeCompare(b.created_at))
    },
    async update(id, patch) {
      const next = {
        ...patch(await load(id)),
        updated_at: new Date().toISOString(),
      }
      await write(next)
      return next
    },
    async allocate(id, counter) {
      const record = await load(id)
      const value = record.counters[counter] + 1
      await write({
        ...record,
        counters: { ...record.counters, [counter]: value },
        updated_at: new Date().toISOString(),
      })
      return value
    },
  }
}
