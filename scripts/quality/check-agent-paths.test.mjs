// @vitest-environment node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  checkDocument,
  createRepoIndex,
  extractCodeSpans,
  runCheck,
} from './check-agent-paths.mjs'

// Runs under `node --test` and under the Vitest app gate.
const { describe, it } = process.env.VITEST
  ? await import('vitest')
  : await import('node:test')

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const checker = fileURLToPath(new URL('check-agent-paths.mjs', import.meta.url))

const FILES = {
  'AGENTS.md': '# Map\n',
  'package.json': JSON.stringify({
    dependencies: { motion: '1.0.0' },
    devDependencies: { '@playwright/test': '1.0.0' },
  }),
  'packages/render-engine/package.json': JSON.stringify({
    name: '@lumaforge/render-engine',
    exports: { '.': './src/index.ts', './export': './src/export/index.ts' },
  }),
  'packages/render-engine/src/index.ts': '',
  'packages/render-engine/src/export/index.ts': '',
  'src/lib/spring.ts': 'one\ntwo\nthree\nfour\nfive\n',
  'src/lib/raw/decoder.ts': '',
  'src/pages/(main)/raw.tsx': '',
  'docs/GUIDE.md': '',
  '.github/workflows/build.yml': '',
}

/**
 * An index over FILES that records every path it is asked about, so a test
 * can prove a secret file name was never looked up or read.
 */
function recordingIndex(files = FILES) {
  const queried = []
  const index = createRepoIndex(Object.keys(files), {
    readFile: (path) => {
      queried.push(path)
      return files[path]
    },
  })
  const recorded = Object.fromEntries(
    Object.entries(index).map(([name, method]) => [
      name,
      (arg) => {
        queried.push(arg)
        return method(arg)
      },
    ]),
  )
  return { index: recorded, queried }
}

function entriesFor(span) {
  const { index } = recordingIndex()
  return checkDocument({
    document: 'AGENTS.md',
    markdown: `\`${span}\`\n`,
    index,
  })
}

function only(span) {
  const entries = entriesFor(span)
  assert.equal(entries.length, 1, `${span} produced ${entries.length} entries`)
  return entries[0]
}

function assertResolves(span, category) {
  const entry = only(span)
  assert.equal(entry.category, category, `${span} category`)
  assert.equal(entry.problem, undefined, `${span}: ${entry.problem}`)
}

function assertUnresolved(span, category, pattern) {
  const entry = only(span)
  assert.equal(entry.category, category, `${span} category`)
  assert.match(entry.problem ?? '', pattern, `${span} problem`)
}

describe('code span extraction', () => {
  it('reads single and double backtick spans with their lines', () => {
    const spans = extractCodeSpans(
      'Intro `src/a.ts` and `b`.\n\nUse ``a `tick` b`` here.\r\nLast `c`\n',
    )
    assert.deepEqual(spans, [
      { text: 'src/a.ts', line: 1 },
      { text: 'b', line: 1 },
      { text: 'a `tick` b', line: 3 },
      { text: 'c', line: 4 },
    ])
  })

  it('reports a span that wraps onto the next line at its opening line', () => {
    assert.deepEqual(extractCodeSpans('one\ntwo `pnpm\ntest:app` three\n'), [
      { text: 'pnpm test:app', line: 2 },
    ])
  })

  it('skips fenced code blocks and never pairs backticks across paragraphs', () => {
    const markdown = [
      'An unmatched ` tick.',
      '',
      '```sh',
      'pnpm `not-a-span`',
      '```',
      '~~~',
      '`also-not`',
      '~~~',
      'Then `real` and \\`escaped`.',
    ].join('\n')
    assert.deepEqual(extractCodeSpans(markdown), [{ text: 'real', line: 9 }])
  })
})

