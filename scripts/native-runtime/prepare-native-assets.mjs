import { exec, execFile } from 'node:child_process'
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import {
  assertNativeRuntimeAssets,
  findMissingNativeRuntimeAssets,
  NATIVE_ARTIFACT_PACKAGE,
  resolveNativeRuntimeAssets,
  resolveWorkspaceRoot,
} from './assets.mjs'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)
const artifactPackageDir = 'packages/luma-native-artifacts'

async function readArtifactPackageSpec(rootDir) {
  const packageJsonPath = join(rootDir, artifactPackageDir, 'package.json')
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
  return `${NATIVE_ARTIFACT_PACKAGE}@${packageJson.version}`
}

async function fetchPrebuiltAssetsFromNpm({ rootDir, packageSpec }) {
  const packageDir = join(rootDir, artifactPackageDir)
  const cacheDir = join(packageDir, '.cache')
  await rm(cacheDir, { force: true, recursive: true })
  await mkdir(cacheDir, { recursive: true })

  // Every argument is a package spec or a path relative to the working
  // directory, so none of them carries a drive letter or a space. That keeps
  // the Windows shell from splitting them and keeps Git for Windows' GNU tar
  // from reading `D:` as a remote host.
  const npmArgs = [
    'pack',
    packageSpec,
    '--pack-destination',
    relative(rootDir, cacheDir),
    '--json',
  ]
  // On Windows `npm` is `npm.cmd`, which Node only starts through a shell.
  const { stdout } =
    process.platform === 'win32'
      ? await execAsync(`npm ${npmArgs.join(' ')}`, { cwd: rootDir })
      : await execFileAsync('npm', npmArgs, { cwd: rootDir })
  const [packResult] = JSON.parse(stdout)
  const unpackDir = join(cacheDir, 'unpacked')
  await mkdir(unpackDir, { recursive: true })
  await execFileAsync('tar', ['-xzf', packResult.filename, '-C', 'unpacked'], {
    cwd: cacheDir,
  })

  const unpackedPackageDir = join(unpackDir, 'package')
  await Promise.all([
    cp(join(unpackedPackageDir, 'native'), join(packageDir, 'native'), {
      force: true,
      recursive: true,
    }),
    cp(join(unpackedPackageDir, 'LICENSE'), join(packageDir, 'LICENSE'), {
      force: true,
    }),
    cp(
      join(unpackedPackageDir, 'THIRD_PARTY_LICENSES'),
      join(packageDir, 'THIRD_PARTY_LICENSES'),
      { force: true, recursive: true },
    ),
    cp(
      join(unpackedPackageDir, 'THIRD_PARTY_NOTICES.md'),
      join(packageDir, 'THIRD_PARTY_NOTICES.md'),
      { force: true },
    ),
  ])
}

function shouldFetchPrebuiltAssets(assetSets, { mode, env }) {
  if (assetSets.some((assetSet) => assetSet.source === 'prebuilt')) return true

  const requestedMode = mode ?? env.LUMAFORGE_NATIVE_RUNTIME_MODE ?? 'auto'
  return requestedMode === 'auto'
}

export async function prepareNativeRuntimeAssets({
  rootDir = process.cwd(),
  mode,
  env = process.env,
  fetchPrebuiltAssets = fetchPrebuiltAssetsFromNpm,
} = {}) {
  rootDir = resolveWorkspaceRoot(rootDir)
  let assetSets = resolveNativeRuntimeAssets({ rootDir, mode, env })
  const missingAssets = findMissingNativeRuntimeAssets(assetSets)

  if (
    missingAssets.length > 0 &&
    shouldFetchPrebuiltAssets(assetSets, { mode, env })
  ) {
    const packageSpec = await readArtifactPackageSpec(rootDir)
    await fetchPrebuiltAssets({ rootDir, packageSpec })
    assetSets = resolveNativeRuntimeAssets({
      rootDir,
      mode: mode ?? env.LUMAFORGE_NATIVE_RUNTIME_MODE ?? 'prebuilt',
      env,
    })
  }

  assertNativeRuntimeAssets(assetSets)
  return assetSets
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const assetSets = await prepareNativeRuntimeAssets()
    const sources = [...new Set(assetSets.map((assetSet) => assetSet.source))]
    console.log(`Using ${sources.join(', ')} native runtime assets.`)
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
