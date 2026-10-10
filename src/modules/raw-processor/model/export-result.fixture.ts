import type { ExportResultIdentity } from './export-result'

/**
 * A minimal export result identity for tests that need to construct a result
 * but do not depend on its identity fields.
 */
export function createMockExportResultIdentity(
  overrides?: Partial<ExportResultIdentity>,
): ExportResultIdentity {
  return {
    resultKind: 'full-resolution',
    attemptId: 'attempt-mock',
    sessionId: 'session-mock',
    source: { name: 'test.dng', size: 1000, lastModified: 0 },
    colorIntent: {
      styleKind: 'none',
      builtinPreset: null,
      intensity: 0,
      userExposureEv: 0,
      userContrast: 0,
      userHighlights: 0,
      userShadows: 0,
      userWhites: 0,
      userBlacks: 0,
      userTemperature: 0,
      userTint: 0,
      userSaturation: 0,
      userVibrance: 0,
      selectiveColor: {
        red: { hue: 0, saturation: 0, lightness: 0 },
        orange: { hue: 0, saturation: 0, lightness: 0 },
        yellow: { hue: 0, saturation: 0, lightness: 0 },
        green: { hue: 0, saturation: 0, lightness: 0 },
        aqua: { hue: 0, saturation: 0, lightness: 0 },
        blue: { hue: 0, saturation: 0, lightness: 0 },
        purple: { hue: 0, saturation: 0, lightness: 0 },
        magenta: { hue: 0, saturation: 0, lightness: 0 },
      },
    },
    lut: null,
    rawRenderExposure: null,
    geometry: null,
    inputSignature: 'mock-signature',
    ...overrides,
  }
}
