import { existsSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

import {
  assertNativeRuntimeAssets,
  resolveNativeRuntimeAssets,
  resolveWorkspaceRoot,
} from './assets.mjs'

const artifactPackageDir = 'packages/luma-native-artifacts'

const requiredPackageFiles = [
  `${artifactPackageDir}/LICENSE`,
  `${artifactPackageDir}/THIRD_PARTY_NOTICES.md`,
  `${artifactPackageDir}/THIRD_PARTY_LICENSES/LibRaw-LICENSE.LGPL.txt`,
  `${artifactPackageDir}/THIRD_PARTY_LICENSES/libjpeg-turbo-LICENSE.md`,
  `${artifactPackageDir}/native/provenance/raw-desktop.json`,
  `${artifactPackageDir}/native/provenance/raw-low-memory.json`,
  `${artifactPackageDir}/native/provenance/jpeg.json`,
]

export async function verifyNativeArtifactPackage({
  rootDir = process.cwd(),
} = {}) {
  rootDir = resolveWorkspaceRoot(rootDir)
  const assetSets = resolveNativeRuntimeAssets({
    rootDir,
    mode: 'prebuilt',
    env: {
      ...process.env,
      LUMAFORGE_NATIVE_ARTIFACTS_DIR: artifactPackageDir,
    },
    fileExists: existsSync,
  })
  assertNativeRuntimeAssets(assetSets)

  for (const file of requiredPackageFiles) {
    try {
      await access(join(rootDir, file))
    } catch (error) {
      throw new Error(`Missing native artifact package file: ${file}`, {
        cause: error,
      })
    }
  }
}

if (import.meta.main) {
  verifyNativeArtifactPackage().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
