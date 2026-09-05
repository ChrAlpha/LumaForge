<div align="right"><strong>🇬🇧English</strong> | <strong><a href="./README_zh.md">🇨🇳中文</a></strong></div>

# LumaForge

<p align="center">
  <img src="./public/favicon.png" width="88" height="88" alt="LumaForge" />
</p>

<p align="center">
  <strong>Put the LUTs you love on RAW photos, right in the browser.</strong>
</p>

<p align="center">
  Drop one camera RAW file, preview it locally, choose a look or declared
  <code>.cube</code> LUT contract, compare the result, and export a
  full-resolution JPEG.
</p>

<p align="center">
  <a href="https://luma.ichr.me/raw"><strong>Open the RAW lab</strong></a>
  ·
  <a href="https://luma.ichr.me">Product page</a>
  ·
  <a href="./docs/README.md">Help</a>
  ·
  <a href="#local-development">Run locally</a>
  ·
  <a href="#architecture">Architecture</a>
</p>

<p align="center">
  <a href="https://github.com/chralpha/lumaforge/actions/workflows/build.yml">
    <img alt="Build" src="https://github.com/chralpha/lumaforge/actions/workflows/build.yml/badge.svg" />
  </a>
  <a href="./LICENSE">
    <img alt="License: GPL-3.0" src="https://img.shields.io/badge/license-GPL--3.0-blue.svg" />
  </a>
  <img alt="pnpm" src="https://img.shields.io/badge/package%20manager-pnpm-F69220.svg" />
  <img alt="Browser-local" src="https://img.shields.io/badge/processing-browser--local-2f6fed.svg" />
</p>

## The Promise

Many photographers already have LUTs they like: camera looks, film recipes,
cinematic finishes, or a small personal collection of `.cube` files.
LumaForge
makes that workflow approachable for RAW photos without asking the user to study
every detail of gamuts, log curves, signal ranges, and output transforms first.

The product focuses on one clear path:

```text
single RAW file -> preview -> look or LUT -> compare -> JPEG export
```

It keeps the source image on the device, turns the color details a LUT needs
into guided contract choices, and lets the user stay focused on finishing the
photo.

## Why It Feels Simple

| What the user wants              | How LumaForge helps                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Try favorite LUTs on RAW photos. | Search or choose the LUT input and output profile with plain labels.                                 |
| See the image quickly.           | Use embedded, quick, and bounded HQ preview stages.                                                  |
| Keep the photo private.          | Process the selected file locally in the browser.                                                    |
| Finish one photo without setup.  | Avoid accounts, uploads, native helpers, and license managers.                                       |
| Export confidently.              | Rebuild the full-resolution JPEG through the worker path when the source and contract are supported. |

Professional tools such as Lightroom, Capture One, and DaVinci Resolve remain
excellent when a photographer wants full editing control, catalogs, node graphs,
or production-grade grading freedom.
LumaForge chooses a smaller, friendlier
route for the moment when someone simply wants to turn one RAW file into a
finished JPEG with a look they already enjoy.

## What You Can Do

- Load a single RAW file locally from common camera formats such as ARW, NEF,
  RAF, RW2, ORF, DNG, CR2, CR3, PEF, SRW, IIQ, 3FR, FFF, and related RAW
  extensions.
- See an early visible image through embedded, quick, and bounded HQ preview
  stages.
- Compare original and processed output with the WebGL2 preview renderer.
- Choose built-in finishes: Neutral, Warm, Cool, Film Soft, Film Contrast,
  Cinematic, Fade, and Mono.
- Adjust light finishing controls such as exposure, contrast, and look strength
  without turning the app into a full development cockpit.
- Upload a custom `.cube` LUT and declare its input and output contract.
- Work with profile families such as ARRI LogC, RED Log3G10, Sony S-Log,
  Panasonic V-Log, Fujifilm F-Log, Canon Log, Nikon N-Log, ACES, and display
  sRGB.
- Export a full-resolution JPEG through a bounded worker path, with download,
  share, and clipboard actions where the browser supports them.

## LUT Contracts

The color path is scene-referred until final JPEG output:

```text
RAW file
-> @lumaforge/luma-raw-runtime
-> metadata, embedded preview, quick/HQ decode, export capability facts
-> Linear ProPhoto scene-referred working image
-> LUT input gamut and transfer/log encoding
-> built-in look or declared .cube LUT
-> declared LUT output transform
-> Rec.709/sRGB JPEG output
```

