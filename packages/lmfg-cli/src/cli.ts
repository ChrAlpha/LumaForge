import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option,
} from 'commander'

import type { CliIo, CommandHost, GlobalOptions } from './commands/context'
import { createCommandContext, defaultIo } from './commands/context'
import { registerIntrospectionCommands } from './commands/introspection'
import { registerLutCommands } from './commands/lut'
import { LmfgError } from './protocol/errors'
import { LMFG_VERSION } from './runtime/versions'

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('Expected a positive integer.')
  }
  return parsed
}

export type RegisterCommands = (program: Command, host: CommandHost) => void

const COMMAND_MODULES: RegisterCommands[] = [
  registerIntrospectionCommands,
  registerLutCommands,
]

export function createProgram(
  io: CliIo,
  setExitCode: (code: number) => void,
): Command {
  const program = new Command()
  program
    .name('lmfg')
    .description(
      'Agent-friendly, reproducible RAW/LUT rendering CLI for LumaForge',
    )
    .version(LMFG_VERSION)
    .option('--workspace <dir>', 'artifact root (default: .lmfg)')
    .option('--session <id>', 'session id')
    .addOption(
      new Option('--tier <tier>', 'render tier')
        .choices(['cpu', 'browser'])
        .default('cpu'),
    )
    .addOption(
      new Option('--emit <mode>', 'stdout format')
        .choices(['json', 'ndjson'])
        .default('json'),
    )
    .option('--json', 'single JSON result on stdout (default)')
    .option('--quiet', 'suppress stderr diagnostics', false)
    .option('--no-color', 'disable ANSI colors')
    .option(
      '--dry-run',
      'validate inputs and report the plan without rendering or writing',
      false,
    )
    .option('--yes', 'non-interactive; assume yes', false)
    .option(
      '--timeout <ms>',
      'per-command timeout in milliseconds',
      parsePositiveInt,
    )
    .addOption(
      new Option('--memory-profile <profile>', 'native memory profile')
        .choices(['desktop', 'low-memory'])
        .default('desktop'),
    )
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .showHelpAfterError(false)

  const host: CommandHost = {
    io,
    setExitCode,
    context: (command) =>
      createCommandContext(io, command.optsWithGlobals() as GlobalOptions),
  }

  for (const register of COMMAND_MODULES) register(program, host)
  return program
}

export async function runCli(
  argv: readonly string[],
  io: CliIo = defaultIo(),
): Promise<number> {
  let exitCode = 0
  const program = createProgram(io, (code) => {
    exitCode = code
  })
  try {
    await program.parseAsync([...argv], { from: 'user' })
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return 0
      const mapped = new LmfgError('args.invalid', {
        message: error.message.replace(/^error: /, '').trim(),
        suggestedNextActions: ['lmfg --help'],
      })
      io.stdout(`${JSON.stringify(mapped.toEnvelope())}\n`)
      return mapped.exitCode
    }
    throw error
  }
  return exitCode
}
