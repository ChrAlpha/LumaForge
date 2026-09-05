import { z } from 'zod'

import { LmfgError } from '../protocol/errors'
import { formatCandidateId } from '../workspace/ids'
import type { RenderParams } from './params'
import {
  mergeRenderParams,
  NUMERIC_PARAM_KEYS,
  parseRenderParams,
  RenderParamsOverrideSchema,
  RenderParamsSchema,
} from './params'

export const MAX_CANDIDATES_PER_SWEEP = 64
export const MAX_AXIS_VALUES = 16

export const ContactSheetOptionsSchema = z.strictObject({
  cols: z.int().min(1).max(12).optional(),
  tile_width: z.int().min(64).max(1024).optional(),
  gap: z.int().min(0).max(64).optional(),
})

export const CandidateSpecSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z0-9][\w-]{0,31}$/i)
    .optional(),
  tag: z.string().max(64).optional(),
  params: RenderParamsOverrideSchema.optional(),
})

export const CandidatePlanSchema = z.strictObject({
  schema: z.literal('lmfg.plan.v1').optional(),
  base: RenderParamsSchema.optional(),
  candidates: z.array(CandidateSpecSchema).min(1).max(MAX_CANDIDATES_PER_SWEEP),
  contact_sheet: ContactSheetOptionsSchema.optional(),
})

export const SweepPlanSchema = z.strictObject({
  schema: z.literal('lmfg.sweep.v1').optional(),
  base: RenderParamsSchema.optional(),
  axes: z.partialRecord(
    z.enum(NUMERIC_PARAM_KEYS),
    z.array(z.number()).min(1).max(MAX_AXIS_VALUES),
  ),
  contact_sheet: ContactSheetOptionsSchema.optional(),
})

export type ContactSheetOptions = z.output<typeof ContactSheetOptionsSchema>
export type CandidatePlanInput = z.input<typeof CandidatePlanSchema>
export type SweepPlanInput = z.input<typeof SweepPlanSchema>

export type NormalizedCandidate = {
  id: string
  tag: string | null
  params: RenderParams
}

export type NormalizedPlan = {
  kind: 'candidate' | 'sweep'
  base: RenderParams
  candidates: NormalizedCandidate[]
  contactSheet: ContactSheetOptions | null
}

export function normalizeCandidatePlan(input: unknown): NormalizedPlan {
  const plan = CandidatePlanSchema.parse(input)
  const base = plan.base ?? parseRenderParams({})
  const seen = new Set<string>()
  const candidates = plan.candidates.map((spec, index) => {
    const id = spec.id ?? formatCandidateId(index + 1)
    if (seen.has(id)) {
      throw new LmfgError('args.invalid', {
        message: `Duplicate candidate id "${id}" in plan.`,
      })
    }
    seen.add(id)
    return {
      id,
      tag: spec.tag ?? null,
      params: spec.params ? mergeRenderParams(base, spec.params) : base,
    }
  })
  return {
    kind: 'candidate',
    base,
    candidates,
    contactSheet: plan.contact_sheet ?? null,
  }
}

export function expandSweepPlan(input: unknown): NormalizedPlan {
  const plan = SweepPlanSchema.parse(input)
  const base = plan.base ?? parseRenderParams({})
  const axes = Object.entries(plan.axes).filter(
    (entry): entry is [string, number[]] => Array.isArray(entry[1]),
  )
  if (axes.length === 0) {
    throw new LmfgError('args.invalid', {
      message: 'Sweep plan must declare at least one axis.',
    })
  }
  const total = axes.reduce((count, [, values]) => count * values.length, 1)
  if (total > MAX_CANDIDATES_PER_SWEEP) {
    throw new LmfgError('args.invalid', {
      message: `Sweep expands to ${total} candidates; the limit is ${MAX_CANDIDATES_PER_SWEEP}.`,
    })
  }
  let combos: Array<Array<[string, number]>> = [[]]
  for (const [key, values] of axes) {
    const next: Array<Array<[string, number]>> = []
    for (const combo of combos) {
      for (const value of values) next.push([...combo, [key, value]])
    }
    combos = next
  }
  const candidates = combos.map((combo, index) => ({
    id: formatCandidateId(index + 1),
    tag: combo.map(([key, value]) => `${key}=${value}`).join(','),
    params: mergeRenderParams(
      base,
      RenderParamsOverrideSchema.parse(Object.fromEntries(combo)),
    ),
  }))
  return {
    kind: 'sweep',
    base,
    candidates,
    contactSheet: plan.contact_sheet ?? null,
  }
}
