import type { Command } from 'commander'

import { assertTierAvailable } from '../runtime/capability'
import { createLmfgRuntime } from '../runtime/node-runtime'
import { loadSessionSource, loadSourceFile } from '../runtime/source-loader'
import { inspectSource } from '../services/inspect'
import { writeJsonAtomic } from '../workspace/atomic-fs'
import { workspacePaths } from '../workspace/paths'
import { createSessionStore } from '../workspace/session-store'
import type { CommandHost } from './context'
import { runCommand } from './context'

export function registerInspectCommand(
  program: Command,
  host: CommandHost,
): void {
  program
    .command('inspect')
    .argument('[file]', 'RAW file (omit to inspect the --session source)')
    .description(
      'Probe a RAW file: metadata, embedded preview, export capability, render exposure',
    )
    .action(async function (this: Command, file: string | undefined) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(
          ctx,
          { schema: 'lmfg.inspect.v1', command: 'inspect' },
          async () => {
            assertTierAvailable(ctx.options.tier)
            const runtime = createLmfgRuntime({
              memoryProfile: ctx.options.memoryProfile,
            })
            try {
              if (file) {
                const source = await loadSourceFile(file, ctx.cwd)
                return await inspectSource({
                  runtime,
                  source,
                  sessionId: null,
                  embeddedPreviewPath: null,
                  signal: ctx.signal,
                })
              }
              const id = ctx.requireSession()
              const store = createSessionStore(ctx.workspaceRoot)
              const record = await store.load(id)
              const source = await loadSessionSource(record)
              const result = await inspectSource({
                runtime,
                source,
                sessionId: id,
                embeddedPreviewPath: workspacePaths.embeddedPreviewFile(
                  ctx.workspaceRoot,
                  id,
                ),
                signal: ctx.signal,
              })
              await writeJsonAtomic(
                workspacePaths.inspectFile(ctx.workspaceRoot, id),
                {
                  schema: 'lmfg.inspect.v1',
                  ...result,
                },
              )
              await store.update(id, (rec) => ({
                ...rec,
                status: 'inspected',
                decoded_dimensions: result.decoded_dimensions,
              }))
              return result
            } finally {
              runtime.dispose()
            }
          },
          async () => {
            const source = file
              ? await loadSourceFile(file, ctx.cwd)
              : await loadSessionSource(
                  await createSessionStore(ctx.workspaceRoot).load(
                    ctx.requireSession(),
                  ),
                )
            return {
              source: {
                path: source.absolutePath,
                sha256: source.sha256,
                byte_size: source.byteSize,
              },
              tier: ctx.options.tier,
            }
          },
        ),
      )
    })
}
