import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { createVitest } from 'vitest/node'

/**
 * Fails unless every test file in the checkout (the Playwright specs under
 * `tests/browser/` aside, not their support tests) runs in exactly one project of the root Vitest
 * config, and in the project that owns its directory: a package's tests in
 * the project named after the package, `src` tests in `app`, and every other
 * test in `tooling`.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/

const ownerOf = (file) =>
  /^packages\/([^/]+)\//.exec(file)?.[1] ??
  (file.startsWith('src/') ? 'app' : 'tooling')

const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard'],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
)
  .split('\n')
  .filter((file) => TEST_FILE.test(file))
  .filter((file) => !/^tests\/browser\/.*\.spec\.ts$/.test(file))
  .filter((file) => existsSync(`${ROOT}${file}`))

const vitest = await createVitest(
  'test',
  { watch: false, run: false, root: ROOT },
  { logLevel: 'silent' },
)
const runs = new Map()
try {
  for (const spec of await vitest.globTestSpecifications()) {
    const file = spec.moduleId.slice(ROOT.length)
    runs.set(file, [...(runs.get(file) ?? []), spec.project.name])
  }
} finally {
  await vitest.close()
}

const problems = []
for (const file of files) {
  const projects = runs.get(file) ?? []
  if (projects.length !== 1 || projects[0] !== ownerOf(file)) {
    problems.push(
      `${file} runs in [${projects.join(', ')}], expected [${ownerOf(file)}]`,
    )
  }
}
for (const file of runs.keys()) {
  if (!files.includes(file))
    problems.push(`${file} is not a repository test file`)
}
for (const problem of problems) console.error(problem)
console.log(
  `test projects: ${files.length} test files, ${problems.length} problems`,
)
process.exitCode = problems.length === 0 ? 0 : 1
