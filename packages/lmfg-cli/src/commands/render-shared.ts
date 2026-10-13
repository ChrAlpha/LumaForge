import type { RenderEnvironment } from '@lumaforge/render-engine'
import { InvalidArgumentError } from 'commander'

import { LmfgError } from '../protocol/errors'
import { assertTierAvailable } from '../runtime/capability'
import type { LmfgRuntime } from '../runtime/node-runtime'
import { createLmfgRuntime } from '../runtime/node-runtime'
import type { LoadedSource } from '../runtime/source-loader'
import { loadSessionSource } from '../runtime/source-loader'
import { resolveRenderEnvironment } from '../runtime/versions'
import type { RenderParams } from '../schemas/params'
import { parseRenderParams } from '../schemas/params'
import type { SessionRecord } from '../schemas/results'
import type { ResolvedLut } from '../services/lut'
import { resolveLutForParams } from '../services/lut'
import { readJson } from '../workspace/atomic-fs'
import type { SessionStore } from '../workspace/session-store'
import { createSessionStore } from '../workspace/session-store'
import type { CommandContext } from './context'

export function parseQualityPercent(value: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new InvalidArgumentError('Expected an integer between 1 and 100.')
  }
  return parsed
}

export function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('Expected a positive integer.')
  }
  return parsed
}

export function parseNonNegativeInteger(value: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError('Expected a non-negative integer.')
  }
  return parsed
}

/** Inline JSON for a `--<name>-json` flag (agent hosts pass objects, not files). */
function parseInlineJson(value: string, flag: string): unknown {
  try {
    return JSON.parse(value)
  } catch (error) {
    throw new LmfgError('args.invalid', {
      message: `${flag} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

/**
 * A JSON input given as `--<name> <file>` or `--<name>-json <json>`; both
 * together is an error, and so is neither unless the input is optional.
 */
export async function readJsonInput(
  ctx: Pick<CommandContext, 'resolvePath'>,
  name: string,
  input: { file?: string; json?: string },
  required = true,
): Promise<unknown> {
  const usage = `--${name} <file> or --${name}-json <json>`
  if (input.file !== undefined && input.json !== undefined) {
    throw new LmfgError('args.invalid', {
      message: `Pass either ${usage}, not both.`,
    })
  }
  if (input.json !== undefined)
    return parseInlineJson(input.json, `--${name}-json`)
  if (input.file !== undefined) return readJson(ctx.resolvePath(input.file))
  if (!required) return undefined
  throw new LmfgError('args.invalid', { message: `Pass ${usage}.` })
}

/** `--params <file>` or `--params-json <json>`; defaults apply when neither is given. */
export async function loadParams(
  ctx: CommandContext,
  source: { params?: string; paramsJson?: string },
): Promise<RenderParams> {
  const json = await readJsonInput(
    ctx,
    'params',
    { file: source.params, json: source.paramsJson },
    false,
  )
  return parseRenderParams(json ?? {})
}

export type RenderSessionContext = {
  store: SessionStore
  record: SessionRecord
  source: LoadedSource
  environment: RenderEnvironment
}

export async function openRenderSession(
  ctx: CommandContext,
): Promise<RenderSessionContext> {
  assertTierAvailable(ctx.options.tier)
  const store = createSessionStore(ctx.workspaceRoot)
  const record = await store.load(ctx.requireSession())
  const source = await loadSessionSource(record)
  return {
    store,
    record,
    source,
    environment: resolveRenderEnvironment(ctx.options.memoryProfile),
  }
}

export async function resolveParamsAndLut(
  ctx: CommandContext,
  params: RenderParams,
): Promise<{ params: RenderParams; lut: ResolvedLut | null }> {
  return { params, lut: await resolveLutForParams(params.lut, ctx.cwd) }
}

export async function withRuntime<T>(
  ctx: CommandContext,
  run: (runtime: LmfgRuntime) => Promise<T>,
): Promise<T> {
  const runtime = createLmfgRuntime({
    memoryProfile: ctx.options.memoryProfile,
  })
  try {
    return await run(runtime)
  } finally {
    runtime.dispose()
  }
}
