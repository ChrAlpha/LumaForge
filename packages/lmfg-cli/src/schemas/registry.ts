import type { ZodType } from 'zod'
import { z } from 'zod'

import { LutContractInputSchema, RenderParamsSchema } from './params'
import { CandidatePlanSchema, SweepPlanSchema } from './plan'
import * as results from './results'

type SchemaEntry = { schema: ZodType; description: string }

export const SCHEMA_REGISTRY: Record<string, SchemaEntry> = {
  'lmfg.version.v1': {
    schema: results.VersionResultSchema,
    description: 'Result of `lmfg version`.',
  },
  'lmfg.capabilities.v1': {
    schema: results.CapabilitiesResultSchema,
    description: 'Result of `lmfg capabilities`.',
  },
  'lmfg.schema.list.v1': {
    schema: results.SchemaListResultSchema,
    description: 'Result of `lmfg schema list`.',
  },
  'lmfg.schema.show.v1': {
    schema: results.SchemaShowResultSchema,
    description: 'Result of `lmfg schema show`.',
  },
  'lmfg.session.v1': {
    schema: results.SessionRecordSchema,
    description:
      'Session record (`session.json`) and result of `lmfg session init`.',
  },
  'lmfg.session.status.v1': {
    schema: results.SessionStatusResultSchema,
    description: 'Result of `lmfg session status`.',
  },
  'lmfg.session.list.v1': {
    schema: results.SessionListResultSchema,
    description: 'Result of `lmfg session list`.',
  },
  'lmfg.inspect.v1': {
    schema: results.InspectResultSchema,
    description: 'Result of `lmfg inspect`.',
  },
  'lmfg.lut.inspect.v1': {
    schema: results.LutInspectResultSchema,
    description: 'Result of `lmfg lut inspect`.',
  },
  'lmfg.lut.contract.infer.v1': {
    schema: results.LutContractInferResultSchema,
    description: 'Result of `lmfg lut contract infer`.',
  },
  'lmfg.lut.contract.validate.v1': {
    schema: results.LutContractValidateResultSchema,
    description: 'Result of `lmfg lut contract validate`.',
  },
  'lmfg.params.v1': {
    schema: RenderParamsSchema,
    description: 'Render parameters file accepted by `--params`.',
  },
  'lmfg.plan.v1': {
    schema: CandidatePlanSchema,
    description: 'Candidate plan file accepted by `render candidate --plan`.',
  },
  'lmfg.sweep.v1': {
    schema: SweepPlanSchema,
    description: 'Sweep plan file accepted by `render sweep --plan`.',
  },
  'lmfg.contract.v1': {
    schema: LutContractInputSchema,
    description:
      'LUT contract selection accepted by `--contract` and `params.lut.contract`.',
  },
  'lmfg.render.preview.v1': {
    schema: results.PreviewResultSchema,
    description: 'Result of `lmfg render preview`.',
  },
  'lmfg.render.candidate.v1': {
    schema: results.IterationResultSchema,
    description: 'Result of `lmfg render candidate`.',
  },
  'lmfg.render.sweep.v1': {
    schema: results.IterationResultSchema,
    description: 'Result of `lmfg render sweep`.',
  },
  'lmfg.render.export.v1': {
    schema: results.ExportResultSchema,
    description: 'Result of `lmfg render export`.',
  },
  'lmfg.compare.sheet.v1': {
    schema: results.CompareSheetResultSchema,
    description: 'Result of `lmfg compare sheet`.',
  },
  'lmfg.metrics.v1': {
    schema: results.MetricsSchema,
    description: 'Per-candidate `metrics.json`.',
  },
  'lmfg.metrics.compute.v1': {
    schema: results.MetricsResultSchema,
    description: 'Result of `lmfg metrics compute`.',
  },
  'lmfg.manifest.verify.v1': {
    schema: results.ManifestVerifyResultSchema,
    description: 'Result of `lmfg manifest verify`.',
  },
  'lmfg.manifest.show.v1': {
    schema: results.ManifestShowResultSchema,
    description: 'Result of `lmfg manifest show`.',
  },
  'lmfg.dry-run.v1': {
    schema: results.DryRunResultSchema,
    description: 'Result of any command run with `--dry-run`.',
  },
  'lmfg.error.v1': {
    schema: results.ErrorEnvelopeSchema,
    description: 'Error envelope written on failure.',
  },
  'lmfg.event.v1': {
    schema: results.EventSchema,
    description: 'NDJSON event line written with `--emit ndjson`.',
  },
}

export function listSchemas(): Array<{ id: string; description: string }> {
  return Object.entries(SCHEMA_REGISTRY).map(([id, entry]) => ({
    id,
    description: entry.description,
  }))
}

export function showSchema(
  id: string,
): {
  id: string
  description: string
  json_schema: Record<string, unknown>
} | null {
  const entry = SCHEMA_REGISTRY[id]
  if (!entry) return null
  const jsonSchema = z.toJSONSchema(entry.schema, {
    target: 'draft-2020-12',
    unrepresentable: 'any',
    io: 'input',
  }) as Record<string, unknown>
  return {
    id,
    description: entry.description,
    json_schema: { $id: id, ...jsonSchema },
  }
}
