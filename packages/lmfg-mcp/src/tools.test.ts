import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { runCliTool, toCallToolResult } from './server'
import { findTool, TOOLS } from './tools'

describe('tool table', () => {
  it('names every tool uniquely with a JSON-schema-able input', () => {
    const names = TOOLS.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
    for (const tool of TOOLS) {
      expect(tool.name).toMatch(/^lmfg_[a-z_]+$/)
      const schema = z.toJSONSchema(z.object(tool.inputShape), {
        target: 'draft-2020-12',
        io: 'input',
      })
      expect(schema.type).toBe('object')
    }
  })

  it('builds argv that mirrors the CLI flags', () => {
    expect(
      findTool('lmfg_render_sweep')!.argv({
        session: 'sess_1',
        plan: { axes: { exposure_ev: [0, 1] } },
        quality: 80,
        contact_sheet: true,
        concurrency: 'auto',
        workspace: '.lmfg',
        timeout_ms: 5000,
      }),
    ).toEqual([
      'render',
      'sweep',
      '--plan-json',
      '{"axes":{"exposure_ev":[0,1]}}',
      '--quality',
      '80',
      '--contact-sheet',
      '--concurrency',
      'auto',
      '--workspace',
      '.lmfg',
      '--session',
      'sess_1',
      '--timeout',
      '5000',
    ])
    expect(
      findTool('lmfg_render_export')!.argv({
        session: 'sess_1',
        iteration: 'iter_0001',
        candidate: 'cand_0002',
        yes: true,
      }),
    ).toEqual([
      'render',
      'export',
      '--iteration',
      'iter_0001',
      '--candidate',
      'cand_0002',
      '--session',
      'sess_1',
      '--yes',
    ])
    expect(
      findTool('lmfg_metrics_rank')!.argv({
        session: 's',
        iteration: 'i',
        objective: { 'luma.mean': { target: 0.45 } },
      }),
    ).toEqual([
      'metrics',
      'rank',
      '--iteration',
      'i',
      '--objective',
      '{"luma.mean":{"target":0.45}}',
      '--session',
      's',
    ])
  })
})

