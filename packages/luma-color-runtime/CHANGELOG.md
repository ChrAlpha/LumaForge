# Changelog

All notable changes to `@lumaforge/luma-color-runtime` are documented here.
The format follows Keep a Changelog; versions follow semver. Releases up to
0.1.1 predate this file.

## Unreleased

### Breaking

- `TransferFunctionId` gains `pq` (SMPTE ST 2084) and `hlg` (BT.2100 HLG).
  Code that switches exhaustively over the union needs a case for each.
- A confirmed LUT whose output transfer is `pq` or `hlg` is refused by
  `resolveExportColorGraph` and `resolveUnsupportedLUTOutputReason`
  (`unsupported-output`, cause `output-transfer-hdr`): mapping an HDR signal
  to the SDR JPEG needs a tone mapping the contract does not declare. Text
  inference resolves LUT names such as `to PQ`, `to HLG`, `to Rec.2100` or
  `to HDR10` as `unsupported-output`.

- Removed `ProcessingParams`, a duplicate of `ColorGraphIntent`. Use
  `ColorGraphIntent` for the complete color intent and `LookSelection` for
  its look fields.
- Removed the `lookupStoredProfile` option of `parseCubeLUT` and
  `resolveLUTProfile`, and the `fingerprint` input that only fed it. The
  parser no longer reads stored contracts; a host that keeps user contracts
  applies them to the parsed LUT by its `fingerprint`.
- `buildStoredContractSelection` returns a
  `LUTContractResult<StoredLUTContractSelection>`: `{ ok: true, value }`, or
  `{ ok: false, issues }` listing every reason the selection cannot be
  stored, instead of `undefined`.
- `resolveUnsupportedLUTOutputReason` returns an
  `UnsupportedLUTOutputReason` (`{ code, message }`) instead of the message
  alone. `code` is `incomplete-output` while the output still has to be
  stated and `unsupported-output` when the stated output cannot be encoded,
  so callers no longer read the cause from the message text.
- Removed exports no consumer read: `LOG_TO_WORKING_SPACE`, `LOG_SPACES`,
  `PROPHOTO_LUMA_COEFFS`, `SRGB_LUMA_COEFFS`, `REC2020_LUMA_COEFFS`,
  `METERING_MODES`, `MeteringMode`, `getColorSpaceDefinition`, the LUT
  lattice `read`, `resolveSaturationParams`, `userColorIntentEquals` and
  `colorGraphIntentEquals` (compare `userColorIntentSignature` or
  `colorGraphIntentSignature` instead), and the `ColorGraphStep`,
  `ColorGraph` and `SupportedColorGraph` aliases of `ExportColorGraphStep`,
  `ExportColorGraphDescriptor` and `SupportedExportColorGraphDescriptor`.
- Removed `LOG_FUNCTIONS`, `getLogEncoder` and `getLogDecoder`, a second
  name-keyed transfer registry that fell back to S-Log3 for an unknown name.
  Resolve a transfer with `getTransferFunction`, which returns `undefined`
  for a name it does not know, or read `TRANSFER_FUNCTIONS` by id.
- `ReadyPreviewHistogram` no longer carries `diagnostics`, and
  `FinishPreviewHistogramInput` no longer takes `ownership` or
  `inputByteLength`; `HistogramInputOwnership` is removed. Nothing read them.
- `LumaColorLUTData` and `LumaColorProcessingParams` are removed; they were
  second names for `LUTData` and `ProcessingParams`.
- `getGamutMatrix(src, dst)` takes `ColorGamutId`s and throws for an id
  outside the gamut table; it no longer accepts display names or aliases and
  no longer returns an identity matrix with a warning for an unknown space.
  `getProPhotoToTargetMatrix`, `getLinearProPhotoToGamutMatrix`,
  `getLinearGamutMatrix` and `getLUTOutputToTargetMatrix` are removed; call
  `getGamutMatrix('prophoto-rgb', target)` or `getGamutMatrix(src, dst)`.
  Resolve a name or alias to an id with `getColorGamut` first.
- `COLOR_SPACES` is keyed by `ColorGamutId`, and `ColorSpaceDef` drops `id`,
  `gamma` and `source` (`COLOR_GAMUT_SOURCE_URLS` holds the sources);
  `COLOR_GAMUT_TO_COLOR_SPACE` and `resolveColorSpaceKey` are removed.
- The package entry no longer exports internals of the color math that no
  consumer imported: the individual transfer encode and decode functions and
  `linearTransfer` (reach them through `TRANSFER_FUNCTIONS` or
  `getTransferFunction`), the DCP helpers `mccamyXyToCct`, `xyFromXyz`,
  `invert3x3`, `matVec3` and `matLerp9`, the selective color band helpers
  and constants `adjacentBandCenters`, `wrapFraction`, `mixBandShift`,
  `applySelectiveColorRow`, `BAND_CENTERS_RAD`, `HUE_MAX_DELTA_RAD`,
  `SAT_MAX_FACTOR` and `LIGHT_MAX_DELTA`, the OKLab matrices `M_*` and
  `signedCbrt`, `clamp01`, `mix`, `sampleLutTrilinear`,
  `compressLutInputToDomain`, `RgbTuple`, `MutableRgbTuple`, `mat3Multiply`,
  `mat3Invert`, `COLOR_GAMUTS`, `inferLUTColorProfileHints`,
  `estimateRawRenderExposureFromRgbU16`, `applyUserSaturationTo`,
  `USER_SATURATION_MIN`/`MAX` and `USER_VIBRANCE_MIN`/`MAX` (read
  `USER_COLOR_FIELD_BOUNDS`), `COLOR_SPACES`, `ColorSpaceDef`,
  `COLOR_GAMUT_SOURCE_URLS`, `D50_WHITE`, `D65_WHITE` and `ACES_WHITE`.
