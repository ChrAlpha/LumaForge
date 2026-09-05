import type { Command } from 'commander'

import { LmfgError } from '../protocol/errors'
import type {
  Metrics,
  MetricsCompareResult,
  MetricsRankResult,
  MetricsResult,
} from '../schemas/results'
import { ObjectiveSchema } from '../schemas/results'
import type { Objective } from '../services/evaluation'
import {
  compareMetrics,
  rankCandidates,
  validateObjective,
} from '../services/evaluation'
import { computeImageMetrics } from '../services/metrics'
import { readJson, writeJsonAtomic } from '../workspace/atomic-fs'
import type { IterationStore } from '../workspace/iteration-store'
import { createIterationStore } from '../workspace/iteration-store'
import { toFileUri } from '../workspace/paths'
import { createSessionStore } from '../workspace/session-store'
import type { CommandHost } from './context'
import { runCommand } from './context'

export function registerMetricsCommands(
  program: Command,
  host: CommandHost,
): void {
  const metrics = program
    .command('metrics')
    .description('Image statistics for rendered candidates')
  metrics
    .command('compute')
    .description(
      'Return stored metrics for a candidate (recomputed from its tile when missing)',
    )
    .requiredOption('--iteration <id>', 'iteration id')
    .requiredOption('--candidate <id>', 'candidate id')
    .action(async function (
      this: Command,
      options: { iteration: string; candidate: string },
    ) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(
          ctx,
          { schema: 'lmfg.metrics.compute.v1', command: 'metrics.compute' },
          async (): Promise<MetricsResult> => {
            const record = await createSessionStore(ctx.workspaceRoot).load(
              ctx.requireSession(),
            )
            const iterationStore = createIterationStore(
              ctx.workspaceRoot,
              record.id,
            )
            await iterationStore.read(options.iteration)
            const paths = iterationStore.candidatePaths(
              options.iteration,
              options.candidate,
            )
            let stored = await iterationStore.readCandidateMetrics(
              options.iteration,
              options.candidate,
            )
            if (!stored) {
              const tile = await iterationStore.readCandidateTile(
                options.iteration,
                options.candidate,
              )
              stored = computeImageMetrics(tile.rgba, tile.width, tile.height, {
                approximate: true,
              })
              await writeJsonAtomic(paths.metrics, stored)
            }
            return {
              session_id: record.id,
              iteration_id: options.iteration,
              candidate_id: options.candidate,
              metrics_uri: toFileUri(paths.metrics),
              metrics: stored,
            }
          },
        ),
      )
    })

  metrics
    .command('compare')
    .description(
      'Report every candidate of an iteration as deltas against a baseline candidate',
    )
    .requiredOption('--iteration <id>', 'iteration id')
    .option(
      '--baseline <candidate-id>',
      'baseline candidate (default: the first candidate)',
    )
    .action(async function (
      this: Command,
      options: { iteration: string; baseline?: string },
    ) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(
          ctx,
          { schema: 'lmfg.metrics.compare.v1', command: 'metrics.compare' },
          async (): Promise<MetricsCompareResult> => {
            const record = await createSessionStore(ctx.workspaceRoot).load(
              ctx.requireSession(),
            )
            const iterationStore = createIterationStore(
              ctx.workspaceRoot,
              record.id,
            )
            const iteration = await iterationStore.read(options.iteration)
            const baselineId = options.baseline ?? iteration.candidates[0]?.id
            if (
              !baselineId ||
              !iteration.candidates.some((c) => c.id === baselineId)
            ) {
              throw new LmfgError('args.invalid', {
                message: `Candidate ${options.baseline ?? '(none)'} is not part of iteration ${options.iteration}.`,
                suggestedNextActions: [
                  `lmfg session status --session ${record.id}`,
                ],
              })
            }
            const baseline = await loadMetrics(
              iterationStore,
              options.iteration,
              baselineId,
            )
            const candidates = []
            for (const candidate of iteration.candidates) {
              const metrics = await loadMetrics(
                iterationStore,
                options.iteration,
                candidate.id,
              )
              candidates.push({
                candidate_id: candidate.id,
                tag: candidate.tag,
                metrics_uri: toFileUri(
                  iterationStore.candidatePaths(options.iteration, candidate.id)
                    .metrics,
                ),
                deltas: compareMetrics(baseline, metrics),
              })
            }
            return {
              session_id: record.id,
              iteration_id: options.iteration,
              baseline_candidate_id: baselineId,
              candidates,
            }
          },
        ),
      )
    })

  metrics
    .command('rank')
    .description(
      'Score every candidate of an iteration against an objective and rank them best-first',
    )
    .requiredOption('--iteration <id>', 'iteration id')
    .requiredOption(
      '--objective <file|json>',
      'objective JSON file or inline object (lmfg.objective.v1)',
    )
    .action(async function (
      this: Command,
      options: { iteration: string; objective: string },
    ) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(
          ctx,
          { schema: 'lmfg.metrics.rank.v1', command: 'metrics.rank' },
          async (): Promise<MetricsRankResult> => {
            const objective = await loadObjective(ctx, options.objective)
            const record = await createSessionStore(ctx.workspaceRoot).load(
              ctx.requireSession(),
            )
            const iterationStore = createIterationStore(
              ctx.workspaceRoot,
              record.id,
            )
            const iteration = await iterationStore.read(options.iteration)
            const scored = []
            for (const candidate of iteration.candidates) {
              scored.push({
                id: candidate.id,
                metrics: await loadMetrics(
                  iterationStore,
                  options.iteration,
                  candidate.id,
                ),
              })
            }
            const ranking = rankCandidates(scored, objective)
            const entries = []
            for (const [position, entry] of ranking.entries()) {
              const candidate = iteration.candidates.find(
                (c) => c.id === entry.candidate_id,
              )
              const manifest = await iterationStore.readCandidateManifest(
                options.iteration,
                entry.candidate_id,
              )
              entries.push({
                rank: position + 1,
                candidate_id: entry.candidate_id,
                tag: candidate?.tag ?? null,
                score: entry.score,
                terms: entry.terms,
                preview_uri: toFileUri(
                  iterationStore.candidatePaths(
                    options.iteration,
                    entry.candidate_id,
                  ).preview,
                ),
                manifest_sha256: manifest.manifest_sha256,
              })
            }
            return {
              session_id: record.id,
              iteration_id: options.iteration,
              objective,
              ranking: entries,
            }
          },
        ),
      )
    })
}

