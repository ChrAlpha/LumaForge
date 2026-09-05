import process from 'node:process'

import type { Command } from 'commander'

import { LmfgError } from '../protocol/errors'
import { detectCapabilities } from '../runtime/capability'
import { LMFG_VERSION, resolveRuntimeVersions } from '../runtime/versions'
import { listSchemas, showSchema } from '../schemas/registry'
import type { VersionResult } from '../schemas/results'
import type { CommandHost } from './context'
import { runCommand } from './context'

export function registerIntrospectionCommands(
  program: Command,
  host: CommandHost,
): void {
  program
    .command('version')
    .description('Print lmfg and runtime versions')
    .action(async function (this: Command) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(
          ctx,
          { schema: 'lmfg.version.v1', command: 'version' },
          async (): Promise<VersionResult> => ({
            lmfg: LMFG_VERSION,
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            runtime_versions: resolveRuntimeVersions(ctx.options.memoryProfile),
          }),
        ),
      )
    })

  program
    .command('capabilities')
    .description('Report available render tiers, runtime versions, and limits')
    .action(async function (this: Command) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(
          ctx,
          { schema: 'lmfg.capabilities.v1', command: 'capabilities' },
          async () =>
            detectCapabilities({ memoryProfile: ctx.options.memoryProfile }),
        ),
      )
    })

  const schema = program
    .command('schema')
    .description('List or show lmfg JSON schemas')

  schema
    .command('list')
    .description('List schema ids')
    .action(async function (this: Command) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(
          ctx,
          { schema: 'lmfg.schema.list.v1', command: 'schema.list' },
          async () => ({
            schemas: listSchemas(),
          }),
        ),
      )
    })

  schema
    .command('show')
    .argument('<schema-id>', 'schema id, e.g. lmfg.params.v1')
    .description('Show a schema as JSON Schema (draft 2020-12)')
    .action(async function (this: Command, schemaId: string) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(
          ctx,
          { schema: 'lmfg.schema.show.v1', command: 'schema.show' },
          async () => {
            const shown = showSchema(schemaId)
            if (!shown) {
              throw new LmfgError('args.invalid', {
                message: `Unknown schema id "${schemaId}".`,
                suggestedNextActions: ['lmfg schema list'],
              })
            }
            return shown
          },
        ),
      )
    })
}