describe('repository paths', () => {
  it('resolves files and directories from the repository root', () => {
    for (const span of [
      'src/lib/spring.ts',
      'src/lib',
      'src/lib/',
      './src/lib/raw/decoder.ts',
      'src/pages/(main)/raw.tsx',
      '.github/workflows/build.yml',
      'AGENTS.md',
      'docs/',
      'src',
    ]) {
      assertResolves(span, 'path')
    }
  })

  it('fails a misspelled src path', () => {
    assertUnresolved('src/lib/sprnig.ts', 'path', /does not exist/)
  })

  it('checks line suffixes against the file', () => {
    for (const span of [
      'src/lib/spring.ts:3',
      'src/lib/spring.ts:2-5',
      'src/lib/spring.ts:4:7',
      'src/lib/spring.ts#L1-L5',
    ]) {
      assertResolves(span, 'path')
    }
    assertUnresolved('src/lib/spring.ts:9', 'path', /line 9 is past the end/)
    assertUnresolved('src/lib/spring.ts:4-2', 'path', /reversed/)
    assertUnresolved('src/lib/sprnig.ts:3', 'path', /does not exist/)
    assertUnresolved('src/lib:3', 'path', /not a file/)
  })

  it('requires a trailing slash to name a directory', () => {
    assertUnresolved('src/lib/spring.ts/', 'path', /not a directory/)
  })

  it('rejects paths that are not written from the repository root', () => {
    assertUnresolved('../outside.md', 'path', /from the repository root/)
    assertUnresolved('src/../src/lib', 'path', /from the repository root/)
  })

  // Every one of these is a literal path a reader would follow. None may fall
  // through to a skipped category just because it does not exist.
  it('never skips an unknown literal path', () => {
    for (const span of [
      'scr/lib/raw/decoder.ts',
      'lib/raw',
      'native/',
      'decoder.ts',
      'content.ts',
      'GUIDE.md',
      './wgsl',
      'docs/GUIDE.md/',
      'docs/superpowers/plans/next.md',
      'src/generated-route.ts',
      '/src/lib/sprnig.ts',
    ]) {
      assertUnresolved(span, 'path', /./)
    }
  })

  it('checks each word of a multi-word span that is not a command', () => {
    const entries = entriesFor('see src/lib/nope.ts, then src/lib/spring.ts')
    const paths = entries.filter((entry) => entry.category === 'path')
    assert.deepEqual(
      paths.map(({ token, problem }) => [token, Boolean(problem)]),
      [
        ['src/lib/nope.ts', true],
        ['src/lib/spring.ts', false],
      ],
    )
  })
})

describe('package specifiers', () => {
  it('resolves workspace exports, declared dependencies, and the src alias', () => {
    for (const span of [
      '@lumaforge/render-engine',
      '@lumaforge/render-engine/export',
      '@playwright/test',
      'motion/react',
      '~/',
      '~/lib/spring',
      '~/lib/raw/decoder.ts',
    ]) {
      assertResolves(span, 'specifier')
    }
  })

  it('fails unknown packages, exports, and alias targets', () => {
    assertUnresolved(
      '@lumaforge/render-engine/nope',
      'specifier',
      /is not an export of @lumaforge\/render-engine/,
    )
    assertUnresolved('@lumaforge/render-enigne', 'specifier', /not a workspace/)
    assertUnresolved('@radix-ui/react-nope', 'specifier', /not a workspace/)
    assertUnresolved(
      '~/lib/sprnig',
      'specifier',
      /does not resolve under src\//,
    )
  })
})

describe('skipped categories', () => {
  const cases = {
    command: [
      'pnpm',
      'pnpm test:app',
      'LMFG_REQUIRE_FIXTURE=1 pnpm test:cli',
      'git merge --ff-only',
      'node scripts/quality/check-agent-paths.mjs',
      'pnpm exec playwright test <spec>',
    ],
    route: ['/', '/raw', '/raw?forcePreview=cpu', '?luts='],
    url: ['https://luma.ichr.me/raw'],
    placeholder: [
      'src/modules/<domain>',
      '.worktrees/<branch-name>',
      'replays/<first 12 hex of the manifest sha256>/',
    ],
    glob: ['packages/luma-*-runtime', 'packages/luma-*-runtime/native/'],
    generated: ['src/generated-routes.ts'],
    excluded: ['docs/superpowers/'],
    identifier: [
      'LazyMotion',
      'window.location',
      '.cube',
      '.lf-landing',
      '--color-lf-*',
      '--ff-only',
      '@deprecated',
      'build:native',
      'LMFG_REQUIRE_FIXTURE=1',
      'lmfg-cli',
      'localhost:5173',
    ],
  }

  for (const [category, spans] of Object.entries(cases)) {
    it(`classifies ${category} spans without failing them`, () => {
      for (const span of spans) assertResolves(span, category)
    })
  }

  it('counts a prose span without paths as one identifier', () => {
    for (const span of [
      "styleKind: 'builtin'",
      'dual-gpu -> jpeg-fallback -> processed-only',
    ]) {
      assert.deepEqual(entriesFor(span), [
        {
          token: span,
          category: 'identifier',
          document: 'AGENTS.md',
          line: 1,
          span,
        },
      ])
    }
  })

  it('never looks up or reads a secret file name', () => {
    // Listed as Git would list untracked, unignored files, so any lookup or
    // line count would reach them.
    const { index, queried } = recordingIndex({
      ...FILES,
      '.env': 'TOKEN=1\n',
      'config/server.pem': 'KEY\n',
    })
    queried.length = 0
    const entries = checkDocument({
      document: 'AGENTS.md',
      markdown: [
        'Never `.env`, `.env.local`, `config/.env.example`, `.env:1`,',
        '`/.env`, `config/server.pem:1`, or `cat .env.local` fixtures.',
      ].join('\n'),
      index,
    })
    assert.deepEqual(
      entries.map(({ category }) => category),
      ['secret', 'secret', 'secret', 'secret', 'secret', 'secret', 'command'],
    )
    assert.deepEqual(queried, [])
  })
})