async function loadMetrics(
  store: IterationStore,
  iterationId: string,
  candidateId: string,
): Promise<Metrics> {
  const stored = await store.readCandidateMetrics(iterationId, candidateId)
  if (stored) return stored
  const tile = await store.readCandidateTile(iterationId, candidateId)
  const computed = computeImageMetrics(tile.rgba, tile.width, tile.height, {
    approximate: true,
  })
  await writeJsonAtomic(
    store.candidatePaths(iterationId, candidateId).metrics,
    computed,
  )
  return computed
}

/** `--objective` takes a file path or an inline JSON object. */
async function loadObjective(
  ctx: { resolvePath: (path: string) => string },
  value: string,
): Promise<Objective> {
  const trimmed = value.trim()
  let raw: unknown
  if (trimmed.startsWith('{')) {
    try {
      raw = JSON.parse(trimmed)
    } catch (error) {
      throw new LmfgError('args.invalid', {
        message: `--objective is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  } else {
    raw = await readJson(ctx.resolvePath(value))
  }
  const parsed = ObjectiveSchema.safeParse(raw)
  if (!parsed.success) {
    throw new LmfgError('args.invalid', {
      message: `Objective does not match lmfg.objective.v1: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`,
      suggestedNextActions: ['lmfg schema show lmfg.objective.v1'],
    })
  }
  return validateObjective(parsed.data)
}
