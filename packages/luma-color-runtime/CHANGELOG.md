# Changelog

All notable changes to `@lumaforge/luma-color-runtime` are documented here.
The format follows Keep a Changelog; versions follow semver. Releases before
0.2.0 predate this file.

## 0.2.0 - Unreleased

### Added

- A canonical color intent, separate from view state. `UserColorIntent` holds
  every user tone, color balance, saturation and HSL field as required;
  `LookSelection` holds the look (`styleKind`, `builtinPreset`, built-in
  presets included) and its continuous `intensity`; `ColorGraphIntent` is
  both. View mode, compare split, RAW render exposure, LUT data and geometry
  are not part of it.
- Field sets (`USER_COLOR_SCALAR_KEYS`, `USER_COLOR_INTENT_KEYS`,
  `LOOK_SELECTION_KEYS`, `COLOR_GRAPH_INTENT_KEYS`, `LOOK_STYLE_KINDS`,
  `BUILTIN_STYLE_PRESETS`) and bounds (`USER_COLOR_FIELD_BOUNDS`,
  `HSL_SHIFT_BOUNDS`, `LOOK_INTENSITY_BOUNDS`).
- `normalizeUserColorIntent`, `normalizeLookSelection`,
  `normalizeLookIntensity` and `normalizeColorGraphIntent`, built on the
  existing tone, color balance, saturation and HSL normalizers (same NaN and
  clamp behavior). Normalization is idempotent. A look strength is clamped to
  0..1 and never snapped to a detent; a non-finite strength becomes the
  `defaultIntensity` the caller passes. The package ships no default
  strength, since entry points differ (the app starts a look at 0.7, `lmfg`
  renders at 1).
- `pickUserColorIntent`, `pickLookSelection` and `pickColorGraphIntent` copy
  the intent out of a larger record, such as `ProcessingParams`, without
  changing a value; missing HSL becomes `NEUTRAL_SELECTIVE_COLOR`.
- `colorGraphIntentSignature`, `userColorIntentSignature`,
  `colorGraphIntentEquals` and `userColorIntentEquals`: identity that ignores
  key order and anything outside the intent, reads user fields as the export
  color graph does, and keeps the look strength as given.
- HSL helpers: `HSL_BAND_IDS`, `HSL_SHIFT_AXES`, `HSLShiftAxis`,
  `HSL_SHIFT_MIN`/`HSL_SHIFT_MAX`, the deeply frozen `NEUTRAL_HSL_BAND`,
  `NEUTRAL_SELECTIVE_COLOR` and `NEUTRAL_USER_COLOR_INTENT`, the
  `SelectiveColorBandsInput` type, and `isHSLBandNeutral` /
  `isSelectiveColorNeutral`.
- `ExportColorGraphInput` names the input of `resolveExportColorGraph`.

### Changed

- `normalizeSelectiveColorParams` accepts partial bands and axes and a `null`
  `selectiveColor` in its parameter type. It already handled them at runtime;
  its output is unchanged.
- `ProcessingParams` is unchanged: `selectiveColor` stays optional and the
  view fields stay on it.
