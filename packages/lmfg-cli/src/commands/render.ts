import type { RawRenderExposure } from '@lumaforge/luma-color-runtime'
import { verifyManifestSha256 } from '@lumaforge/render-engine'
import type { Command } from 'commander'

import { LmfgError } from '../protocol/errors'
import { assertTierAvailable } from '../runtime/capability'
import { loadSourceFile } from '../runtime/source-loader'
import { resolveRenderEnvironment } from '../runtime/versions'
import type { RenderParams } from '../schemas/params'
import type { NormalizedPlan } from '../schemas/plan'
import { expandSweepPlan, normalizeCandidatePlan } from '../schemas/plan'
import type {
  ExportResult,
  PreviewResult,
  ReplayResult,
} from '../schemas/results'
import {
  exposureFromManifest,
  runFullResolutionExport,
} from '../services/export'
import { runIteration } from '../services/iteration'
import type { ResolvedLut } from '../services/lut'
import { resolveLutForParams } from '../services/lut'
import {
  buildRenderManifest,
  percentToQuality,
  requireVerifiedManifest,
  toSourceIdentity,
} from '../services/manifest'
import { clampMaxPixels, renderPreview } from '../services/preview'
import { prepareReplay, replayKey, runReplay } from '../services/replay'
import {
  fileExists,
  readJson,
  writeFileAtomic,
  writeJsonAtomic,
} from '../workspace/atomic-fs'
import { formatPreviewId } from '../workspace/ids'
import { createIterationStore } from '../workspace/iteration-store'
import { toFileUri, workspacePaths } from '../workspace/paths'
import { createSessionStore } from '../workspace/session-store'
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
                  max_pixels: maxPixels,
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

type ExportOptions = {
  iteration?: string
  candidate?: string
  params?: string
  quality: number
  output: string
  preferredRows?: number
}

type ExportInputs = Awaited<ReturnType<typeof openRenderSession>> & {
  params: RenderParams
  lut: ResolvedLut | null
  parent: string | null
  exposure: RawRenderExposure | null
  outputPath: string
}

