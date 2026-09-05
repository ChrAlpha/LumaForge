import type { Command } from 'commander'

import { LmfgError } from '../protocol/errors'
import { LutContractInputSchema } from '../schemas/params'
import type { LutFetchResult } from '../schemas/results'
import {
  inferContract,
  inspectLut,
  loadLutFile,
  validateContract,
} from '../services/lut'
import { fetchLutFile, isNetworkAllowed } from '../services/lut-fetch'
import { fileExists, readJson } from '../workspace/atomic-fs'
import { workspacePaths } from '../workspace/paths'
import type { CommandHost } from './context'
import { runCommand } from './context'
import { parseInlineJson } from './render-shared'

export function registerLutCommands(program: Command, host: CommandHost): void {
  const lut = program
    .command('lut')
    .description('Inspect .cube LUTs and resolve their color contracts')

  lut
    .command('inspect')
    .argument('<file>', '.cube LUT file')
    .description(
      'Parse a LUT and report its metadata, validity, and contract resolution',
    )
    .action(async function (this: Command, file: string) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(
          ctx,
          { schema: 'lmfg.lut.inspect.v1', command: 'lut.inspect' },
          async () => inspectLut(await loadLutFile(file, ctx.cwd)),
        ),
      )
    })

  lut
    .command('fetch')
    .requiredOption('--url <url>', 'http(s) URL of a .cube LUT')
    .requiredOption('--sha256 <hex>', 'expected SHA-256 of the file')
    .option(
      '--out <file>',
      'destination path (default: <workspace>/luts/<sha256>.cube)',
    )
    .option('--allow-network', 'permit outbound HTTP(S) for this command')
    .description(
      'Download a LUT into the workspace cache, verifying its SHA-256',
    )
    .action(async function (
      this: Command,
      options: {
        url: string
        sha256: string
        out?: string
        allowNetwork?: boolean
      },
    ) {
      const ctx = host.context(this)
      const expected = options.sha256.trim().toLowerCase()
      const destination = options.out
        ? ctx.resolvePath(options.out)
        : workspacePaths.lutCacheFile(ctx.workspaceRoot, expected)
      host.setExitCode(
        await runCommand(
          ctx,
          { schema: 'lmfg.lut.fetch.v1', command: 'lut.fetch' },
          async (): Promise<LutFetchResult> => {
            const fetched = await fetchLutFile({
              url: options.url,
              expectedSha256: expected,
              destination,
              allowNetwork: isNetworkAllowed(options.allowNetwork),
              signal: ctx.signal,
            })
            const loaded = await loadLutFile(fetched.path, ctx.cwd)
            ctx.output.event({
              event: 'artifact.ready',
              role: 'lut',
              uri: fetched.path,
              cached: fetched.cached,
            })
            return {
              ...fetched,
              inspect: inspectLut(loaded),
              contract: inferContract(loaded),
            }
          },
          async () => ({
            url: options.url,
            sha256: expected,
            destination,
            cached: await fileExists(destination),
            network_allowed: isNetworkAllowed(options.allowNetwork),
          }),
        ),
      )
    })

  const contract = lut
    .command('contract')
    .description('Infer or validate LUT color contracts')

  contract
    .command('infer')
    .requiredOption('--lut <file>', '.cube LUT file')
    .description(
      'Infer the LUT input/output contract from metadata and naming hints',
    )
    .action(async function (this: Command, options: { lut: string }) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(
          ctx,
          {
            schema: 'lmfg.lut.contract.infer.v1',
            command: 'lut.contract.infer',
          },
          async () => inferContract(await loadLutFile(options.lut, ctx.cwd)),
        ),
      )
    })

  contract
    .command('validate')
    .requiredOption('--lut <file>', '.cube LUT file')
    .option('--contract <file>', 'contract JSON file (lmfg.contract.v1)')
    .option('--contract-json <json>', 'inline contract JSON (lmfg.contract.v1)')
    .description(
      'Validate an explicit contract against a LUT and report export support',
    )
    .action(async function (
      this: Command,
      options: { lut: string; contract?: string; contractJson?: string },
    ) {
      const ctx = host.context(this)
      host.setExitCode(
        await runCommand(
          ctx,
          {
            schema: 'lmfg.lut.contract.validate.v1',
            command: 'lut.contract.validate',
          },
          async () => {
            const loaded = await loadLutFile(options.lut, ctx.cwd)
            const input = LutContractInputSchema.parse(
              await loadContractInput(ctx, options),
            )
            return validateContract(loaded, input)
          },
        ),
      )
    })
}

/** `--contract <file>` or `--contract-json <json>`; both together is an error. */
async function loadContractInput(
  ctx: { resolvePath: (path: string) => string },
  options: { contract?: string; contractJson?: string },
): Promise<unknown> {
  if (options.contract !== undefined && options.contractJson !== undefined) {
    throw new LmfgError('args.invalid', {
      message:
        'Pass either --contract <file> or --contract-json <json>, not both.',
    })
  }
  if (options.contractJson !== undefined) {
    return parseInlineJson(options.contractJson, '--contract-json')
  }
  if (options.contract === undefined) {
    throw new LmfgError('args.invalid', {
      message: 'Pass --contract <file> or --contract-json <json>.',
    })
  }
  return readJson(ctx.resolvePath(options.contract))
}
