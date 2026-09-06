# RAW lab interaction polish: mobile precision, live preview, parity

**Date:** 2026-09-06
**Status:** approved for implementation (supervisor loop)
**Applies to:** `/raw` desktop tool rail and mobile photo-first shell

## Problem

Baseline visual runs (iPhone 14 Pro viewport 393x660, Chromium touch
emulation and WebKit; desktop Chromium 1440x900) with the Sony ARW fixture
show three classes of defects.

1. **Mobile live preview is occluded.** The Adjust dock is a fixed
   `min(60vh, 360px)` panel over a full-bleed stage. A 3:2 landscape photo
   sits at the vertical centre of the viewport, exactly under the panel.
   During a scrub the sibling rows fade to 25% and the active row stays as an
   opaque plate across the photo centre, so the user judges tone through the
   chrome instead of on the photo.
2. **Mobile touch precision is too coarse.** The slider track is about 170px
   wide for a 200-unit domain (about 1.2 units per px, 0.06 EV per px for
   exposure). A 20px finger travel moved Contrast by 23. A mostly vertical
   drag that starts on a slider changes the value instead of scrolling the
   list (`touch-action: none` plus Radix immediate capture).
3. **Cross-surface inconsistency.** Mobile resets a field by tapping the amber
   value; desktop has no per-field reset. Desktop has no scrub-active state
   beyond hover. The mobile Color list truncates "Temperature". Motion
   presets and dirty-state colour already match and must stay matched.

## Design

### A. Stage insets follow the mobile chrome

The mobile stage keeps its full-bleed substrate, but the photo re-fits into
the region the chrome does not cover.

- `.raw-lab` exposes `--raw-stage-inset-top` and `--raw-stage-inset-bottom`.
  The mobile media block applies them as `.raw-lab-stage` padding with a
  240ms `cubic-bezier(0.22, 1, 0.36, 1)` transition. Desktop ignores them.
- `MobileModeDock` measures its tab bar and the expanded panel with a
  `ResizeObserver` and reports `tabBarHeight + (expanded ? panelHeight : 0)`.
  `MobileLabTopbar` reports its height the same way. `MobileLabChrome` writes
  both values onto the shell element. Immersive mode and the empty state
  write `0`, so entering immersive grows the photo back to full bleed in the
  same motion band as the chrome fade.
- The Adjust panel height drops from `min(60vh, 360px)` to
  `min(38vh, 264px)`, which keeps a 3:2 landscape photo at full width above
  the dock on a 393x660 viewport. Tone and HSL lists scroll inside the panel.
- `PreviewCanvas` keeps CSS sizing immediate but defers the WebGL backing
  store resize and re-render until the container size settles (trailing
  90ms), except for the first fit. During the padding transition the canvas
  is CSS-scaled, which is visually continuous because the track keeps the
  photo aspect ratio. `OriginalWebglLayer` follows the same rule.

### B. One scrub interaction model for both surfaces

A shared hook, `useSliderScrub`, owns pointer interaction for every Adjust
slider row. The Radix `Slider` stays as the visual and keyboard layer; the
row wrapper intercepts `pointerdown` in the capture phase so Radix never
starts its own absolute drag.

Touch (`pointerType === 'touch'` or `pen`):

- `touch-action: pan-y` on the row. Pointer down records the start point and
  does not change the value.
- Direction lock at 6px of travel. Horizontal locks the scrub, captures the
  pointer, jumps the value to the absolute touch position on the track, then
  integrates horizontal deltas. Vertical abandons the gesture so the list
  scrolls natively.
- A release without a lock is a tap: the value jumps to the tap position on
  the track, matching the previous Radix behaviour.
- Vertical distance from the track sets the gain while locked: within 28px
  full speed, to 84px half speed, to 150px quarter speed, beyond that one
  twentieth. Deltas integrate incrementally so crossing a band never jumps.
- Sticky zero: when the continuous value crosses neutral it parks at 0 until
  10px of further travel accumulates. The HUD shows the gain band ("Fine",
  "Finer") next to the value while the finger is away from the track.

Mouse:

- Pointer down captures immediately and jumps to the absolute position, then
  integrates deltas (identical to the previous behaviour when no modifier is
  held).
- Holding Shift while dragging applies a 0.1x gain. Double-clicking the row
  resets the field to 0. Clicking the amber value resets the field, matching
  the mobile tap-to-reset affordance. The row exposes
  `data-scrubbing` so the thumb, range, label, and value render an active
  state instead of relying on `:hover`.

Both:

- Values quantise to `step` and clamp to `[min, max]`.
- `onScrubChange(true|false)` fires exactly once per gesture, so the mobile
  focus state and the desktop active state share one lifecycle.
- Keyboard remains Radix: arrow keys step, Shift plus arrow steps by ten.

### C. Row anatomy and legibility

- Mobile rows keep the single-line `label | track | value` grid, but the
  label column shrinks to `76px` with `0.82rem` type and the value column to
  `52px`, giving the track about 24px more. The label uses
  `overflow-wrap: anywhere` with `line-clamp-1` instead of ellipsis and the
  Color list uses the field's short label when the full label does not fit
  the column ("Temp" only as a last resort via CSS container query is out of
  scope; instead the label column is sized so "Temperature" fits at
  `0.82rem` semibold).
- Mobile thumb grows to 20px at rest and 24px while scrubbing; desktop stays
  at 15px and grows to 17px while scrubbing.
- During a mobile scrub, sibling rows and the section chrome fade to 0 and
  the dock gradient to 10%, leaving the photo, the HUD, and the active row.

### D. Non-goals

- No change to the colour pipeline, export gates, or LUT contract flows.
- No new panels, catalogs, or desktop layout changes.
- The desktop compare handle and mobile compare split keep their current
  geometry contract; only their active visuals are touched if needed.

## Verification contract

Each round ends with a visual acceptance run driven by real pointer input
(Playwright CDP touch on Chromium iPhone emulation, WebKit iPhone, and
desktop Chromium), not accessibility snapshots. Screenshots are captured
mid-gesture (before release) and after release. Unit coverage lands with the
hook and the dock measurement. `pnpm test:ui` and `pnpm lint:check` gate every
commit; `pnpm test:app` and a prebuilt `pnpm build` gate the closeout.
