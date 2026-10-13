import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

export const NATIVE_ARTIFACT_PACKAGE = '@lumaforge/luma-native-artifacts'

const nativeRuntimeAssetSpecs = [
  {
    label: 'Luma RAW runtime desktop',
    packageName: '@lumaforge/luma-raw-runtime',
    targetDir: 'native/desktop',
    files: ['luma_raw.js', 'luma_raw.wasm'],
    prebuiltDir: ['native', 'desktop'],
    sourceDir: ['packages', 'luma-raw-runtime', 'dist', 'native', 'desktop'],
  },
  {
    label: 'Luma RAW runtime low-memory',
    packageName: '@lumaforge/luma-raw-runtime',
    targetDir: 'native/low-memory',
    files: ['luma_raw.js', 'luma_raw.wasm'],
    prebuiltDir: ['native', 'low-memory'],
    sourceDir: ['packages', 'luma-raw-runtime', 'dist', 'native', 'low-memory'],
  },
  {
    label: 'Luma JPEG runtime',
    packageName: '@lumaforge/luma-jpeg-runtime',
    targetDir: 'native',
    files: ['luma_jpeg.js', 'luma_jpeg.wasm'],
    prebuiltDir: ['native'],
    sourceDir: ['packages', 'luma-jpeg-runtime', 'dist', 'native'],
  },
]

/** Native runtime files a build ships, relative to its output directory. */
export function nativeRuntimeAssetPaths() {
  return nativeRuntimeAssetSpecs.flatMap((spec) =>
    spec.files.map((file) => `${spec.targetDir}/${file}`),
  )
}

export function resolveWorkspaceRoot(startDir = process.cwd()) {
  let currentDir = resolve(startDir)

  while (true) {
    if (existsSync(join(currentDir, 'pnpm-workspace.yaml'))) {
      return currentDir
    }

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) return resolve(startDir)
    currentDir = parentDir
  }
}

function resolveMode({ mode, env = process.env } = {}) {
  const resolvedMode = mode ?? env.LUMAFORGE_NATIVE_RUNTIME_MODE ?? 'auto'
  if (!['auto', 'prebuilt', 'source'].includes(resolvedMode)) {
    throw new Error(
      'LUMAFORGE_NATIVE_RUNTIME_MODE must be one of: auto, prebuilt, source',
    )
  }

  return resolvedMode
}

function resolveArtifactPackageRoot({
  rootDir,
  env = process.env,
  resolvePackageRoot,
}) {
  const explicitDir = env.LUMAFORGE_NATIVE_ARTIFACTS_DIR?.trim()
  if (explicitDir) {
    return resolve(rootDir, explicitDir)
  }

  if (resolvePackageRoot) {
    return resolvePackageRoot(NATIVE_ARTIFACT_PACKAGE, rootDir)
  }

  try {
    const require = createRequire(resolve(rootDir, 'package.json'))
    return dirname(require.resolve(`${NATIVE_ARTIFACT_PACKAGE}/package.json`))
  } catch {
    return resolve(rootDir, 'packages', 'luma-native-artifacts')
  }
}

function toAssetSet(spec, source, sourceDir) {
  return {
    ...spec,
    source,
    sourceDir,
  }
}

function resolveAssetSetsForSource(rootDir, source, artifactRoot) {
  return nativeRuntimeAssetSpecs.map((spec) => {
    const sourceDir =
      source === 'prebuilt'
        ? resolve(artifactRoot, ...spec.prebuiltDir)
        : resolve(rootDir, ...spec.sourceDir)

    return toAssetSet(spec, source, sourceDir)
  })
}

export function findMissingNativeRuntimeAssets(
  assetSets,
  { fileExists = existsSync } = {},
) {
  return assetSets.flatMap((assetSet) =>
    assetSet.files
      .filter((fileName) => !fileExists(resolve(assetSet.sourceDir, fileName)))
      .map((fileName) => ({
        assetSet,
        fileName,
      })),
  )
}

export function resolveNativeRuntimeAssets({
  rootDir = process.cwd(),
  mode,
  env = process.env,
  fileExists = existsSync,
  resolvePackageRoot,
} = {}) {
  const resolvedMode = resolveMode({ mode, env })
  const artifactRoot = resolveArtifactPackageRoot({
    rootDir,
    env,
    resolvePackageRoot,
  })

  if (resolvedMode === 'prebuilt') {
    return resolveAssetSetsForSource(rootDir, 'prebuilt', artifactRoot)
  }

  if (resolvedMode === 'source') {
    return resolveAssetSetsForSource(rootDir, 'source', artifactRoot)
  }

  const prebuiltAssets = resolveAssetSetsForSource(
    rootDir,
    'prebuilt',
    artifactRoot,
  )
  if (
    findMissingNativeRuntimeAssets(prebuiltAssets, { fileExists }).length === 0
  ) {
    return prebuiltAssets
  }

  return resolveAssetSetsForSource(rootDir, 'source', artifactRoot)
}

export function assertNativeRuntimeAssets(
  assetSets,
  { fileExists = existsSync } = {},
) {
  const missingAssets = findMissingNativeRuntimeAssets(assetSets, {
    fileExists,
  })

  if (missingAssets.length === 0) return

  const missingSummary = missingAssets
    .map(({ assetSet, fileName }) => `${assetSet.label}: ${fileName}`)
    .join(', ')

  throw new Error(
    `The app requires native runtime assets (${missingSummary}). Install ${NATIVE_ARTIFACT_PACKAGE} or run \`pnpm native:build\` before building the app.`,
  )
}

export function copyNativeRuntimeAssets(assetSets, outputDir) {
  assertNativeRuntimeAssets(assetSets)

  for (const assetSet of assetSets) {
    const nativeOutputDir = resolve(outputDir, assetSet.targetDir)
    mkdirSync(nativeOutputDir, { recursive: true })

    for (const fileName of assetSet.files) {
      copyFileSync(
        resolve(assetSet.sourceDir, fileName),
        resolve(nativeOutputDir, fileName),
      )
    }
  }
}
