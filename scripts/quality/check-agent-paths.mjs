import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * Checks that every repository path AGENTS.md names in backticks exists as
 * Git tracks it (or would track it), so a mistyped or moved path fails. A
 * word is a path when it contains `/` or ends in a file extension; `~/x`
 * resolves under `src/`, and a package specifier must name a workspace
 * package, one of its export subpaths, or a declared dependency. Spans that start with a command
 * and words that are URLs, routes, flags, placeholders, or globs are skipped.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const COMMAND =
  /^(?:[A-Z_]+=\S* )*(?:bash|cd|gh|git|lmfg|lmfg-mcp|node|npm|npx|pnpm|tsc|vite|vitest)\b/
const SKIPPED = /^(?:[a-z]+:\/\/|[/?<-])|[<*{]/
const EXTENSION =
  /^[^.].*\.(?:c|cjs|css|html|js|json|md|mjs|mts|sh|ts|tsx|wasm|wgsl|ya?ml)$/
// Absent from a clean checkout on purpose: generated, or named as a place
// nothing may be committed to.
const ABSENT = new Set(['src/generated-routes.ts', 'docs/superpowers/'])
const MODULE_SUFFIXES = ['', '.ts', '.tsx', '.mjs', '/index.ts', '/index.tsx']

/**
 * @param {string} markdown
 * @param {{ files: string[], packages: Map<string, string[]>,
 *   dependencies: Set<string> }} repo Workspace package names map to their
 *   `exports` keys.
 * @returns {string[]} One problem per word that does not resolve.
 */
export function checkAgentPaths(markdown, { files, packages, dependencies }) {
  const known = new Set(files)
  for (const file of files) {
    for (let at = file.indexOf('/'); at > 0; at = file.indexOf('/', at + 1)) {
      known.add(file.slice(0, at))
    }
  }
  const exists = (path) => known.has(path.replace(/\/$/, ''))
  const resolves = (word) => {
    if (word.startsWith('~/')) {
      return MODULE_SUFFIXES.some((end) => exists(`src/${word.slice(2)}${end}`))
    }
    const [, name, subpath = ''] = /^((?:@[^/]+\/)?[^/]+)(\/.*)?$/.exec(word)
    if (packages.has(name)) {
      return subpath === '' || packages.get(name).includes(`.${subpath}`)
    }
    return exists(word) || dependencies.has(name)
  }
  const unfenced = markdown.replace(/^```[\s\S]*?\n```/gm, (fence) =>
    fence.replace(/[^\n]/g, ''),
  )
  const problems = []
  for (const match of unfenced.matchAll(/`([^`]+)`/g)) {
    const span = match[1].replace(/\s+/g, ' ').trim()
    if (COMMAND.test(span)) continue
    const line = unfenced.slice(0, match.index).split('\n').length
    for (const written of span.split(' ')) {
      const word = written.replace(/^[("'[]+|[)"'\],;:.!?]+$/g, '')
      if (SKIPPED.test(word) || ABSENT.has(word)) continue
      if (!word.includes('/') && !EXTENSION.test(word)) continue
      if (!resolves(word)) {
        problems.push(`AGENTS.md:${line}: \`${word}\` does not resolve`)
      }
    }
  }
  return problems
}

export function loadRepo(root = ROOT) {
  const files = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\0')
    .filter(Boolean)
  const packages = new Map()
  const dependencies = new Set()
  for (const file of files) {
    if (!/^(?:packages\/[^/]+\/)?package\.json$/.test(file)) continue
    const manifest = JSON.parse(readFileSync(`${root}${file}`, 'utf8'))
    if (file !== 'package.json') {
      packages.set(manifest.name, Object.keys(manifest.exports ?? { '.': 1 }))
    }
    const { dependencies: deps, devDependencies, peerDependencies } = manifest
    for (const name of Object.keys({
      ...deps,
      ...devDependencies,
      ...peerDependencies,
    })) {
      dependencies.add(name)
    }
  }
  return { files, packages, dependencies }
}

if (import.meta.main) {
  const markdown = readFileSync(`${ROOT}AGENTS.md`, 'utf8')
  const problems = checkAgentPaths(markdown, loadRepo())
  for (const problem of problems) console.error(problem)
  if (problems.length === 0) console.log('AGENTS.md: every path resolves')
  process.exitCode = problems.length === 0 ? 0 : 1
}