function registerExport(render: Command, host: CommandHost): void {
  render
    .command('export')
    .description(
      'Full-resolution JPEG export; refuses to write anything it cannot prove reproducible',
    )
    .option('--iteration <id>', 'iteration containing --candidate')
    .option(
      '--candidate <id>',
      'candidate whose params, LUT, and exposure are exported (chains manifests)',
    )
    .option('--params <file>', 'params JSON when not exporting a candidate')
    .option('--quality <n>', 'JPEG quality 1-100', parseQualityPercent, 92)
    .option('--output <name>', 'artifact base name under exports/', 'final')
    .option(
      '--preferred-rows <n>',
      'strip height in rows',
      parsePositiveInteger,
    )
    .action(async function (this: Command, options: ExportOptions) {
      const ctx = host.context(this)
      const resolveInputs = async (): Promise<ExportInputs> => {
        if (options.candidate && !options.iteration) {
          throw new LmfgError('args.invalid', {
            message: '--candidate requires --iteration.',
          })
        }
        let session
        try {
          session = await openRenderSession(ctx)
        } catch (error) {
          if (error instanceof LmfgError && error.code === 'hash.mismatch') {
            throw new LmfgError('export.refused', {
              message: `Export refused: ${error.message}`,
              details: error.details,
              suggestedNextActions: error.suggestedNextActions,
            })
          }
          throw error
        }
        const { record, environment } = session
        let params: RenderParams
        let parent: string | null = null
        let exposure: RawRenderExposure | null = null
        let lutSha: string | null = null
        if (options.candidate && options.iteration) {
          const iterationStore = createIterationStore(
            ctx.workspaceRoot,
            record.id,
          )
          const paths = iterationStore.candidatePaths(
            options.iteration,
            options.candidate,
          )
          const { manifest } = await requireVerifiedManifest(
            paths.manifest,
            environment,
          )
          params = await iterationStore.readCandidateParams(
            options.iteration,
            options.candidate,
          )
          parent = manifest.manifest_sha256
          exposure = exposureFromManifest(manifest)
          lutSha = manifest.lut?.sha256 ?? null
        } else {
          params = await loadParamsFile(ctx, options.params)
        }
        const { lut } = await resolveParamsAndLut(ctx, params)
        if (lutSha && lut && lut.identity.sha256 !== lutSha) {
          throw new LmfgError('export.refused', {
            message:
              'The LUT file changed since the candidate was rendered; export refused.',
            details: {
              expected_sha256: lutSha,
              actual_sha256: lut.identity.sha256,
            },
          })
        }
        const outputPath = workspacePaths.exportFile(
          ctx.workspaceRoot,
          record.id,
          options.output,
        )
        if ((await fileExists(outputPath)) && !ctx.options.yes) {
          throw new LmfgError('args.invalid', {
            message: `${outputPath} already exists; pass --yes to overwrite or --output <name>.`,
          })
        }
        return { ...session, params, lut, parent, exposure, outputPath }
      }
      host.setExitCode(
        await runCommand(
          ctx,
          { schema: 'lmfg.render.export.v1', command: 'render.export' },
          async (): Promise<ExportResult> => {
            const {
              store,
              record,
              source,
              environment,
              params,
              lut,
              parent,
              exposure,
              outputPath,
            } = await resolveInputs()
            ctx.output.event({
              event: 'started',
              command: 'render.export',
              session_id: record.id,
            })
            return withRuntime(ctx, async (runtime) => {
              const result = await runFullResolutionExport({
                runtime,
                source,
                params,
                lut,
                exposure,
                quality: options.quality,
                preferredRows: options.preferredRows,
                signal: ctx.signal,
                onProgress: (progress) =>
                  ctx.output.event({
                    event: 'export.progress',
                    completed_strips: progress.completedStrips,
                    total_strips: progress.totalStrips,
                    progress: progress.progress,
                  }),
              })
              const manifestPath = workspacePaths.exportManifestFile(
                ctx.workspaceRoot,
                record.id,
                options.output,
              )
              const manifest = buildRenderManifest({
                kind: 'export',
                source: toSourceIdentity(source, {
                  width: result.width,
                  height: result.height,
                }),
                lut: lut?.identity ?? null,
                graph: result.graph,
                params,
                exposure: result.exposure,
                policy: {
                  kind: 'export-full',
                  row_slice: options.preferredRows ?? 512,
                  concurrency: 1,
                },
                environment,
                output: {
                  width: result.width,
                  height: result.height,
                  quality: options.quality,
                  filename: `${options.output}.jpg`,
                  sha256: result.sha256,
                },
                parentManifestSha256: parent,
              })
              if (!verifyManifestSha256(manifest)) {
                throw new LmfgError('export.refused', {
                  message:
                    'Export manifest failed self-verification; nothing was written.',
                })
              }
              await writeFileAtomic(outputPath, result.jpeg)
              await writeJsonAtomic(manifestPath, manifest)
              await store.allocate(record.id, 'exports')
              ctx.output.event({
                event: 'artifact.ready',
                role: 'export',
                uri: toFileUri(outputPath),
                manifest_sha256: manifest.manifest_sha256,
              })
              return {
                session_id: record.id,
                output: {
                  uri: toFileUri(outputPath),
                  path: outputPath,
                  width: result.width,
                  height: result.height,
                  byte_size: result.jpeg.byteLength,
                  sha256: result.sha256,
                  quality: options.quality,
                },
                manifest_uri: toFileUri(manifestPath),
                manifest_sha256: manifest.manifest_sha256,
                parent_manifest_sha256: parent,
                color_graph_fingerprint: manifest.color_graph.fingerprint,
                raw_render_exposure: result.exposure,
                strips: result.strips,
                timings_ms: result.timings,
              }
            })
          },
          async () => {
            const { record, params, lut, parent, outputPath } =
              await resolveInputs()
            return {
              session_id: record.id,
              params,
              lut: lut?.identity ?? null,
              parent_manifest_sha256: parent,
              output_path: outputPath,
              quality: options.quality,
            }
          },
        ),
      )
    })
}

