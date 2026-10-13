# Changelog

All notable changes to `@lumaforge/luma-color-runtime` are documented here.
The format follows Keep a Changelog; versions follow semver. Releases up to
0.1.1 predate this file.

## Unreleased

### Breaking

- `buildStoredContractSelection` returns a
  `LUTContractResult<StoredLUTContractSelection>`: `{ ok: true, value }`, or
  `{ ok: false, issues }` listing every reason the selection cannot be
  stored, instead of `undefined`.
- `resolveUnsupportedLUTOutputReason` returns an
  `UnsupportedLUTOutputReason` (`{ code, message }`) instead of the message
  alone. `code` is `incomplete-output` while the output still has to be
  stated and `unsupported-output` when the stated output cannot be encoded,
  so callers no longer read the cause from the message text.

## 0.2.1 - 2026-10-12

A minor release over the published 0.1.1: it removes and changes public
exports. 0.2.0 was published by mistake from a stale pre-release build and has
been unpublished; npm does not allow that version again, so this release ships
as 0.2.1. Read every entry below as a change from 0.1.1.

Publish order: `@lumaforge/luma-native-artifacts` 0.0.5, then
`@lumaforge/luma-color-runtime` 0.2.1, `@lumaforge/luma-jpeg-runtime` 0.2.0
and `@lumaforge/luma-raw-runtime` 0.2.0, then `@lumaforge/render-engine`
0.2.0, then `@lumaforge/lmfg-cli` 0.2.0, then `@lumaforge/lmfg-mcp` 0.1.0.
`@lumaforge/render-engine` 0.2.0 and `@lumaforge/lmfg-cli` 0.2.0 depend on
this exact version.

### Breaking

- The `./glsl` subpath is removed, with every GLSL string it exported
  (`LUMA_COLOR_BALANCE_GLSL`, `LUMA_COLOR_LUT_GLSL`, `LUMA_COLOR_OKLAB_GLSL`,
  `LUMA_COLOR_RANGE_GLSL`, `LUMA_COLOR_SELECTIVE_COLOR_GLSL`,
  `LUMA_COLOR_TONE_GLSL`, `LUMA_COLOR_TRANSFER_GLSL`,
  `LUMA_COLOR_USER_SATURATION_GLSL`), and the package entry no longer exports
  `LUMA_COLOR_OKLAB_GLSL` or `LUMA_COLOR_SELECTIVE_COLOR_GLSL`. There is no
  GLSL replacement; WebGPU hosts import the WGSL equivalents from `./wgsl`
  (see Added). `mat3ToGLSL` is renamed `mat3ToColumnMajor`, with the same
  result.
- `ProcessingParams` (`LumaColorProcessingParams`) no longer has `viewMode` or
  `compareSplit`, and `selectiveColor` is required. The color graph never
  read the view fields; pass view state to the preview on its own. Build a
  complete record, or pass partial HSL through `normalizeColorGraphIntent` or
  `normalizeSelectiveColorParams` first.
- `resolveExportColorGraph` requires `selectiveColor` on its input
  (`ExportColorGraphInput`) as complete bands. Missing scalar user fields
  still read as neutral; partial HSL goes through `normalizeColorGraphIntent`
  first.
- The binary LUT input projection is removed: `LUTInputProfile`,
  `inferLUTInputProfile`, `toCompatInputProfile`, `ParsedLUT.inputProfile` and
  `LUTData.inputProfile` (`LumaColorLUTData.inputProfile`). Its
  `'display-srgb' | 'v-log'` value drove nothing in the color graph. Read the
  LUT's `profileResolution` instead: a confirmed resolution carries the full
  input profile (its `id`, `inputGamut` and `inputTransfer`).
- `resolveLUTProfile` no longer reads the V-Log shorthand `vlog` or
  `vloginput` (in any case or punctuation, such as `V-Log`) in a `.cube`
  file's `LUMAFORGE_INPUT_PROFILE` metadata as `panasonic-vgamut-vlog`. Such
  metadata confirms a contract only when its `LUMAFORGE_INPUT_GAMUT`,
  `LUMAFORGE_INPUT_TRANSFER` and `LUMAFORGE_INPUT_RANGE` state the input on
  their own; otherwise the LUT falls back to name-based recommendations
  instead of a confirmed contract. Write the canonical profile ID. Profile
  IDs and the aliases the profile registry lists, such as `displaysrgb` for
  `display-srgb`, still resolve.
- The HSL-optional intent types `UserColorIntentSource` and
  `ColorGraphIntentSource` are removed, and six intent helpers that accepted
  them now take a complete intent: `pickUserColorIntent` and
  `userColorIntentSignature` take a `UserColorIntent`, `userColorIntentEquals`
  two of them; `pickColorGraphIntent` and `colorGraphIntentSignature` take a
  `ColorGraphIntent`, `colorGraphIntentEquals` two of them. A record without
  `selectiveColor` no longer type-checks, and the two pick helpers no longer
  fill a missing `selectiveColor` with neutral HSL: called from JavaScript
  without one, they copy `undefined`. Pass a complete `UserColorIntent` or
  `ColorGraphIntent`; pass partial input through `normalizeUserColorIntent`
  or `normalizeColorGraphIntent` first. These types and the HSL-optional
  signatures were exported only after the published 0.1.1, in the
  unreleased window this release closes, so no published version had them;
  the entry is for code built against the repository's package entry in
  that window.

