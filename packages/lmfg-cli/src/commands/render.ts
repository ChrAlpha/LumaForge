import type { Command } from 'commander'

import type { NormalizedPlan } from '../schemas/plan'
import { expandSweepPlan, normalizeCandidatePlan } from '../schemas/plan'
import type { PreviewResult } from '../schemas/results'
import { runIteration } from '../services/iteration'
import { resolveLutForParams } from '../services/lut'
import {
  buildRenderManifest,
  percentToQuality,
  toSourceIdentity,
} from '../services/manifest'
import { clampMaxPixels, renderPreview } from '../services/preview'
import {
  readJson,
  writeFileAtomic,
  writeJsonAtomic,
} from '../workspace/atomic-fs'
import { formatPreviewId } from '../workspace/ids'
import { createIterationStore } from '../workspace/iteration-store'
import { toFileUri, workspacePaths } from '../workspace/paths'
import type { CommandHost } from './context'
import { runCommand } from './context'
import {
  loadParamsFile,
  openRenderSession,
  parsePositiveInteger,
  parseQualityPercent,
  resolveParamsAndLut,
  withRuntime,
} from './render-shared'

type PreviewOptions = { params?: string; maxPixels?: number; quality: number }

function registerPreview(render: Command, host: CommandHost): void {
  render
    .command('preview')
    .description(
      'Render one CPU preview for a params file and write it into the session',
    )
    .option(
      '--params <file>',
      'params JSON (lmfg.params.v1); defaults apply when omitted',
    )
    .option(
      '--max-pixels <n>',
      'decode budget in pixels (quick ≤ 2.5 MP, bounded HQ up to 12 MP)',
      parsePositiveInteger,
    )
    .option('--quality <n>', 'JPEG quality 1-100', parseQualityPercent, 85)
    .action(async function (this: Command, options: PreviewOptions) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(
          ctx,
          { schema: 'lmfg.render.preview.v1', command: 'render.preview' },
          async (): Promise<PreviewResult> => {
            const { store, record, source, environment } =
              await openRenderSession(ctx)
            const { params, lut } = await resolveParamsAndLut(
              ctx,
              await loadParamsFile(ctx, options.params),
            )
            const maxPixels = clampMaxPixels(options.maxPixels)
            return withRuntime(ctx, async (runtime) => {
              const result = await renderPreview({
                runtime,
                source,
                params,
                lut,
                maxPixels,
                quality: percentToQuality(options.quality),
                signal: ctx.signal,
              })
              const previewId = formatPreviewId(
                await store.allocate(record.id, 'previews'),
              )
              const root = ctx.workspaceRoot
              const outputPath = workspacePaths.previewFile(
                root,
                record.id,
                previewId,
              )
              const manifestPath = workspacePaths.previewManifestFile(
                root,
                record.id,
                previewId,
              )
              const manifest = buildRenderManifest({
                kind: 'preview',
                source: toSourceIdentity(
                  source,
                  record.decoded_dimensions ?? {
                    width: result.probe.width ?? result.frame.width,
                    height: result.probe.height ?? result.frame.height,
                  },
                ),
                lut: lut?.identity ?? null,
                graph: result.graph,
                params,
                exposure: result.exposure,
                policy: {
                  kind:
                    result.frame.decode === 'quick'
                      ? 'preview-quick'
                      : 'preview-bounded-hq',
                  row_slice: 32,
                  concurrency: 1,
                },
                environment,
                output: {
                  width: result.frame.width,
                  height: result.frame.height,
                  quality: options.quality,
                  filename: `${previewId}.jpg`,
                  sha256: result.rendered.sha256,
                },
                parentManifestSha256: null,
              })
              await writeFileAtomic(outputPath, result.rendered.jpeg)
              await writeJsonAtomic(manifestPath, manifest)
              ctx.output.event({
                event: 'artifact.ready',
                role: 'preview',
                uri: toFileUri(outputPath),
              })
              return {
                session_id: record.id,
                preview_id: previewId,
                output: {
                  uri: toFileUri(outputPath),
                  path: outputPath,
                  width: result.frame.width,
                  height: result.frame.height,
                  byte_size: result.rendered.jpeg.byteLength,
                  sha256: result.rendered.sha256,
                  quality: options.quality,
                },
                manifest_uri: toFileUri(manifestPath),
                manifest_sha256: manifest.manifest_sha256,
                decode: result.frame.decode,
                raw_render_exposure: result.exposure,
                color_graph_fingerprint: manifest.color_graph.fingerprint,
                timings_ms: result.timings,
              }
            })
          },
          async () => {
            const { record } = await openRenderSession(ctx)
            const { params, lut } = await resolveParamsAndLut(
              ctx,
              await loadParamsFile(ctx, options.params),
            )
            return {
              session_id: record.id,
              params,
              lut: lut?.identity ?? null,
              max_pixels: clampMaxPixels(options.maxPixels),
              quality: options.quality,
            }
          },
        ),
      )
    })
}

