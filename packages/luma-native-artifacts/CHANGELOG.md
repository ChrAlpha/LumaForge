# Changelog

All notable changes to `@lumaforge/luma-native-artifacts` are documented here.
The format follows Keep a Changelog; versions follow semver. Releases before
0.0.4 predate this file.

## 0.0.4 - Unreleased

Publish order: this package, then `@lumaforge/luma-raw-runtime` 0.1.2, then
`@lumaforge/lmfg-cli` 0.1.1, then push `main`. `pnpm native:prepare` fetches
this package from npm at the version in its `package.json` when the workspace
has no native build, so a clean checkout, including the CI app and deploy
builds, cannot prepare native assets until 0.0.4 is published.

### Changed

- The RAW artifacts for both memory profiles (`desktop` and `low-memory`) are
  rebuilt from `@lumaforge/luma-raw-runtime` 0.1.2 sources, which disable
  LibRaw's adaptive white point (`adjust_maximum`) for every decode. Preview
  and export output can change for frames, and for export windows, whose
  decoded peak sat between 75% and 100% of the white level; those rendered
  brighter before, and export strips no longer brighten independently. See
  the `@lumaforge/luma-raw-runtime` changelog for details.
- Toolchain and sources are unchanged (emsdk 5.0.6, LibRaw 0.22.1, Little CMS
  2.18). The RAW provenance records the new source lock, which fetches
  Little CMS from its GitHub release (same archive SHA-256).
- The RAW wasm hashes, and with them the native build ids recorded in render
  manifests, change. Manifests recorded with 0.0.3 artifacts reproduce only on
  that build; `lmfg render replay` (lmfg-cli 0.1.1) refuses them before
  decoding.
- The JPEG artifacts are byte-identical to 0.0.3.
