import type { Command } from 'commander'

import type { MetricsResult } from '../schemas/results'
import { computeImageMetrics } from '../services/metrics'
import { writeJsonAtomic } from '../workspace/atomic-fs'
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
}
