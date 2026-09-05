import type { Command } from 'commander'

import { loadSourceFile } from '../runtime/source-loader'
import type { SessionStatusResult } from '../schemas/results'
import {
  fileExists,
  listDirs,
  listFiles,
  readJsonOrNull,
} from '../workspace/atomic-fs'
import type { IterationRecord } from '../workspace/iteration-store'
import { toFileUri, workspacePaths } from '../workspace/paths'
import { createSessionStore } from '../workspace/session-store'
import type { CommandHost } from './context'
import { runCommand } from './context'

export function registerSessionCommands(
  program: Command,
  host: CommandHost,
): void {
  const session = program
    .command('session')
    .description('Create and inspect .lmfg sessions')

  session
    .command('init')
    .requiredOption('--source <file>', 'RAW source file')
    .description(
      'Create a session for a RAW file (computes its full-file sha256)',
    )
    .action(async function (this: Command, options: { source: string }) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(
          ctx,
          { schema: 'lmfg.session.v1', command: 'session.init' },
          async () => {
            const source = await loadSourceFile(options.source, ctx.cwd)
            const store = createSessionStore(ctx.workspaceRoot)
            const record = await store.init({
              sourcePath: source.absolutePath,
              sha256: source.sha256,
              byteSize: source.byteSize,
            })
            ctx.output.log(
              `session ${record.id} created in ${ctx.workspaceRoot}`,
            )
            return record
          },
          async () => {
            const source = await loadSourceFile(options.source, ctx.cwd)
            return {
              workspace_root: ctx.workspaceRoot,
              source: {
                path: source.absolutePath,
                sha256: source.sha256,
                byte_size: source.byteSize,
              },
            }
          },
        ),
      )
    })

  session
    .command('status')
    .description(
      'Show a session record with its iterations, previews, and exports',
    )
    .action(async function (this: Command) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(
          ctx,
          { schema: 'lmfg.session.status.v1', command: 'session.status' },
          async (): Promise<SessionStatusResult> => {
            const id = ctx.requireSession()
            const root = ctx.workspaceRoot
            const record = await createSessionStore(root).load(id)
            const iterations: SessionStatusResult['iterations'] = []
            for (const iterationId of await listDirs(
              workspacePaths.iterations(root, id),
            )) {
              const plan = await readJsonOrNull<IterationRecord>(
                workspacePaths.iterationPlanFile(root, id, iterationId),
              )
              if (!plan) continue
              iterations.push({
                id: iterationId,
                created_at: plan.created_at,
                kind: plan.kind,
                candidate_count: plan.candidates.length,
                contact_sheet: await fileExists(
                  workspacePaths.contactSheetFile(root, id, iterationId),
                ),
              })
            }
            const previews = (
              await listFiles(workspacePaths.previews(root, id), '.jpg')
            ).map((name) => name.replace(/\.jpg$/, ''))
            const exports: SessionStatusResult['exports'] = []
            for (const name of await listFiles(
              workspacePaths.exports(root, id),
              '.jpg',
            )) {
              const base = name.replace(/\.jpg$/, '')
              exports.push({
                name: base,
                output_uri: toFileUri(
                  workspacePaths.exportFile(root, id, base),
                ),
                manifest_uri: toFileUri(
                  workspacePaths.exportManifestFile(root, id, base),
                ),
              })
            }
            return {
              ...record,
              session_dir: workspacePaths.session(root, id),
              source_present: await fileExists(record.source.path),
              iterations,
              previews,
              exports,
            }
          },
        ),
      )
    })

  session
    .command('list')
    .description('List sessions in the workspace')
    .action(async function (this: Command) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(
          ctx,
          { schema: 'lmfg.session.list.v1', command: 'session.list' },
          async () => ({
            workspace_root: ctx.workspaceRoot,
            sessions: await createSessionStore(ctx.workspaceRoot).list(),
          }),
        ),
      )
    })
}
