# @lumaforge/luma-native-artifacts

Prebuilt browser WebAssembly artifacts for LumaForge deployments.

This package is an artifact bundle with one small Node loader, not a runtime
API. The LumaForge app and workspace runtime packages still own the
TypeScript API, worker protocols, native source locks, and source rebuild
scripts. This package exists so production/self-hosted builds and the Node
entries of the RAW and JPEG runtimes can use the generated RAW and JPEG native
artifacts instead of rebuilding LibRaw, Little CMS, and libjpeg-turbo from
source on every deployment.

## Contents

- `native/desktop/luma_raw.js`
- `native/desktop/luma_raw.wasm`
- `native/low-memory/luma_raw.js`
- `native/low-memory/luma_raw.wasm`
- `native/luma_jpeg.js`
- `native/luma_jpeg.wasm`
- `native/provenance/raw.json`
- `native/provenance/jpeg.json`
- `load-for-node.mjs` and `load-for-node.d.mts`
- `CHANGELOG.md`
- `LICENSE`
- `THIRD_PARTY_NOTICES.md`
- `THIRD_PARTY_LICENSES/`

## Node loader

`@lumaforge/luma-native-artifacts/load-for-node` exports
`loadNativeModuleForNode({ kind, memoryProfile })`. It reads the `.wasm`
bytes from this package with `fs` and passes them to the Emscripten glue,
whose Node file-loading branch is empty. `kind` is `'raw'` or `'jpeg'`;
`memoryProfile` (`'desktop'`, the default, or `'low-memory'`) selects the RAW
artifact and is ignored for JPEG. `@lumaforge/luma-raw-runtime/node` and
`@lumaforge/luma-jpeg-runtime/node` load their native modules through it.

## Publish Flow

Build and verify native artifacts from source before syncing this package:

```bash
pnpm native:build
pnpm native:verify
pnpm native:artifacts:sync
pnpm native:artifacts:verify
pnpm native:artifacts:pack
```

`pnpm native:artifacts:sync` copies the current runtime native outputs into
this package and refreshes the compliance files. The copied artifacts are
generated files and are intentionally ignored by git; publish from a verified
working tree after sync. `pnpm native:artifacts:pack` verifies the package
again and runs `npm pack --dry-run`; it uploads nothing.

The RAW and JPEG runtimes depend on the exact version in `package.json`, so
publish this package before them.

## App Build Selection

The root app resolves native assets with `LUMAFORGE_NATIVE_RUNTIME_MODE`:

- `auto`: prefer this prebuilt package when available, otherwise use workspace
  source artifacts.
- `prebuilt`: require this package's native assets.
- `source`: require workspace `packages/*/dist/native` artifacts.

Development serving defaults to `source`. Production builds default to `auto`,
which prefers the prebuilt package. `LUMAFORGE_NATIVE_ARTIFACTS_DIR` points
the prebuilt lookup at another copy of this package.

`pnpm native:prepare` checks that the selected assets exist. In `auto` or
`prebuilt` mode, when they are missing, it downloads this package from npm at
the version in its `package.json` and copies its native assets and compliance
files into `packages/luma-native-artifacts`. A clean checkout without a native
build therefore cannot prepare native assets until that version is published.