LUT contracts are the small bit of structure that lets LumaForge apply creative
looks to RAW files without making the user build a color pipeline by hand.
When
the LUT already carries useful metadata, LumaForge can use it.
When it needs
more information, the app asks for the LUT input and output profile with a
searchable contract browser.

If the selected source file or LUT contract is not supported by the
full-resolution export path yet, LumaForge explains what is missing and holds
export until the final JPEG can be reproduced by the authoritative worker path.

## Product Boundary

LumaForge is an active browser RAW + LUT pipeline.
The current supported baseline
is a modern desktop browser with WebGL2.
Mobile browsers, unusual RAW layouts,
and files that cannot expose the required processed-window facts may be marked
experimental or unsupported.

The product deliberately does not include:

- cloud upload as a requirement;
- accounts or project catalogs;
- batch processing;
- a local daemon or native helper;
- a full desktop-style RAW development panel;
- AI denoise, masking, lens correction, or unlimited adjustment stacks.

## Architecture

The app is split around the same boundary the product sells: interactive preview
and authoritative export share color intent, but they are not the same executor.

- `packages/luma-raw-runtime`: browser RAW metadata, preview extraction, decode
  sessions, processed-window access, export capability facts, and pinned native
  artifacts.
- `packages/luma-color-runtime`: pure TypeScript color math, LUT contracts,
  transfer/gamut transforms, graph logic, row processing, and GLSL helpers.
- `packages/luma-jpeg-runtime`: bounded row-oriented JPEG encoding.
- `src/lib/gl`: WebGL2 interactive preview rendering.
- `src/lib/export`: worker-driven full-resolution export path.
- `src/modules/raw-processor`: the `/raw` workflow for upload, preview, style
  selection, LUT contract selection, compare, status, and export actions.

### Command line: `lmfg`

`packages/lmfg-cli` ships `lmfg`, a Node.js CLI for agents and scripts that
runs the same RAW → look → export pipeline headlessly with sealed render
manifests. See `packages/lmfg-cli/README.md` for the agent loop, JSON protocol,
and exit codes. Build it with `pnpm cli:build`.

## Local Development

Requirements:

- Node.js compatible with the repo toolchain
- pnpm 10.18.0
- A modern desktop browser with WebGL2

Install dependencies:

```bash
pnpm install
```

Start the development server:

```bash
pnpm dev
```

Open:

```text
http://localhost:5173/raw
```

Common checks:

```bash
pnpm lint
pnpm test:run
pnpm build
```

This repository uses `pnpm` only.

## Native Runtime

The RAW and JPEG runtimes are workspace packages.
Their native inputs are pinned
and rebuilt from recorded sources.
Do not make the app depend on `libraw-wasm`,
`LibRaw-Wasm`, or local baseline artifact paths; the current RAW boundary is
`@lumaforge/luma-raw-runtime`.

Production builds prefer the prebuilt `@lumaforge/luma-native-artifacts` package
when its native files are available.
Development serving defaults to workspace
source artifacts.
Override selection with `LUMAFORGE_NATIVE_RUNTIME_MODE`:

- `auto`: prefer prebuilt artifacts, then fall back to workspace artifacts.
- `prebuilt`: require `@lumaforge/luma-native-artifacts` artifacts.
- `source`: require workspace `packages/*/dist/native` artifacts.

Native commands:

```bash
pnpm native:prepare
pnpm native:build
pnpm native:verify
pnpm --filter @lumaforge/luma-raw-runtime test
```

Before publishing refreshed native artifacts:

```bash
pnpm native:build
pnpm native:verify
pnpm native:artifacts:sync
pnpm native:artifacts:verify
pnpm native:artifacts:pack
```

Public RAW smoke fixtures can be fetched with:

```bash
pnpm --filter @lumaforge/luma-raw-runtime fixtures:fetch-public
```

## Contributing

Keep contributions aligned with the product boundary: one RAW file, local
preview, look or LUT, comparison, and trustworthy JPEG export.
Color and LUT
changes should keep contracts explicit: declared input gamut, transfer/log
curve, LUT role, output handling, and export-readiness behavior should remain
clear to users.

## License

LumaForge is distributed under GPL-3.0.
See [LICENSE](./LICENSE).

The RAW and native artifact packages carry third-party native notices for
LibRaw, Little CMS, libjpeg-turbo, and the pinned Emscripten toolchain.
See
[packages/luma-raw-runtime/THIRD_PARTY_NOTICES.md](./packages/luma-raw-runtime/THIRD_PARTY_NOTICES.md)
before redistributing native artifacts.
