import type { Command } from 'commander'

import { LutContractInputSchema } from '../schemas/params'
import {
  inferContract,
  inspectLut,
  loadLutFile,
  validateContract,
} from '../services/lut'
import { readJson } from '../workspace/atomic-fs'
import type { CommandHost } from './context'
import { runCommand } from './context'

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
    .requiredOption(
      '--contract <file>',
      'contract JSON file (lmfg.contract.v1)',
    )
    .description(
      'Validate an explicit contract against a LUT and report export support',
    )
    .action(async function (
      this: Command,
      options: { lut: string; contract: string },
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
              await readJson(ctx.resolvePath(options.contract)),
            )
            return validateContract(loaded, input)
          },
        ),
      )
    })
}
