import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

import { describe, expect, it } from 'vitest'

import { createHost } from './host.js'

const repoRoot = resolve(import.meta.dirname, '../../..')
const sourcePath = resolve(
  repoRoot,
  'packages/luma-raw-runtime/fixtures/.cache/public/raw-pixls-iphone-se.dng',
)
if (process.env.LMFG_REQUIRE_FIXTURE === '1' && !existsSync(sourcePath))
  throw new Error(
    'The public DNG fixture is required for agent host integration tests.',
  )

describe('real MCP editing host', () => {
  it.skipIf(!existsSync(sourcePath))(
    'views a real RAW candidate, exports it, and proves exact replay',
    async () => {
      const runDir = await mkdtemp(join(tmpdir(), 'lmfg-agent-host-'))
      const workspace = join(runDir, 'workspace')
      await mkdir(workspace)
      const lutPath = join(runDir, 'display.cube')
      await writeFile(
        lutPath,
        '# LUMAFORGE_ROLE=display-look\n# LUMAFORGE_INPUT_PROFILE=display-srgb\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n',
      )
      const host = await createHost({
        repoRoot,
        sourcePath,
        workspace,
        lutPaths: [lutPath],
        toolTimeoutMs: 60000,
        record: async () => {},
      })
      async function execute(
        name: string,
        args: Record<string, unknown>,
        step: number,
      ) {
        const result = await host.execute(name, args, step)
        expect(
          result.result.isError,
          JSON.stringify(result.result.content),
        ).not.toBe(true)
        return result
      }
      try {
        expect(
          host.tools.some((tool) => tool.function.name === 'lmfg_lut_fetch'),
        ).toBe(false)
        const initialized = await execute(
          'lmfg_session_init',
          { source: sourcePath },
          1,
        )
        const session = (
          initialized.result.structuredContent?.result as { id: string }
        ).id
        const otherSource = join(runDir, 'other.dng')
        await writeFile(otherSource, 'not the authorized RAW')
        expect(
          (await host.execute('lmfg_inspect', { file: otherSource }, 2)).result
            .isError,
        ).toBe(true)
        await execute('lmfg_inspect', { session }, 2)
        const unsafe = await host.execute(
          'lmfg_render_export',
          {
            session,
            iteration: '../../not-real',
            candidate: 'warm',
            output: '../../../../escaped',
          },
          2,
        )
        expect(JSON.stringify(unsafe.result.content)).toContain(
          'Unsafe artifact selector',
        )
        const rendered = await execute(
          'lmfg_render_candidate',
          {
            session,
            plan: {
              base: { lut: { path: lutPath } },
              candidates: [
                { id: 'warm', params: { exposure_ev: 1.2, temperature: 8 } },
              ],
            },
            concurrency: 1,
          },
          3,
        )
        const iteration = (
          rendered.result.structuredContent?.result as { iteration_id: string }
        ).iteration_id
        const viewed = await execute(
          'lmfg_image_read',
          {
            session,
            artifact: {
              kind: 'candidate',
              iteration_id: iteration,
              candidate_id: 'warm',
            },
          },
          4,
        )
        expect(
          viewed.result.content.some((part) => part.type === 'image'),
        ).toBe(true)
        await execute(
          'lmfg_render_export',
          { session, iteration, candidate: 'warm', output: 'final' },
          5,
        )
        const region = { x: 1200, y: 1200, width: 1000, height: 700 }
        const detail = await execute(
          'lmfg_export_detail',
          { session, export_name: 'final', region },
          6,
        )
        expect(
          detail.result.content.some(
            (part) => part.type === 'image' && part.mimeType === 'image/png',
          ),
        ).toBe(true)
        const completed = await execute(
          'finish_edit',
          {
            session,
            iteration,
            candidate: 'warm',
            export_name: 'final',
            rationale: 'Lift the laptop body while keeping the screen dark.',
            observations: 'White laptop on a black printer.',
          },
          7,
        )
        expect(completed.completion).toMatchObject({
          verified: true,
          dimensions: { width: 4032, height: 3024 },
          replay: { reproduced: true },
          export_details: [{ step: 6, region }],
        })
      } finally {
        await host.close()
        await rm(runDir, { recursive: true, force: true })
      }
    },
    60000,
  )
})
