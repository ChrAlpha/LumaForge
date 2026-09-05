import type { Command } from 'commander'

import { LmfgError } from '../protocol/errors'
import { resolveRenderEnvironment } from '../runtime/versions'
import {
  requireVerifiedManifest,
  verifyManifestFile,
} from '../services/manifest'
import type { CommandHost } from './context'
import { runCommand } from './context'

export function registerManifestCommands(
  program: Command,
  host: CommandHost,
): void {
  const manifest = program
    .command('manifest')
    .description('Verify and display render manifests')

  manifest
    .command('verify')
    .argument('<file>', 'manifest JSON file')
    .description('Recompute the canonical hash and check the manifest contract')
    .action(async function (this: Command, file: string) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(
          ctx,
          { schema: 'lmfg.manifest.verify.v1', command: 'manifest.verify' },
          async () => {
            const path = ctx.resolvePath(file)
            const verification = await verifyManifestFile(path, {
              environment: resolveRenderEnvironment(ctx.options.memoryProfile),
            })
            const result = {
              path,
              valid: verification.valid,
              manifest_sha256:
                typeof verification.raw?.manifest_sha256 === 'string'
                  ? (verification.raw.manifest_sha256 as string)
                  : null,
              kind:
                typeof verification.raw?.kind === 'string'
                  ? (verification.raw.kind as string)
                  : null,
              issues: verification.issues,
              warnings: verification.warnings,
              environment_match: verification.environment_match,
            }
            if (!verification.valid) {
              throw new LmfgError('manifest.invalid', {
                message: `Manifest failed verification: ${verification.issues.join(' ')}`,
                details: result,
              })
            }
            return result
          },
        ),
      )
    })

  manifest
    .command('show')
    .argument('<file>', 'manifest JSON file')
    .description('Print a verified manifest')
    .action(async function (this: Command, file: string) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(
          ctx,
          { schema: 'lmfg.manifest.show.v1', command: 'manifest.show' },
          async () => {
            const path = ctx.resolvePath(file)
            const { manifest: verified, warnings } =
              await requireVerifiedManifest(
                path,
                resolveRenderEnvironment(ctx.options.memoryProfile),
              )
            return {
              path,
              verified: true,
              warnings,
              manifest: verified as unknown as Record<string, unknown>,
            }
          },
        ),
      )
    })
}
