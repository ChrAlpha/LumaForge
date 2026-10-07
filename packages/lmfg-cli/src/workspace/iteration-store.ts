import { readFile } from 'node:fs/promises'

import type { RenderManifest } from '@lumaforge/render-engine'
import { parseRenderManifest } from '@lumaforge/render-engine/manifest'
import { z } from 'zod'

import { LmfgError } from '../protocol/errors'
import type { RenderParams } from '../schemas/params'
import { RenderParamsSchema } from '../schemas/params'
import type {
  ContactSheetMap,
  IterationRecord,
  Metrics,
} from '../schemas/results'
import {
  ContactSheetMapSchema,
  IterationRecordSchema,
  MetricsSchema,
} from '../schemas/results'
import {
  appendLine,
  ensureDir,
  fileExists,
  listDirs,
  readJson,
  readJsonOrNull,
  writeFileAtomic,
  writeJsonAtomic,
} from './atomic-fs'
import { workspacePaths } from './paths'
import {
  parseStoredRecord,
  readStoredRecord,
  readStoredRecordOrNull,
  storedRecordError,
} from './record-validation'

export type { ContactSheetMap, IterationRecord }

export type CandidateTile = {
  rgba: Uint8ClampedArray
  width: number
  height: number
}

export type CandidateArtifacts = {
  previewJpeg: Uint8Array
  manifest: RenderManifest
  metrics: Metrics
  tile: CandidateTile
  params: RenderParams
}

const RGBA8_BYTES_PER_PIXEL = 4

/** `candidates/<id>/tile.json`, written beside the raw `tile.rgba` bytes. */
const CandidateTileMetaSchema = z
  .object({
    schema: z.literal('lmfg.tile.v1'),
    format: z.literal('rgba8'),
    width: z.int().positive(),
    height: z.int().positive(),
    byte_length: z.int().positive(),
  })
  .refine(
    (meta) =>
      meta.byte_length === meta.width * meta.height * RGBA8_BYTES_PER_PIXEL,
    {
      path: ['byte_length'],
      message: 'Expected width * height * 4 bytes for rgba8.',
    },
  )
type CandidateTileMeta = z.output<typeof CandidateTileMetaSchema>

export type CandidatePaths = {
  dir: string
  preview: string
  manifest: string
  metrics: string
  params: string
  tile: string
  tileMeta: string
}

