import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { findCycles } from './check-cycles.mjs'

it('reports a cycle through a tsconfig path and an unresolved import', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lf-cycles-'))
  try {
    mkdirSync(join(root, 'src'))
    const paths = { '~/*': ['./src/*'] }
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths } }),
    )
    writeFileSync(join(root, 'src/a.ts'), "import '~/b'\nimport './gone'\n")
    writeFileSync(join(root, 'src/b.ts'), "import './a'\nimport './b.css'\n")
    writeFileSync(join(root, 'src/b.css'), '')
    expect(await findCycles({ root, dirs: ['src'] })).toEqual({
      modules: 2,
      cycles: [['src/a.ts', 'src/b.ts']],
      skipped: ['./gone'],
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