### Added

- The `./wgsl` subpath: the WGSL color helpers a WebGPU preview composes
  (`LUMA_COLOR_BALANCE_WGSL`, `LUMA_COLOR_LUT_WGSL`, `LUMA_COLOR_OKLAB_WGSL`,
  `LUMA_COLOR_RANGE_WGSL`, `LUMA_COLOR_SELECTIVE_COLOR_WGSL`,
  `LUMA_COLOR_TONE_WGSL`, `LUMA_COLOR_TRANSFER_WGSL`,
  `LUMA_COLOR_USER_SATURATION_WGSL`) and the shared `LUT_RANGE_UNIFORMS`,
  `LUT_ROLE_UNIFORMS` and `LUT_TRANSFER_UNIFORMS` codes. They follow the TS
  row-band executor that export runs, including how a display LUT blends
  below full strength and how a display look's declared output gamut maps
  back to sRGB.
- A canonical color intent, separate from view state. `UserColorIntent` holds
  every user tone, color balance, saturation and HSL field as required;
  `LookSelection` holds the look (`styleKind`, `builtinPreset`, built-in
  presets included) and its continuous `intensity`; `ColorGraphIntent` is
  both. View mode, compare split, RAW render exposure, LUT data and geometry
  are not part of it. `UserColorIntentInput`, `LookSelectionInput` and
  `ColorGraphIntentInput` are the partial shapes the normalizers accept.
- Field sets (`USER_COLOR_SCALAR_KEYS`, `USER_COLOR_INTENT_KEYS`,
  `LOOK_SELECTION_KEYS`, `COLOR_GRAPH_INTENT_KEYS`, `LOOK_STYLE_KINDS`,
  `BUILTIN_STYLE_PRESETS`) and bounds (`USER_COLOR_FIELD_BOUNDS`,
  `HSL_SHIFT_BOUNDS`, `LOOK_INTENSITY_BOUNDS`).
- `normalizeUserColorIntent`, `normalizeLookSelection`,
  `normalizeLookIntensity` and `normalizeColorGraphIntent`, built on the
  existing tone, color balance, saturation and HSL normalizers (same NaN and
  clamp behavior). Normalization is idempotent and is the one entry for
  partial input. A look strength is clamped to 0..1 and never snapped to a
  detent; a non-finite strength becomes the `defaultIntensity` the caller
  passes. The package ships no default strength, since entry points differ
  (the app starts a look at 0.7, `lmfg` renders at 1).
- `pickUserColorIntent`, `pickLookSelection` and `pickColorGraphIntent` copy
  a complete intent out of a larger record, such as `ProcessingParams`,
  without changing a value.
- `colorGraphIntentSignature`, `userColorIntentSignature`,
  `colorGraphIntentEquals` and `userColorIntentEquals`: identity of a
  complete intent that ignores key order and anything outside the intent,
  reads user fields as the export color graph does (every spelling of
  neutral HSL shares one signature), and keeps the look strength as given.
- HSL helpers: `HSL_BAND_IDS`, `HSL_SHIFT_AXES`, `HSLShiftAxis`,
  `HSL_SHIFT_MIN`/`HSL_SHIFT_MAX`, the deeply frozen `NEUTRAL_HSL_BAND`,
  `NEUTRAL_SELECTIVE_COLOR` and `NEUTRAL_USER_COLOR_INTENT`, the
  `SelectiveColorBandsInput` type, and `isHSLBandNeutral` /
  `isSelectiveColorNeutral`.
- `ExportColorGraphInput` names the input of `resolveExportColorGraph`.
- `ParsedLUT.sha256`: the SHA-256 of the source `.cube` bytes, when the
  caller records it, for manifest LUT identity.
- `storedContractToLUTColorProfile`: the LUT color profile a stored contract
  confirms, named by its input profile's canonical ID, or by
  `${inputGamut}-${inputTransfer}` when the contract names no input profile.
  `resolveLUTProfile` already named such profiles this way; the browser
  app's stored contract choices and `lmfg`'s explicit contracts now use it
  too instead of building the name themselves.

### Changed

- `normalizeSelectiveColorParams` accepts partial bands and axes and a `null`
  `selectiveColor` in its parameter type. It already handled them at runtime;
  its output is unchanged.
- `ProcessingParams` keeps its name and its color fields, and `styleKind:
  'builtin'` with `builtinPreset` stays valid; `resolveExportColorGraph`
  still refuses a built-in preset with `unsupported-pipeline`.
