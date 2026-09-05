// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { listSchemas, showSchema } from './registry'

describe('schema registry', () => {
  it('lists every public schema id', () => {
    const ids = listSchemas().map((entry) => entry.id)
    for (const id of [
      'lmfg.version.v1',
      'lmfg.capabilities.v1',
      'lmfg.schema.list.v1',
      'lmfg.schema.show.v1',
      'lmfg.session.v1',
      'lmfg.session.status.v1',
      'lmfg.session.list.v1',
      'lmfg.inspect.v1',
      'lmfg.lut.inspect.v1',
      'lmfg.lut.contract.infer.v1',
      'lmfg.lut.contract.validate.v1',
      'lmfg.lut.fetch.v1',
      'lmfg.params.v1',
      'lmfg.plan.v1',
      'lmfg.sweep.v1',
      'lmfg.contract.v1',
      'lmfg.render.preview.v1',
      'lmfg.render.candidate.v1',
      'lmfg.render.sweep.v1',
      'lmfg.render.export.v1',
      'lmfg.render.replay.v1',
      'lmfg.compare.sheet.v1',
      'lmfg.metrics.v1',
      'lmfg.metrics.compute.v1',
      'lmfg.manifest.verify.v1',
      'lmfg.manifest.show.v1',
      'lmfg.dry-run.v1',
      'lmfg.error.v1',
      'lmfg.event.v1',
    ]) {
      expect(ids, id).toContain(id)
    }
  })

  it('renders JSON Schema draft 2020-12 for params', () => {
    const shown = showSchema('lmfg.params.v1')
    expect(shown).not.toBeNull()
    expect(shown!.json_schema.$schema).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    )
    expect(
      (shown!.json_schema.properties as Record<string, unknown>).exposure_ev,
    ).toBeDefined()
  })

  it('renders every registered schema without throwing', () => {
    for (const { id } of listSchemas()) {
      expect(showSchema(id)?.json_schema.$id, id).toBe(id)
    }
  })

  it('returns null for unknown ids', () => {
    expect(showSchema('lmfg.nope.v9')).toBeNull()
  })
})
