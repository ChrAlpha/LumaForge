import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { RenderManifest } from '@lumaforge/render-engine/manifest'
import {
  canonicalizeJson,
  sealRenderManifest,
} from '@lumaforge/render-engine/manifest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { finishTool, verifyCompletion } from './completion.js'

// One white pixel encoded by the shipped native JPEG runtime.
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAABAAEDAREAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD7LoA//9k=',
  'base64',
)
const hash = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex')
const args = {
  session: 'sess_test',
  iteration: 'iter_0001',
  candidate: 'cand_0001',
  export_name: 'final',
  rationale: 'Keep the quiet, neutral treatment.',
  observations: 'The light area retains detail.',
}
type Context = Parameters<typeof verifyCompletion>[1]
let dir: string
let candidatePath: string
let exportPath: string
let outputPath: string
let previewPath: string
let candidate: RenderManifest
let exported: RenderManifest
let context: Context

async function writeJson(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value))
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lmfg-completion-'))
  const workspace = join(dir, '.lmfg')
  const sessionDir = join(workspace, 'sessions', args.session)
  const candidateDir = join(
    sessionDir,
    'iterations',
    args.iteration,
    'candidates',
    args.candidate,
  )
  await mkdir(candidateDir, { recursive: true })
  await mkdir(join(sessionDir, 'exports'), { recursive: true })
  candidatePath = join(candidateDir, 'manifest.json')
  previewPath = join(candidateDir, 'preview.jpg')
  exportPath = join(sessionDir, 'exports', 'final.manifest.json')
  outputPath = join(sessionDir, 'exports', 'final.jpg')
  const sourcePath = join(dir, 'source.dng')
  await writeFile(sourcePath, 'raw fixture source identity')
  const source = {
    sha256: hash('raw fixture source identity'),
    byte_size: 27,
    filename: 'source.dng',
    decoded_dimensions: { width: 1, height: 1 },
  }
  candidate = sealRenderManifest({
    manifest_version: 1,
    kind: 'candidate',
    produced_at: '2026-09-06T00:00:00Z',
    parent_manifest_sha256: null,
    source_raw: source,
    calibration: null,
    lut: null,
    color_graph: {
      fingerprint: hash(
        canonicalizeJson({ descriptor_version: 2, exposure: 0 }),
      ),
      descriptor: { descriptor_version: 2, exposure: 0 },
    },
    render_params: {
      exposure_ev: 0,
      raw_render_exposure_ev: 0,
      raw_render_exposure_source: 'identity',
    },
    policy: {
      kind: 'preview-quick',
      row_slice: 32,
      concurrency: 1,
      max_pixels: 1,
    },
    environment: {
      render_engine: '1',
      luma_color_runtime: '1',
      luma_raw_runtime: '1',
      luma_jpeg_runtime: '1',
      native_artifacts: { build_id: 'test', variant: 'desktop' },
    },
    output: {
      format: 'jpeg',
      dimensions: { width: 1, height: 1 },
      color_space: 'srgb',
      quality: 85,
      filename: 'preview.jpg',
      sha256: hash(JPEG),
    },
  })
  exported = sealRenderManifest({
    ...candidate,
    kind: 'export',
    parent_manifest_sha256: candidate.manifest_sha256,
    policy: { kind: 'export-full', row_slice: 512, concurrency: 1 },
    output: { ...candidate.output, filename: 'final.jpg', quality: 92 },
  })
  await writeJson(candidatePath, candidate)
  await writeJson(exportPath, exported)
  await writeFile(previewPath, JPEG)
  await writeFile(outputPath, JPEG)
  await writeJson(join(sessionDir, 'session.json'), {
    schema: 'lmfg.session.v1',
    id: args.session,
    source: { ...source, path: sourcePath },
    decoded_dimensions: source.decoded_dimensions,
  })
  context = {
    workspace,
    sourcePath,
    step: 4,
    images: [
      {
        step: 2,
        result: {
          session_id: args.session,
          artifact: {
            kind: 'candidate',
            iteration_id: args.iteration,
            candidate_id: args.candidate,
          },
          source_sha256: source.sha256,
          manifest_sha256: candidate.manifest_sha256,
          uri: pathToFileURL(previewPath).href,
          sha256: hash(JPEG),
          width: 1,
          height: 1,
          byte_size: JPEG.length,
        },
      },
    ],
    replay: vi.fn(async () => ({
      reproduced: true,
      expected_sha256: hash(JPEG),
      actual_sha256: hash(JPEG),
      fingerprint_match: true,
      output: { sha256: hash(JPEG), width: 1, height: 1 },
    })),
  }
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('finish_edit completion evidence', () => {
  it('accepts only an observed candidate with a verified full-resolution export and replay', async () => {
    expect(finishTool.function.name).toBe('finish_edit')
    expect(finishTool.function.parameters.required).toEqual(Object.keys(args))
    const result = await verifyCompletion(args, context)
    expect(result).toMatchObject({
      verified: true,
      session: args.session,
      candidate: args.candidate,
      export_manifest_sha256: exported.manifest_sha256,
      output_sha256: hash(JPEG),
      observed_step: 2,
    })
    expect(context.replay).toHaveBeenCalledWith(exportPath, args.session)
  })

  it.each(['session', 'iteration', 'candidate', 'export_name'])(
    'rejects path traversal in %s',
    async (key) => {
      await expect(
        verifyCompletion({ ...args, [key]: '../outside' }, context),
      ).rejects.toThrow()
      expect(context.replay).not.toHaveBeenCalled()
    },
  )

  it('requires an individually delivered candidate from an earlier model step', async () => {
    for (const images of [
      [],
      [{ ...context.images[0], step: context.step }],
      [
        {
          ...context.images[0],
          result: {
            ...context.images[0].result,
            artifact: { kind: 'contact-sheet', iteration_id: args.iteration },
            tiles: [{ candidate_id: args.candidate }],
          },
        },
      ],
    ]) {
      await expect(
        verifyCompletion(args, { ...context, images }),
      ).rejects.toThrow(/observed|viewed/i)
    }
    expect(context.replay).not.toHaveBeenCalled()
  })

  it.each(['source_sha256', 'manifest_sha256', 'sha256', 'uri'])(
    'rejects forged image %s',
    async (field) => {
      context.images[0].result[field] = 'forged'
      await expect(verifyCompletion(args, context)).rejects.toThrow(
        /observed|viewed/i,
      )
      expect(context.replay).not.toHaveBeenCalled()
    },
  )

  it('rejects an unsealed candidate mutation', async () => {
    await writeJson(candidatePath, {
      ...candidate,
      render_params: { exposure_ev: 3 },
    })
    await expect(verifyCompletion(args, context)).rejects.toThrow(
      /manifest.*hash/i,
    )
  })

  it.each(['parent', 'graph', 'params', 'lut'])(
    'rejects export %s drift despite a valid seal',
    async (change) => {
      const patch =
        change === 'parent'
          ? { parent_manifest_sha256: 'f'.repeat(64) }
          : change === 'graph'
            ? {
                color_graph: {
                  ...exported.color_graph,
                  fingerprint: 'f'.repeat(64),
                },
              }
            : change === 'params'
              ? { render_params: { ...exported.render_params, exposure_ev: 3 } }
              : {
                  lut: {
                    kind: 'local-file' as const,
                    filename: 'look.cube',
                    sha256: 'f'.repeat(64),
                    input_contract: {
                      gamut: 'srgb-rec709',
                      transfer: 'srgb',
                      range: 'full' as const,
                    },
                    output_contract: {
                      gamut: 'srgb-rec709',
                      transfer: 'srgb',
                      range: 'full' as const,
                    },
                  },
                }
      await writeJson(exportPath, sealRenderManifest({ ...exported, ...patch }))
      await expect(verifyCompletion(args, context)).rejects.toThrow(
        /candidate|parent|graph|params|lut/i,
      )
      expect(context.replay).not.toHaveBeenCalled()
    },
  )

  it('rejects changed input RAW bytes', async () => {
    await writeFile(context.sourcePath, 'different source')
    await expect(verifyCompletion(args, context)).rejects.toThrow(/source/i)
  })

  it('rejects corrupted JPEG bytes', async () => {
    await writeFile(outputPath, Buffer.concat([JPEG, Buffer.from([0])]))
    await expect(verifyCompletion(args, context)).rejects.toThrow(
      /JPEG|output|hash/i,
    )
  })

  it('explains portrait source dimension disagreement without weakening the gate', async () => {
    await writeJson(
      candidatePath,
      sealRenderManifest({
        ...candidate,
        source_raw: {
          ...candidate.source_raw,
          decoded_dimensions: { width: 8280, height: 5520 },
        },
      }),
    )
    await writeJson(
      exportPath,
      sealRenderManifest({
        ...exported,
        source_raw: {
          ...exported.source_raw,
          decoded_dimensions: { width: 5520, height: 8280 },
        },
      }),
    )
    const error = await verifyCompletion(args, context).catch(
      (failure: Error) => failure,
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('8280x5520')
    expect((error as Error).message).toContain('5520x8280')
    expect((error as Error).message).toContain('lmfg_inspect')
    expect((error as Error).message).toContain('fresh candidate')
    expect(context.replay).not.toHaveBeenCalled()
  })

  it('rejects reduced export dimensions even when the JPEG hash is correct', async () => {
    await writeJson(
      exportPath,
      sealRenderManifest({
        ...exported,
        source_raw: {
          ...exported.source_raw,
          decoded_dimensions: { width: 2, height: 1 },
        },
      }),
    )
    await expect(verifyCompletion(args, context)).rejects.toThrow(
      /source|dimensions|resolution/i,
    )
  })

  it('rejects JPEG dimensions that disagree with the sealed output', async () => {
    await writeJson(
      exportPath,
      sealRenderManifest({
        ...exported,
        output: { ...exported.output, dimensions: { width: 2, height: 1 } },
      }),
    )
    await expect(verifyCompletion(args, context)).rejects.toThrow(
      /dimensions|resolution/i,
    )
  })

  it('rejects symlinks instead of reading files outside the workspace', async () => {
    const external = join(dir, 'outside.jpg')
    await writeFile(external, await readFile(outputPath))
    await rm(outputPath)
    await symlink(external, outputPath)
    await expect(verifyCompletion(args, context)).rejects.toThrow(
      /canonical|symlink|workspace/i,
    )
  })

  it.each([
    { reproduced: false },
    { expected_sha256: 'f'.repeat(64) },
    { actual_sha256: 'f'.repeat(64) },
    { fingerprint_match: false },
    { output: { sha256: 'f'.repeat(64), width: 1, height: 1 } },
  ])('rejects a fake replay success %j', async (patch) => {
    const original = await context.replay(exportPath, args.session)
    context.replay = vi.fn(async () => ({ ...original, ...patch }))
    await expect(verifyCompletion(args, context)).rejects.toThrow(/replay/i)
  })
})
