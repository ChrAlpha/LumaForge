export function stableErrorCode(error) {
  if (error && typeof error === 'object' && typeof error.code === 'string') {
    return error.code
  }

  return undefined
}

export function stageOk(durationMs) {
  if (Number.isFinite(durationMs)) {
    return { ok: true, durationMs }
  }

  return { ok: true }
}

export function stageError(error, durationMs) {
  const message = error instanceof Error ? error.message : String(error)
  const code = stableErrorCode(error)

  return {
    ok: false,
    ...(code ? { code } : {}),
    message,
    ...(Number.isFinite(durationMs) ? { durationMs } : {}),
  }
}

export async function captureStage(callback) {
  const startedAt = performance.now()

  try {
    const value = await callback()
    return {
      stage: stageOk(performance.now() - startedAt),
      value,
    }
  } catch (error) {
    return {
      stage: stageError(error, performance.now() - startedAt),
      value: undefined,
    }
  }
}

export function normalizeCapability(capability) {
  if (!capability) {
    return undefined
  }

  return {
    supported: Boolean(capability.supported),
    ...(capability.strategy !== undefined
      ? { strategy: capability.strategy }
      : {}),
    reasons: Array.isArray(capability.reasons) ? [...capability.reasons] : [],
    ...(capability.sensor !== undefined ? { sensor: capability.sensor } : {}),
    ...(capability.orientation !== undefined
      ? { orientation: capability.orientation }
      : {}),
    ...(capability.visibleCrop !== undefined
      ? { visibleCrop: capability.visibleCrop }
      : {}),
    ...(capability.windows !== undefined ? { windows: capability.windows } : {}),
  }
}

export function classifyEntry(entry) {
  if (!entry.stages.open?.ok) {
    return 'open-failed'
  }

  const hasPreview = ['thumbnail', 'quick', 'boundedHq'].some(
    (stageName) => entry.stages[stageName]?.ok,
  )

  if (
    hasPreview &&
    entry.capability?.supported === true &&
    entry.capability.strategy === 'libraw-processed-window' &&
    entry.capability.windows?.librawProcessed === true &&
    entry.stages.processedWindow?.ok === true
  ) {
    return 'supported'
  }

  if (hasPreview) {
    return 'preview-only'
  }

  return 'metadata-only'
}

export function buildProcessedWindowRequest(capability) {
  const width = Math.max(1, Math.min(64, capability.width))
  const height = Math.max(1, Math.min(64, capability.height))

  return {
    outputRect: {
      x: Math.floor((capability.width - width) / 2),
      y: Math.floor((capability.height - height) / 2),
      width,
      height,
    },
    halo: { left: 0, top: 0, right: 0, bottom: 0 },
  }
}

export function buildReportEntry({
  fixture,
  runtime,
  metadata,
  stages,
  capability,
}) {
  const normalizedCapability = normalizeCapability(capability)
  const entry = {
    fixture: {
      name: fixture.name,
      file: fixture.file,
      source: fixture.source,
      ...(fixture.deviceBrand !== undefined
        ? { deviceBrand: fixture.deviceBrand }
        : {}),
      ...(fixture.deviceModel !== undefined
        ? { deviceModel: fixture.deviceModel }
        : {}),
      rawFamily: fixture.rawFamily,
      purpose: fixture.purpose,
    },
    runtime,
    ...(metadata !== undefined ? { metadata } : {}),
    stages,
    ...(normalizedCapability !== undefined
      ? { capability: normalizedCapability }
      : {}),
  }

  return {
    ...entry,
    classification: classifyEntry(entry),
  }
}
