import { resolve } from 'node:path'
import process from 'node:process'

import type { Command } from 'commander'

import { successEnvelope } from '../protocol/envelope'
import { LmfgError, toLmfgError } from '../protocol/errors'
import type { EmitMode } from '../protocol/output'
import { Output } from '../protocol/output'
import type { RenderTier } from '../runtime/capability'
import type { MemoryProfile } from '../runtime/versions'
import { resolveWorkspaceRoot } from '../workspace/paths'

export type CliIo = {
  stdout: (chunk: string) => void
  stderr: (chunk: string) => void
  cwd: string
}

export type GlobalOptions = {
  workspace?: string
  session?: string
  tier: RenderTier
  emit: EmitMode
  json?: boolean
  quiet: boolean
  color: boolean
  dryRun: boolean
  yes: boolean
  timeout?: number
  memoryProfile: MemoryProfile
}

export type CommandContext = {
  cwd: string
  options: GlobalOptions
  output: Output
  workspaceRoot: string
  signal: AbortSignal
  timedOut: () => boolean
  resolvePath: (path: string) => string
  requireSession: () => string
  dispose: () => void
}

export type CommandHost = {
  io: CliIo
  setExitCode: (code: number) => void
  context: (command: Command) => CommandContext
}

export function createCommandContext(
  io: CliIo,
  options: GlobalOptions,
): CommandContext {
  const controller = new AbortController()
  let timedOut = false
  const timer = options.timeout
    ? setTimeout(() => {
        timedOut = true
        controller.abort(new Error(`Timed out after ${options.timeout} ms.`))
      }, options.timeout)
    : null
  timer?.unref()
  return {
    cwd: io.cwd,
    options,
    output: new Output({
      emit: options.emit,
      quiet: options.quiet,
      color: options.color,
      stdout: io.stdout,
      stderr: io.stderr,
    }),
    workspaceRoot: resolveWorkspaceRoot(io.cwd, options.workspace),
    signal: controller.signal,
    timedOut: () => timedOut,
    resolvePath: (path) => resolve(io.cwd, path),
    requireSession: () => {
      if (!options.session) {
        throw new LmfgError('args.invalid', {
          message: 'A session id is required (--session <id>).',
          suggestedNextActions: ['lmfg session list'],
        })
      }
      return options.session
    },
    dispose: () => {
      if (timer) clearTimeout(timer)
    },
  }
}

export type CommandDescriptor = { schema: string; command: string }

export async function runCommand<T>(
  ctx: CommandContext,
  descriptor: CommandDescriptor,
  run: (ctx: CommandContext) => Promise<T>,
  dryRun?: (ctx: CommandContext) => Promise<Record<string, unknown>>,
): Promise<number> {
  try {
    if (ctx.options.dryRun && dryRun) {
      const plan = await dryRun(ctx)
      ctx.output.result(
        successEnvelope('lmfg.dry-run.v1', {
          dry_run: true,
          command: descriptor.command,
          plan,
        }),
      )
      return 0
    }
    const result = await run(ctx)
    ctx.output.result(successEnvelope(descriptor.schema, result))
    return 0
  } catch (error) {
    let mapped = toLmfgError(error)
    if (ctx.timedOut()) {
      mapped = new LmfgError('timeout', {
        message: `Command timed out after ${ctx.options.timeout} ms.`,
        retryable: true,
        cause: error,
      })
    }
    ctx.output.error(mapped)
    ctx.output.log(`error ${mapped.code}: ${mapped.message}`)
    return mapped.exitCode
  } finally {
    ctx.dispose()
  }
}

export function defaultIo(): CliIo {
  return {
    stdout: (chunk) => {
      process.stdout.write(chunk)
    },
    stderr: (chunk) => {
      process.stderr.write(chunk)
    },
    cwd: process.cwd(),
  }
}
