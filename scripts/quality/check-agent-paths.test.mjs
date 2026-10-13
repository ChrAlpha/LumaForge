import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

import { checkAgentPaths, loadRepo } from './check-agent-paths.mjs'

const repo = loadRepo()
const check = (markdown) => checkAgentPaths(markdown, repo)

it('resolves every path the committed AGENTS.md names', () => {
  const agents = readFileSync(
    new URL('../../AGENTS.md', import.meta.url),
    'utf8',
  )
  expect(check(agents)).toEqual([])
})

it('fails a mistyped path, package export, or ~/ module', () => {
  expect(
    check(
      'See `src/lib/webgpu/contract.tsx` and\n`@lumaforge/render-engine/gone`, `~/lib/nope`, `README.md` and `READ_ME.md`.',
    ),
  ).toEqual([
    'AGENTS.md:1: `src/lib/webgpu/contract.tsx` does not resolve',
    'AGENTS.md:2: `@lumaforge/render-engine/gone` does not resolve',
    'AGENTS.md:2: `~/lib/nope` does not resolve',
    'AGENTS.md:2: `READ_ME.md` does not resolve',
  ])
})

it('skips commands, routes, URLs, placeholders, globs, and fences', () => {
  expect(
    check(
      [
        '`pnpm exec vitest run src/gone.ts` `/raw?forcePreview=cpu` `https://x.dev/a.md`',
        '`src/modules/<domain>` `src/**/*.ts` `motion/react` `window.location` `~/lib/spring`',
        '```',
        '`src/gone.ts`',
        '```',
      ].join('\n'),
    ),
  ).toEqual([])
})