export function createIterationStore(root: string, sessionId: string) {
  const p = workspacePaths
  function candidatePaths(
    iterationId: string,
    candidateId: string,
  ): CandidatePaths {
    return {
      dir: p.candidate(root, sessionId, iterationId, candidateId),
      preview: p.candidatePreviewFile(
        root,
        sessionId,
        iterationId,
        candidateId,
      ),
      manifest: p.candidateManifestFile(
        root,
        sessionId,
        iterationId,
        candidateId,
      ),
      metrics: p.candidateMetricsFile(
        root,
        sessionId,
        iterationId,
        candidateId,
      ),
      params: p.candidateParamsFile(root, sessionId, iterationId, candidateId),
      tile: p.candidateTileFile(root, sessionId, iterationId, candidateId),
      tileMeta: p.candidateTileMetaFile(
        root,
        sessionId,
        iterationId,
        candidateId,
      ),
    }
  }

  async function read(iterationId: string): Promise<IterationRecord> {
    const file = p.iterationPlanFile(root, sessionId, iterationId)
    if (!(await fileExists(file))) {
      throw new LmfgError('iteration.not_found', {
        message: `Iteration "${iterationId}" was not found in session ${sessionId}.`,
        suggestedNextActions: [`lmfg session status --session ${sessionId}`],
      })
    }
    return readStoredRecord(file, IterationRecordSchema)
  }

  return {
    candidatePaths,
    async create(record: IterationRecord): Promise<string> {
      const dir = p.iteration(root, sessionId, record.id)
      await ensureDir(p.candidates(root, sessionId, record.id))
      await writeJsonAtomic(
        p.iterationPlanFile(root, sessionId, record.id),
        record,
      )
      return dir
    },
    read,
    async appendEvent(
      iterationId: string,
      event: Record<string, unknown>,
    ): Promise<void> {
      await appendLine(
        p.iterationEventsFile(root, sessionId, iterationId),
        JSON.stringify({ ...event, schema: 'lmfg.event.v1' }),
      )
    },
    async writeCandidate(
      iterationId: string,
      candidateId: string,
      artifacts: CandidateArtifacts,
    ): Promise<CandidatePaths> {
      const paths = candidatePaths(iterationId, candidateId)
      await ensureDir(paths.dir)
      await writeFileAtomic(paths.preview, artifacts.previewJpeg)
      await writeJsonAtomic(paths.manifest, artifacts.manifest)
      await writeJsonAtomic(paths.metrics, artifacts.metrics)
      await writeJsonAtomic(paths.params, {
        schema: 'lmfg.params.v1',
        ...artifacts.params,
      })
      await writeFileAtomic(
        paths.tile,
        new Uint8Array(
          artifacts.tile.rgba.buffer,
          artifacts.tile.rgba.byteOffset,
          artifacts.tile.rgba.byteLength,
        ),
      )
      await writeJsonAtomic(paths.tileMeta, {
        schema: 'lmfg.tile.v1',
        format: 'rgba8',
        width: artifacts.tile.width,
        height: artifacts.tile.height,
        byte_length: artifacts.tile.rgba.byteLength,
      } satisfies CandidateTileMeta)
      return paths
    },
    async listCandidates(iterationId: string): Promise<string[]> {
      return listDirs(p.candidates(root, sessionId, iterationId))
    },
    async readCandidateTile(
      iterationId: string,
      candidateId: string,
    ): Promise<CandidateTile> {
      const paths = candidatePaths(iterationId, candidateId)
      const rawMeta = await readJsonOrNull(paths.tileMeta)
      if (rawMeta === null || !(await fileExists(paths.tile))) {
        throw new LmfgError('candidate.not_found', {
          message: `Candidate "${candidateId}" has no tile in ${iterationId}.`,
        })
      }
      const meta = parseStoredRecord(
        paths.tileMeta,
        CandidateTileMetaSchema,
        rawMeta,
      )
      const bytes = await readFile(paths.tile)
      if (bytes.byteLength !== meta.byte_length) {
        throw storedRecordError(paths.tile, [
          {
            path: 'byte_length',
            message: `Expected ${meta.byte_length} bytes as declared in ${paths.tileMeta}, found ${bytes.byteLength}.`,
          },
        ])
      }
      return {
        rgba: new Uint8ClampedArray(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        ),
        width: meta.width,
        height: meta.height,
      }
    },
    async readCandidateMetrics(
      iterationId: string,
      candidateId: string,
    ): Promise<Metrics | null> {
      return readStoredRecordOrNull(
        candidatePaths(iterationId, candidateId).metrics,
        MetricsSchema,
      )
    },
    async readCandidateManifest(
      iterationId: string,
      candidateId: string,
    ): Promise<RenderManifest> {
      const paths = candidatePaths(iterationId, candidateId)
      if (!(await fileExists(paths.manifest))) {
        throw new LmfgError('candidate.not_found', {
          message: `Candidate "${candidateId}" was not found in ${iterationId}.`,
          suggestedNextActions: [`lmfg session status --session ${sessionId}`],
        })
      }
      const parsed = parseRenderManifest(await readJson(paths.manifest))
      if (!parsed.ok) {
        throw storedRecordError(
          paths.manifest,
          parsed.issues,
          'manifest.invalid',
        )
      }
      return parsed.manifest
    },
    async readCandidateParams(
      iterationId: string,
      candidateId: string,
    ): Promise<RenderParams> {
      return readStoredRecord(
        candidatePaths(iterationId, candidateId).params,
        RenderParamsSchema,
      )
    },
    async writeContactSheet(
      iterationId: string,
      input: { jpeg: Uint8Array; map: ContactSheetMap; name?: string },
    ): Promise<{ sheet: string; map: string }> {
      ContactSheetMapSchema.parse(input.map)
      const sheet = p.contactSheetFile(root, sessionId, iterationId, input.name)
      const map = p.contactSheetMapFile(
        root,
        sessionId,
        iterationId,
        input.name,
      )
      await writeFileAtomic(sheet, input.jpeg)
      await writeJsonAtomic(map, input.map)
      return { sheet, map }
    },
  }
}

export type IterationStore = ReturnType<typeof createIterationStore>
