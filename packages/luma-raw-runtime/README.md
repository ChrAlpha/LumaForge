# @lumaforge/luma-raw-runtime

Browser-local RAW decoding runtime for LumaForge.

This package owns the Luma RAW worker protocol, TypeScript facade, native C++ wrapper, and Emscripten build that produces `luma_raw.js`, `luma_raw.wasm`, and `provenance.json` for each memory profile under `dist/native/desktop/` and `dist/native/low-memory/`.

## Entries

- `@lumaforge/luma-raw-runtime`: the browser runtime, its worker protocol, types, and error codes.
- `@lumaforge/luma-raw-runtime/node`: `createLumaRawRuntimeForNode`, the same runtime core in-process for Node.js (used by `lmfg`). It loads the native module through `@lumaforge/luma-native-artifacts/load-for-node` unless the caller passes its own loader.

Decode sessions keep `applyCalibration` (a DCP camera calibration profile applied to the session); the `/raw` workflow and `lmfg` apply no camera calibration.

## Native Build Policy

The native runtime is rebuilt from pinned upstream source archives.
It must not depend on the npm `libraw-wasm` package, the `LibRaw-Wasm` repository, or any local baseline artifact path.

Pinned native inputs are recorded in `native/sources.lock.json`:

| Component      | Version | Role                                                 | License source                                                                                                                              |
| -------------- | ------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| LibRaw         | 0.22.1  | RAW metadata, thumbnail extraction, and RGB16 decode | `THIRD_PARTY_LICENSES/LibRaw-COPYRIGHT.txt`, `THIRD_PARTY_LICENSES/LibRaw-LICENSE.LGPL.txt`, `THIRD_PARTY_LICENSES/LibRaw-LICENSE.CDDL.txt` |
| Little CMS     | 2.18    | ICC/color management support linked into LibRaw      | `THIRD_PARTY_LICENSES/LittleCMS-LICENSE.txt`                                                                                                |
| Emscripten SDK | 5.0.6   | WebAssembly toolchain                                | pinned in `native/sources.lock.json`                                                                                                        |

Prerequisites: an activated Emscripten SDK (`emcc`, `emconfigure`, `emmake`), `autoreconf`, `libtoolize` or `glibtoolize`, and `pkg-config`. The build scripts stop with a message naming a missing tool. Use the SDK version the lock pins: provenance records it, but the build does not check the active `emcc` version.

Run:

```bash
pnpm --filter @lumaforge/luma-raw-runtime native:fetch
pnpm --filter @lumaforge/luma-raw-runtime build:native
pnpm --filter @lumaforge/luma-raw-runtime native:verify
pnpm --filter @lumaforge/luma-raw-runtime native:verify-baseline
```

`native:fetch` downloads the locked archives and checks their SHA-256. `build:native` builds both memory profiles (`build:native:desktop` and `build:native:low-memory` build one) and writes each profile's `provenance.json`. `native:verify` checks each profile's artifacts and the current source lock against that provenance and then runs `native:verify-baseline`.

`native:verify-baseline` is the active guard that prevents reintroducing `libraw-wasm`, `LibRaw-Wasm`, `BASELINE_ROOT`, or local `/workspaces/LumaForge` build inputs into the package build.

## Licensing

LumaForge-owned source in this package is licensed under GPL-3.0-only.
See `LICENSE`.

The generated native WebAssembly artifacts contain third-party code.
Those components are not relicensed by LumaForge:

- LibRaw is distributed by upstream under LGPL-2.1 or CDDL-1.0 license options.
- Little CMS is distributed under the MIT license.

Keep `THIRD_PARTY_NOTICES.md` and `THIRD_PARTY_LICENSES/` with any redistributed package or native artifact bundle.
If upstream native sources are modified, record the patch under `native/patches/`, keep the original notices intact, and update `THIRD_PARTY_NOTICES.md`.

Before external redistribution, verify the exact distribution form with legal review.
This package documentation is a compliance inventory, not legal advice.