describe('every tool builds argv', () => {
  const minimal: Record<string, Record<string, unknown>> = {
    lmfg_version: {},
    lmfg_capabilities: {},
    lmfg_schema_list: {},
    lmfg_schema_show: { id: 'lmfg.params.v1' },
    lmfg_session_init: { source: 'a.dng' },
    lmfg_session_status: { session: 's' },
    lmfg_session_list: {},
    lmfg_inspect: { file: 'a.dng' },
    lmfg_lut_inspect: { lut: 'a.cube' },
    lmfg_lut_contract_infer: { lut: 'a.cube' },
    lmfg_lut_contract_validate: {
      lut: 'a.cube',
      contract: { role: 'display-look' },
    },
    lmfg_lut_fetch: { url: 'https://x/y.cube', sha256: 'a'.repeat(64) },
    lmfg_render_preview: { session: 's' },
    lmfg_render_candidate: { session: 's', plan: { candidates: [] } },
    lmfg_render_sweep: { session: 's', plan: { axes: {} } },
    lmfg_render_export: { session: 's', params: { exposure_ev: 0 } },
    lmfg_render_replay: { manifest: 'm.json', session: 's' },
    lmfg_compare_sheet: { session: 's', iteration: 'i' },
    lmfg_metrics_compute: { session: 's', iteration: 'i', candidate: 'c' },
    lmfg_metrics_compare: { session: 's', iteration: 'i' },
    lmfg_metrics_rank: { session: 's', iteration: 'i', objective: {} },
    lmfg_manifest_verify: { manifest: 'm.json' },
    lmfg_manifest_show: { manifest: 'm.json' },
  }
  const expectedPrefix: Record<string, string[]> = {
    lmfg_version: ['version'],
    lmfg_capabilities: ['capabilities'],
    lmfg_schema_list: ['schema', 'list'],
    lmfg_schema_show: ['schema', 'show', 'lmfg.params.v1'],
    lmfg_session_init: ['session', 'init', '--source', 'a.dng'],
    lmfg_session_status: ['session', 'status', '--session', 's'],
    lmfg_session_list: ['session', 'list'],
    lmfg_inspect: ['inspect', 'a.dng'],
    lmfg_lut_inspect: ['lut', 'inspect', 'a.cube'],
    lmfg_lut_contract_infer: ['lut', 'contract', 'infer', '--lut', 'a.cube'],
    lmfg_lut_contract_validate: [
      'lut',
      'contract',
      'validate',
      '--lut',
      'a.cube',
      '--contract-json',
    ],
    lmfg_lut_fetch: ['lut', 'fetch', '--url', 'https://x/y.cube', '--sha256'],
    lmfg_render_preview: ['render', 'preview', '--session', 's'],
    lmfg_render_candidate: ['render', 'candidate', '--plan-json'],
    lmfg_render_sweep: ['render', 'sweep', '--plan-json'],
    lmfg_render_export: ['render', 'export', '--params-json'],
    lmfg_render_replay: [
      'render',
      'replay',
      '--manifest',
      'm.json',
      '--session',
      's',
    ],
    lmfg_compare_sheet: [
      'compare',
      'sheet',
      '--iteration',
      'i',
      '--session',
      's',
    ],
    lmfg_metrics_compute: [
      'metrics',
      'compute',
      '--iteration',
      'i',
      '--candidate',
      'c',
      '--session',
      's',
    ],
    lmfg_metrics_compare: [
      'metrics',
      'compare',
      '--iteration',
      'i',
      '--session',
      's',
    ],
    lmfg_metrics_rank: [
      'metrics',
      'rank',
      '--iteration',
      'i',
      '--objective',
      '{}',
      '--session',
      's',
    ],
    lmfg_manifest_verify: ['manifest', 'verify', 'm.json'],
    lmfg_manifest_show: ['manifest', 'show', 'm.json'],
  }

  it('covers every tool with validated minimal input', () => {
    expect(Object.keys(minimal).sort()).toEqual(
      TOOLS.map((tool) => tool.name).sort(),
    )
    for (const tool of TOOLS) {
      const parsed = z.object(tool.inputShape).parse(minimal[tool.name])
      const argv = tool.argv(parsed)
      const prefix = expectedPrefix[tool.name]
      expect(argv.slice(0, prefix.length), tool.name).toEqual(prefix)
    }
  })
})

describe('runCliTool / toCallToolResult', () => {
  it('parses the envelope, forwards --quiet, and maps failures to isError', async () => {
    const calls: string[][] = []
    const fake = async (
      argv: readonly string[],
      io: { stdout: (s: string) => void },
    ) => {
      calls.push([...argv])
      io.stdout(
        '{"schema":"lmfg.version.v1","ok":true,"result":{"lmfg":"0.1.0"}}\n',
      )
      return 0
    }
    const run = await runCliTool(['version'], '/tmp', fake as never)
    expect(calls[0]).toEqual(['version', '--quiet'])
    expect(run.envelope.ok).toBe(true)
    const result = toCallToolResult(run)
    expect(result.isError).toBe(false)
    expect(result.structuredContent).toMatchObject({ ok: true, exit_code: 0 })
    expect(
      JSON.parse((result.content[0] as { text: string }).text),
    ).toMatchObject({
      result: { lmfg: '0.1.0' },
    })

    const failing = async (
      _argv: readonly string[],
      io: { stdout: (s: string) => void },
    ) => {
      io.stdout(
        '{"schema":"lmfg.error.v1","ok":false,"error":{"code":"args.invalid","message":"nope"}}\n',
      )
      return 2
    }
    const failed = toCallToolResult(
      await runCliTool(['x'], '/tmp', failing as never),
    )
    expect(failed.isError).toBe(true)
    expect(failed.structuredContent).toMatchObject({
      ok: false,
      exit_code: 2,
      error: { code: 'args.invalid' },
    })

    const silent = async () => 10
    const broken = toCallToolResult(
      await runCliTool(['x'], '/tmp', silent as never),
    )
    expect(broken.isError).toBe(true)
    expect(broken.structuredContent).toMatchObject({
      error: { code: 'internal' },
    })
  })
})
