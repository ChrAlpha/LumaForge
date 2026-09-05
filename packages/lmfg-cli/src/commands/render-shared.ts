import type { RenderEnvironment } from '@lumaforge/render-engine'
import { InvalidArgumentError } from 'commander'

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

export async function loadParamsFile(
  ctx: CommandContext,
  file: string | undefined,
): Promise<RenderParams> {
  return parseRenderParams(file ? await readJson(ctx.resolvePath(file)) : {})
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
