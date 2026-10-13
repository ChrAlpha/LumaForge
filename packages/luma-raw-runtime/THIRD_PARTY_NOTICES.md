# Third-Party Notices

This package builds a Luma-owned WebAssembly wrapper around pinned upstream native libraries.
The generated `dist/native/luma_raw.wasm` artifact may contain object code from the components below.

## LibRaw

- Component: LibRaw
- Version: 0.22.1
- Source: `https://github.com/LibRaw/LibRaw/archive/refs/tags/0.22.1.tar.gz`
- Locked SHA-256: `e676248284075605aa2697a66eeed7dc258820bd1d4988c724d29edffd726726`
- Package lock: `native/sources.lock.json`
- License files included here:
  - `THIRD_PARTY_LICENSES/LibRaw-COPYRIGHT.txt`
  - `THIRD_PARTY_LICENSES/LibRaw-LICENSE.LGPL.txt`
  - `THIRD_PARTY_LICENSES/LibRaw-LICENSE.CDDL.txt`

Upstream LibRaw states that LibRaw is distributed under LGPL-2.1 or CDDL-1.0 license options.
It also carries upstream copyright and acknowledgement notices for LibRaw LLC, Dave Coffin's `dcraw.c`, DCB/FBDD code, X3F tools, and Adobe DNG SDK code.
Do not remove those notices.

LumaForge does not vendor or link against `libraw-wasm` or `LibRaw-Wasm`; LibRaw is fetched from the pinned upstream source archive and built locally by `native/scripts/build-deps.sh`.

## Little CMS

- Component: Little CMS
- Version: 2.18
- Source: `https://downloads.sourceforge.net/project/lcms/lcms/2.18/lcms2-2.18.tar.gz`
- Locked SHA-256: `ee67be3566f459362c1ee094fde2c159d33fa0390aa4ed5f5af676f9e5004347`
- Package lock: `native/sources.lock.json`
- License file included here:
  - `THIRD_PARTY_LICENSES/LittleCMS-LICENSE.txt`

Little CMS is distributed under the MIT license.
Keep the included copyright and permission notice with redistributed source or binary artifact bundles.

## Compliance Checklist For Native Artifact Distribution

- Keep this file, `LICENSE`, and `THIRD_PARTY_LICENSES/` beside redistributed package artifacts.
- Keep `native/sources.lock.json` so recipients can identify exact native source archives and hashes.
- Keep the native wrapper and build scripts available from this package source tree.
- Run `pnpm --filter @lumaforge/luma-raw-runtime native:verify` before shipping generated native artifacts.
