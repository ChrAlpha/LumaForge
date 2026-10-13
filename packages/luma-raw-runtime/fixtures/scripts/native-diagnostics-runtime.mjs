import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { loadNativeModuleForNode } from '@lumaforge/luma-native-artifacts/load-for-node'

import {
  buildProcessedWindowRequest,
  captureStage,
  stageError,
  stageOk,
} from './compatibility-report.mjs'

const stageNames = [
  'open',
  'thumbnail',
  'quick',
  'boundedHq',
  'exportCapability',
  'processedWindow',
]

const notAttemptedDurationMs = stageOk(0).durationMs

function pickFinite(target, source, key) {
  if (Number.isFinite(source[key])) {
    target[key] = source[key]
  }
}

export function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return undefined
  }

  const normalized = {}

  for (const key of ['make', 'model']) {
    if (metadata[key] !== undefined) {
      normalized[key] = metadata[key]
    }
  }

  for (const key of [
    'width',
    'height',
    'rawWidth',
    'rawHeight',
    'orientation',
    'baselineExposure',
  ]) {
    pickFinite(normalized, metadata, key)
  }

  if (metadata.thumbnail && typeof metadata.thumbnail === 'object') {
    const { width, height, format } = metadata.thumbnail
    normalized.thumbnail = { width, height, format }
  }

  return normalized
}

/**
 * The package's own Node runtime over the native build in `dist/native`, so
 * the diagnostics decode with the settings the runtime ships.
 */
export async function createDiagnosticsRuntime({
  packageDir,
  profile = 'desktop',
}) {
  const { createLumaRawRuntimeForNode } = await import(
    pathToFileURL(path.join(packageDir, 'dist', 'node.js')).href
  )
  const nativeDir = path.join(packageDir, 'dist', 'native')
  return createLumaRawRuntimeForNode({
    memoryProfile: profile,
    nativeLoader: (options) =>
      loadNativeModuleForNode({ kind: 'raw', nativeDir, ...options }),
  })
}

function notAttempted(message) {
  return stageError(new Error(message), notAttemptedDurationMs)
}

export async function diagnoseNativeFixture({
  fixturePath,
  fixture,
  runtime,
  memoryProfile = 'desktop',
  quickMaxOutputPixels = 2_500_000,
  boundedHqMaxOutputPixels = 8_000_000,
}) {
  const data = new Uint8Array(await readFile(fixturePath))
  const { version } = await runtime.init()
  const stages = {}
  let metadata
  let capability

  const open = await captureStage(() =>
    runtime.openSession(
      { data, name: fixture.file },
      { maxOutputPixels: quickMaxOutputPixels },
    ),
  )
  stages.open = open.stage
  const session = open.value

  if (session) {
    try {
      metadata = normalizeMetadata(session.probe)

      stages.thumbnail = (
        await captureStage(async () => {
          const preview = await session.extractEmbeddedPreview()
          if (!preview) throw new Error('thumbnail unavailable')
          return preview
        })
      ).stage

      stages.quick = (
        await captureStage(() =>
          session.decodeQuick({ maxOutputPixels: quickMaxOutputPixels }),
        )
      ).stage
      stages.boundedHq = (
        await captureStage(() =>
          session.decodeBoundedHq({
            maxOutputPixels: boundedHqMaxOutputPixels,
          }),
        )
      ).stage

      const exportCapability = await captureStage(() =>
        session.probeExportCapability(),
      )
      stages.exportCapability = exportCapability.stage
      capability = exportCapability.value

      stages.processedWindow =
        capability?.supported === true &&
        capability.strategy === 'libraw-processed-window' &&
        capability.windows?.librawProcessed === true
          ? (
              await captureStage(() =>
                session.readProcessedWindow(
                  buildProcessedWindowRequest(capability),
                ),
              )
            ).stage
          : notAttempted(
              'processed-window not attempted because export capability is unsupported',
            )
    } finally {
      session.dispose()
    }
  }

  return {
    fixture,
    runtime: { version, memoryProfile },
    ...(metadata !== undefined ? { metadata } : {}),
    stages: Object.fromEntries(
      stageNames.map((name) => [
        name,
        stages[name] ?? notAttempted(`${name} not attempted`),
      ]),
    ),
    ...(capability !== undefined ? { capability } : {}),
  }
}