- The RGB reference copies of the tone and color balance math, which export
  never ran, are removed: `applyUserExposureRgb`, `applyUserContrastRgb`,
  `applyUserRegionalToneRgb`, `applyUserToneRgb` and their `Into` variants,
  `applyColorBalanceRgb(Into)`, `userContrastScaleFromLuminance`,
  `userRegionalToneEvFromLuminance`, `userRegionalToneScaleFromLuminance`,
  `hasUserRegionalTone`, `linearProPhotoLuminanceFromRgb`,
  `regionalToneEvFromLuminance`, and the `Rgb`, `MutableRgb`,
  `ColorBalanceRgb` and `MutableColorBalanceRgb` types. The row-band
  executor is the reference; it scales RGB by `contrastScaleFromLuminance`
  and `regionalToneScaleFromLuminance`.

### Added

- `RAW_RENDER_EXPOSURE_SOURCES`, the provenance values
  `RawRenderExposureSource` names, for readers that validate a recorded one.
- `contrastScaleFromLuminance(luminance, factor, pivot)` and
  `hasRegionalTone(input)`, the scalar contrast and regional tone helpers the
  row-band executor runs.
- `EXPORT_PLAIN_STEP_KINDS` and `EXPORT_LUT_STEP_KINDS`, the step sequences
  of a supported export graph without and with a LUT. The row-band executor
  accepts exactly these, and manifest readers validate against them.
- `resolveEffectiveLUTOutputTransfer(profile)`: the output transfer a LUT
  applies, the declared one or a display look's input transfer.
- `UnsupportedLUTOutputReason.cause` (`UnsupportedLUTOutputCause`): the
  contract gap behind a refused LUT output (`output-range-unknown`,
  `output-profile-missing`, `output-transfer-linear`,
  `output-transfer-hdr`), so readers report it without restating the export
  rules.
- The BT.2100 HDR signal encodings as LUT transfers: `pq` and `hlg`, with
  TS and WGSL encode/decode. Linear 1.0 is HDR Reference White (203 cd/m²,
  58% PQ, 75% HLG); HLG is the scene-referred OETF without the display
  OOTF. `HDR_TRANSFER_IDS`, `HdrTransferFunctionId` and `isHdrTransfer`
  name them.
- The HDR reference constants: `HDR_REFERENCE_WHITE_NITS` (203),
  `HDR_NOMINAL_PEAK_NITS` (1000), `HDR_NOMINAL_PEAK_LINEAR` and
  `PQ_PEAK_NITS`.
- Built-in input profiles `rec2100-pq` and `rec2100-hlg` (BT.2020 primaries
  with PQ or HLG), and `Rec.2100`, `BT.2100` and `ITU-R BT.2100` as aliases of
  the `rec2020` gamut.
- The HDR rendition of a gain-map export and its ISO 21496-1 gain map.
  `createHdrGainMapRowBandProcessor` writes the SDR bytes
  `createRowBandProcessor` writes, plus one gain map code per sample that
  lifts them to the scene the look renders in linear BT.2020 (1.0 is HDR
  Reference White, clipped at the nominal peak). Every gain map shares one fixed range
  (`HDR_GAIN_MAP_LOG2_MIN`, `HDR_GAIN_MAP_LOG2_MAX`, with zero gain at
  `HDR_GAIN_MAP_NEUTRAL_CODE`), primaries `HDR_GAIN_MAP_GAMUT`, offsets
  `HDR_GAIN_MAP_OFFSET`, gamma `HDR_GAIN_MAP_GAMMA`, and headrooms `HDR_GAIN_MAP_BASE_HEADROOM` and
  `HDR_GAIN_MAP_ALTERNATE_HEADROOM`; `hdrGainMapLog2FromCode` reads a code as
  a decoder does. A gain outside the range throws
  `HDR_GAIN_MAP_OUT_OF_RANGE` before anything is encoded.
  `resolveHdrGainMapSupport` gives a graph an HDR rendition when it has no
  LUT, or when its LUT keeps the scene (`lutHasHdrRendition`: a
  scene-creative LUT whose output is a scene-referred log encoding, decoded
  back to scene light and mixed with the edited scene by the look strength);
  any other LUT outputs a display signal (`lut-display-output`).
  `isSceneLogTransfer` and `isDisplayTransfer` name the two kinds of
  encoding.
- HDR preview views for a display of any range (`HdrPreviewView`,
  `HDR_PREVIEW_VIEWS`): `above-sdr` dims the SDR picture to gray and tints
  what the HDR rendition lifts above SDR white, from
  `HDR_ABOVE_SDR_LOW_TINT` to `HDR_ABOVE_SDR_HIGH_TINT` at the nominal peak
  (`HDR_ABOVE_SDR_BASE_SCALE`, `HDR_ABOVE_SDR_FADE_STOPS`); `stop-down`
  divides the HDR rendition by the nominal peak.
  `createHdrPreviewRowBandProcessor` draws them from the scene values the
  gain map is computed from, and `LUMA_COLOR_HDR_PREVIEW_WGSL` holds the
  same views plus the HDR rendition as extended linear sRGB.

### Fixed

- `parseCubeLUT` refuses a `.cube` file that declares a 1D shaper
  (`LUT_1D_SIZE`). It used to skip the keyword and read the shaper rows as
  the first 3D entries, which shifted the whole lattice without an error.
- `parseCubeLUT` reads `LUT_3D_INPUT_RANGE` as the domain of every channel
  instead of ignoring it, and refuses a file whose input range contradicts
  its `DOMAIN_MIN`/`DOMAIN_MAX` lines.

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