type ReplayOptions = {
  manifest: string
  source?: string
  lut?: string
  name?: string
}

function registerReplay(render: Command, host: CommandHost): void {
  render
    .command('replay')
    .description(
      'Re-render a manifest from its recorded params and LUT contract and prove the output is reproduced',
    )
    .requiredOption('--manifest <file>', 'manifest JSON to replay')
    .option(
      '--source <raw>',
      'RAW file to replay against (defaults to the --session source)',
    )
    .option(
      '--lut <file>',
      'LUT file matching the manifest (defaults to the workspace LUT cache)',
    )
    .option(
      '--name <name>',
      'replay directory name (default: first 12 chars of the manifest sha256)',
    )
    .action(async function (this: Command, options: ReplayOptions) {
      const ctx = host.context(this)
      const resolveInputs = async () => {
        assertTierAvailable(ctx.options.tier)
        const environment = resolveRenderEnvironment(ctx.options.memoryProfile)
        const manifestPath = ctx.resolvePath(options.manifest)
        const { manifest } = await requireVerifiedManifest(
          manifestPath,
          environment,
        )
        let sessionId: string | null = null
        let source
        if (options.source) {
          source = await loadSourceFile(options.source, ctx.cwd)
        } else {
          const record = await createSessionStore(ctx.workspaceRoot).load(
            ctx.requireSession(),
          )
          sessionId = record.id
          source = await loadSourceFile(record.source.path, '/')
        }
        const plan = await prepareReplay({
          manifest,
          source,
          lutPath: options.lut ? ctx.resolvePath(options.lut) : undefined,
          workspaceRoot: ctx.workspaceRoot,
          cwd: ctx.cwd,
        })
        const key = options.name ?? replayKey(manifest)
        const outputPath = sessionId
          ? workspacePaths.replayOutputFile(ctx.workspaceRoot, sessionId, key)
          : `${workspacePaths.workspaceReplay(ctx.workspaceRoot, key)}/output.jpg`
        const manifestOutputPath = sessionId
          ? workspacePaths.replayManifestFile(ctx.workspaceRoot, sessionId, key)
          : `${workspacePaths.workspaceReplay(ctx.workspaceRoot, key)}/manifest.json`
        return {
          environment,
          manifestPath,
          manifest,
          sessionId,
          source,
          plan,
          outputPath,
          manifestOutputPath,
        }
      }
      host.setExitCode(
        await runCommand(
          ctx,
          { schema: 'lmfg.render.replay.v1', command: 'render.replay' },
          async (): Promise<ReplayResult> => {
            const inputs = await resolveInputs()
            ctx.output.event({
              event: 'started',
              command: 'render.replay',
              kind: inputs.manifest.kind,
              manifest_sha256: inputs.manifest.manifest_sha256,
            })
            return withRuntime(ctx, async (runtime) => {
              const result = await runReplay({
                runtime,
                plan: inputs.plan,
                source: inputs.source,
                environment: inputs.environment,
                manifestPath: inputs.manifestPath,
                sessionId: inputs.sessionId,
                outputPath: inputs.outputPath,
                manifestOutputPath: inputs.manifestOutputPath,
                signal: ctx.signal,
                onProgress: (progress) =>
                  ctx.output.event({
                    event: 'export.progress',
                    completed_strips: progress.completedStrips,
                    total_strips: progress.totalStrips,
                    progress: progress.progress,
                  }),
              })
              ctx.output.event({
                event: 'artifact.ready',
                role: 'replay',
                uri: result.output.uri,
                reproduced: result.reproduced,
              })
              return result
            })
          },
          async () => {
            const inputs = await resolveInputs()
            return {
              manifest_path: inputs.manifestPath,
              kind: inputs.manifest.kind,
              session_id: inputs.sessionId,
              fingerprint_match: inputs.plan.fingerprintMatch,
              output_path: inputs.outputPath,
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
  registerExport(render, host)
  registerReplay(render, host)
}