type IterationOptions = {
  plan: string
  maxPixels?: number
  quality: number
  contactSheet?: boolean
  sheetCols?: number
  tileWidth?: number
}

function registerIteration(
  render: Command,
  host: CommandHost,
  kind: 'candidate' | 'sweep',
): void {
  render
    .command(kind)
    .description(
      kind === 'candidate'
        ? 'Render an explicit list of candidates from a plan file'
        : 'Expand parameter axes into a candidate sweep and render it',
    )
    .requiredOption(
      '--plan <file>',
      kind === 'candidate'
        ? 'plan JSON (lmfg.plan.v1)'
        : 'sweep JSON (lmfg.sweep.v1)',
    )
    .option('--max-pixels <n>', 'decode budget in pixels', parsePositiveInteger)
    .option('--quality <n>', 'JPEG quality 1-100', parseQualityPercent, 85)
    .option('--contact-sheet', 'compose a contact sheet of every candidate')
    .option('--sheet-cols <n>', 'contact sheet columns', parsePositiveInteger)
    .option(
      '--tile-width <n>',
      'contact sheet tile width in pixels',
      parsePositiveInteger,
    )
    .action(async function (this: Command, options: IterationOptions) {
      const ctx = host.context(this)
      const loadPlan = async (): Promise<NormalizedPlan> => {
        const json = await readJson(ctx.resolvePath(options.plan))
        return kind === 'candidate'
          ? normalizeCandidatePlan(json)
          : expandSweepPlan(json)
      }
      host.setExitCode(
        await runCommand(
          ctx,
          { schema: `lmfg.render.${kind}.v1`, command: `render.${kind}` },
          async () => {
            const { store, record, source, environment } =
              await openRenderSession(ctx)
            const plan = await loadPlan()
            const sheetOptions = {
              ...(plan.contactSheet ?? {}),
              ...(options.sheetCols ? { cols: options.sheetCols } : {}),
              ...(options.tileWidth ? { tile_width: options.tileWidth } : {}),
            }
            return withRuntime(ctx, (runtime) =>
              runIteration({
                runtime,
                source,
                record,
                store,
                iterationStore: createIterationStore(
                  ctx.workspaceRoot,
                  record.id,
                ),
                environment,
                output: ctx.output,
                cwd: ctx.cwd,
                signal: ctx.signal,
                plan,
                options: {
                  maxPixels: clampMaxPixels(options.maxPixels),
                  quality: options.quality,
                  contactSheet: Boolean(
                    options.contactSheet || plan.contactSheet,
                  ),
                  sheetOptions,
                },
              }),
            )
          },
          async () => {
            const { record } = await openRenderSession(ctx)
            const plan = await loadPlan()
            for (const candidate of plan.candidates) {
              await resolveLutForParams(candidate.params.lut, ctx.cwd)
            }
            return {
              session_id: record.id,
              kind,
              candidate_count: plan.candidates.length,
              candidates: plan.candidates.map((c) => ({
                id: c.id,
                tag: c.tag,
              })),
              max_pixels: clampMaxPixels(options.maxPixels),
              quality: options.quality,
            }
          },
        ),
      )
    })
}

export function registerRenderCommands(
  program: Command,
  host: CommandHost,
): void {
  const render = program
    .command('render')
    .description(
      'Render previews, candidates, sweeps, and full-resolution exports',
    )
  registerPreview(render, host)
  registerIteration(render, host, 'candidate')
  registerIteration(render, host, 'sweep')
}
