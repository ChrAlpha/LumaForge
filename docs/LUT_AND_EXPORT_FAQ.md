<div align="right"><strong>🇬🇧English</strong> | <strong><a href="./LUT_AND_EXPORT_FAQ_zh.md">🇨🇳中文</a></strong></div>

# LUT and Export FAQ

This page explains the choices that most often confuse hobbyist RAW users:
which LUT contract to pick, why export can be unavailable, and what browser
support to expect.

## What Is A LUT Contract?

A `.cube` LUT is a table of color changes. It usually assumes a specific kind of
input image, such as display Rec.709, ARRI LogC, Sony S-Log, or another camera
log profile.

The contract tells LumaForge two things:

- Input: what kind of image the LUT expects.
- Output: what kind of image the LUT produces.

Without that information, the same LUT can look flat, too contrasty, too
saturated, or simply wrong.

## Which Contract Should I Pick?

Use the LUT's name, download page, or folder name first. LUT packs often include
clues such as `Rec709`, `sRGB`, `LogC`, `SLog3`, `FLog`, `CLog`, `VLog`, or
`REDLog3G10`.

If the LUT is marketed for finished video, stills, Instagram, or general photo
editing, it is often a display-style Rec.709/sRGB LUT.

If the LUT is marketed for a camera brand or log profile, choose that profile
family. For example:

| LUT clue                    | Try this input family      |
| --------------------------- | -------------------------- |
| `Rec709`, `sRGB`, display   | Rec.709 / sRGB-style input |
| `LogC`, `ARRI`              | ARRI LogC                  |
| `SLog`, `SLog3`, `Sony`     | Sony S-Log                 |
| `FLog`, `F-Log`, `Fujifilm` | Fujifilm F-Log             |
| `CLog`, `Canon Log`         | Canon Log                  |
| `N-Log`, `Nikon`            | Nikon N-Log                |
| `V-Log`, `Panasonic`        | Panasonic V-Log            |
| `REDLog3G10`, `RED`         | RED Log3G10                |

When two choices both seem possible, compare skin tones, skies, neutral walls,
and deep shadows. The better contract usually looks normal before you start
adding extra corrections.

## Why Does A Wrong Contract Look So Bad?

Creative LUTs are not universal filters. A LUT designed for flat camera log
footage expects different brightness and color encoding than a LUT designed for
a normal display image.

Applying the wrong contract can cause:

- crushed or gray shadows;
- clipped highlights;
- oversaturated reds and blues;
- green or magenta skin;
- a flat result that needs too much correction.

LumaForge exposes the contract because hiding it would make the result less
trustworthy.

## Why Is Export Disabled?

Preview and export have different jobs. Preview should become visible quickly.
Export must rebuild the full-resolution JPEG through the supported color path.

Export may be disabled when:

- the RAW file cannot expose the processed-window facts needed for safe export;
- the browser does not have enough capability or memory for the file;
- the selected LUT contract is incomplete or unsupported;
- the export worker cannot prove that it can reproduce the previewed graph.

This is a guardrail. LumaForge should not silently save a lower-quality preview
or change the color path just to make a download button appear.

## Does LumaForge Upload My Photo?

No. The selected RAW file is processed in the browser. The normal workflow does
not require an account, cloud upload, native helper, license activation, or local
daemon.

## Which Browser Should I Use?

Use a modern desktop browser with WebGPU for the best baseline. Large RAW files
can stress browser memory, especially on mobile devices.

Mobile browsers are useful for experimentation and lighter files, but they are
not the strongest target for large full-resolution RAW export.

## Is This A Lightroom Or DaVinci Replacement?

No. LumaForge is intentionally narrower. It is for finishing one RAW photo with a
look or LUT and exporting a JPEG when the path is safe.

Use a full editor when you need catalogs, batch processing, masking, denoise,
lens correction, node graphs, or detailed professional grading controls.

## What Should I Do When A File Fails?

Try this order:

1. Use a modern desktop browser.
2. Try a smaller RAW from the same camera.
3. Try a built-in finish instead of a custom LUT.
4. If a custom LUT is required, confirm the contract from the LUT pack.
5. Keep the unsupported file as a compatibility case rather than forcing export.