describe('runCheck', () => {
  it('reports each unresolved entry with its file and line', () => {
    const { index } = recordingIndex()
    const documents = {
      'AGENTS.md': [
        '# Map',
        '',
        'Read `src/lib/spring.ts` and `src/lib/sprnig.ts`.',
        'Run `pnpm test:app` on `/raw`; never `.env`.',
      ].join('\n'),
      'docs/GUIDE.md': 'See `@lumaforge/render-engine/nope`.\n',
    }
    const result = runCheck({
      documents: ['AGENTS.md', 'docs/GUIDE.md'],
      index,
      readDocument: (path) => documents[path],
    })
    assert.equal(result.ok, false)
    assert.deepEqual(result.errors.slice(0, 2), [
      'AGENTS.md:3: `src/lib/sprnig.ts` does not exist in the repository',
      'docs/GUIDE.md:1: `@lumaforge/render-engine/nope` is not an export of @lumaforge/render-engine',
    ])
    assert.match(result.errors.at(-1), /2 unresolved/)
    assert.ok(
      result.output.includes(
        'AGENTS.md: resolved 1 repository path; 1 unresolved',
      ),
      result.output.join('\n'),
    )
    assert.ok(
      result.output.includes(
        'AGENTS.md: skipped 1 command, 1 route, 1 secret file name (not looked up)',
      ),
      result.output.join('\n'),
    )
  })

  it('refuses documents that are not tracked Markdown files', () => {
    const { index, queried } = recordingIndex()
    for (const document of ['.env', 'notes.md', 'package.json']) {
      queried.length = 0
      let read = false
      assert.throws(
        () =>
          runCheck({
            documents: [document],
            index,
            readDocument: () => {
              read = true
              return ''
            },
          }),
        /tracked Markdown file/,
      )
      assert.equal(read, false, document)
      if (document === '.env') assert.deepEqual(queried, [])
    }
  })
})

describe('the committed agent map', () => {
  it('names no unresolved repository path, and the check writes nothing', () => {
    const agents = `${repoRoot}AGENTS.md`
    const before = {
      text: readFileSync(agents, 'utf8'),
      stat: statSync(agents),
    }

    const result = runCheck()

    assert.deepEqual(result.errors, [])
    assert.equal(result.ok, true)
    assert.equal(readFileSync(agents, 'utf8'), before.text)
    assert.equal(statSync(agents).mtimeMs, before.stat.mtimeMs)
  })

  it('exits 0 from the command line, and 2 for a secret file argument', () => {
    const ok = spawnSync(process.execPath, [checker], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    assert.equal(ok.status, 0, ok.stderr)
    assert.match(ok.stdout, /^AGENTS\.md: resolved \d+ repository paths/m)
    assert.match(ok.stdout, /^AGENTS\.md: skipped .*commands/m)

    const refused = spawnSync(process.execPath, [checker, '.env'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    assert.equal(refused.status, 2)
    assert.match(refused.stderr, /tracked Markdown file/)
  })
})

describe('build workflow', () => {
  const workflow = readFileSync(
    `${repoRoot}.github/workflows/build.yml`,
    'utf8',
  ).replaceAll('\r\n', '\n')

  /** The lines of one top-level job, up to the next job. */
  function job(name) {
    const match = new RegExp(`^ {2}${name}:\\n((?: {4,}.*\\n|\\n)*)`, 'm').exec(
      workflow,
    )
    assert.ok(match, `job ${name} is not defined`)
    return match[1]
  }

  it('runs the path check on every change, docs-only included', () => {
    const quality = job('quality')
    assert.doesNotMatch(quality, /^ {4}(?:if|needs):/m)
    assert.match(
      quality,
      /run: node scripts\/quality\/check-agent-paths\.mjs$/m,
    )
    assert.match(
      quality,
      /run: node --test scripts\/quality\/check-agent-paths\.test\.mjs$/m,
    )
  })

  it('fails the aggregate build unless the quality job passed', () => {
    const build = job('build')
    assert.match(build, /^ {4}needs: \[[^\]]*\bquality\b[^\]]*\]$/m)
    assert.match(build, /QUALITY_RESULT: \$\{\{ needs\.quality\.result \}\}/)
    assert.match(build, /"\$QUALITY_RESULT" != "success"/)
  })
})
