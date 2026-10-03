<div align="right"><strong>🇬🇧English</strong> | <strong><a href="./USER_GUIDE_zh.md">🇨🇳中文</a></strong></div>

# RAW Lab Guide

This guide covers the normal LumaForge flow:

```text
single RAW file -> preview -> look or LUT -> compare -> JPEG export
```

You do not need to understand every color-management term before using the app.
The important rule is simple: choose the look you want, and let LumaForge hold
export until it can reproduce that look through the full-resolution path.

## 1. Open The RAW Lab

Open `/raw` in a modern browser. A desktop browser with WebGPU is the supported
baseline. Mobile browsers may work for some files, but large RAW files and
browser memory limits can make them less reliable.

Your photo stays on your device. LumaForge does not require an account, cloud
upload, native helper, license manager, or local daemon.

## 2. Load One RAW File

Drop a RAW file into the lab or use the file picker. LumaForge is built around a
single-photo workflow, so start with one source file rather than a folder or
batch.

Supported files depend on what the browser runtime can inspect and decode.
Common camera RAW extensions such as `.arw`, `.nef`, `.raf`, `.rw2`, `.orf`,
`.dng`, `.cr2`, `.cr3`, `.pef`, and `.srw` are expected to be useful, but not
every camera layout exposes the facts needed for safe export.

## 3. Wait For A Useful Preview

The first visible image may come from an embedded or quick preview. LumaForge can
then replace it with a higher-quality preview when the browser and file allow
it.

Preview is for interaction and comparison. Export is separate: the final JPEG is
built through the full-resolution worker path when that path is ready.

## 4. Choose A Look

For the quickest path, choose one of the built-in finishes. They are designed to
work without making you declare a LUT contract.

For a custom `.cube` LUT, add the LUT and choose the input and output contract if
LumaForge asks for it. The contract tells the app what kind of image the LUT
expects and what kind of image it produces.

Good defaults:

- If the LUT is described as a Rec.709 or sRGB creative LUT, start with a display
  Rec.709/sRGB-style contract.
- If the LUT was made for a camera log profile, choose that camera log input
  family, such as ARRI LogC, Sony S-Log, Fujifilm F-Log, Canon Log, Nikon N-Log,
  Panasonic V-Log, or RED Log3G10.
- If you are unsure, preview the result and prefer the contract that keeps skin,
  skies, shadows, and highlights plausible. Avoid contracts that produce crushed
  blacks, neon colors, or washed-out contrast unless that is the intended look.

See [LUT and Export FAQ](./LUT_AND_EXPORT_FAQ.md) for more examples.

## 5. Compare Before Export

Use compare mode to check the original and processed result. This is especially
useful for strong LUTs, because a look that feels good at first can push skin
tones, skies, or shadow detail too far.

Light finishing controls are there to help you land the JPEG. They are not meant
to turn the app into a full desktop RAW editor.

## 6. Export The JPEG

Export becomes available only when LumaForge can rebuild the selected source and
color graph through the full-resolution export path. If export is disabled, read
the status message instead of assuming the preview image can be saved as the
final result.

This is intentional. LumaForge should fail closed rather than silently export a
lower-resolution preview or a JPEG with a different color path than the one you
approved.

## Quick Troubleshooting

If the preview does not appear:

- Try a modern desktop browser with WebGPU.
- Try a smaller RAW file or a different file from the same camera.
- Refresh the page and load the file again.

If the LUT result looks wrong:

- Check whether the LUT was made for display Rec.709/sRGB or a camera log
  profile.
- Try the matching camera log family if the LUT name mentions one.
- Reduce look strength before changing multiple settings.

If export is unavailable:

- Check the export status in the lab.
- Confirm the source file and LUT contract are supported.
- Treat the preview as a preview, not the final export path.
