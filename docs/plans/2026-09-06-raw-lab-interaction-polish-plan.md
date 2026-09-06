# RAW lab interaction polish: implementation plan

Spec: `docs/specs/2026-09-06-raw-lab-interaction-polish-design.md`

Supervisor loop. Every round: implement, run unit gates, run the visual
harness (`tmp/ux-supervisor/*.mjs`, gitignored) against the dev server,
inspect the screenshots, fix, commit. The final acceptance of each round is
visual and gesture-driven.

## Round 1: mobile precision and live preview

1. `useSliderScrub` hook in
   `src/modules/raw-processor/components/tools/useSliderScrub.ts` with unit
   tests: direction lock, tap-to-set, gain bands, sticky zero, Shift fine,
   quantisation, single `onScrubChange` lifecycle.
2. `AdjustSliderRow` adopts the hook, new column sizes, `touch-action: pan-y`,
   thumb sizing via `data-slot="slider-thumb"`, `data-scrubbing`.
3. `ScrubValueHud` shows the gain band label.
4. Stage insets: CSS vars in `raw-lab.css`, measurement in `MobileModeDock`
   and `MobileTopbar`, writer in `MobileLabChrome`, Adjust panel height.
5. `PreviewCanvas` and `OriginalWebglLayer` settle-based backing resize.
6. Visual acceptance: iPhone Chromium touch, iPhone WebKit, desktop.

## Round 2: desktop parity and active states

1. `ToneFieldRow`, `ColorFieldRow`, HSL rows adopt `useSliderScrub`
   (Shift fine, double-click reset, value-click reset, `data-scrubbing`).
2. Slider primitive: `data-slot="slider-thumb"`, scrub-active styles driven by
   `group-data-[scrubbing]`.
3. Visual acceptance on desktop mid-drag, plus mobile regression pass.

## Round 3: consistency sweep and closeout

1. i18n keys for the HUD gain labels and desktop reset tooltips (en + zh).
2. Durable browser spec under `tests/browser` for stage insets and touch
   precision, modelled on `raw-slider-chrome.spec.ts`.
3. DESIGN.md §6 note on the scrub model and stage insets.
4. `pnpm lint:check`, `pnpm test:app`, prebuilt `pnpm build`, final visual
   acceptance on all three browsers.

## Supervisor log

Each round ended with a gesture-driven visual acceptance pass (Playwright CDP
touch on the Chromium iPhone profile, WebKit iPhone, desktop Chromium) against
the real Sony ARW fixture, not accessibility snapshots.

- **Round 1 — mobile precision and live preview.** Scrub model, stage insets,
  settle-based canvas resize. Found and fixed: Chromium's implicit touch
  capture let Radix slide the thumb underneath the model (both fought over the
  value), and a `pan-y` row loses the gesture to a pan the moment the finger
  drifts vertically, which is the precision excursion itself.
- **Round 2 — desktop parity.** One shared row and one gesture. Found and
  fixed: the slider's 19px hit-area pseudo element swallowed every click on
  the reset value.
- **Round 3 — compare geometry and press feedback.** Found and fixed: the
  split line ran through the mat, the labels floated below the photo, and the
  drag accent was desktop-only.
- **Round 4 — two independent reviews** (design, technical) plus a re-run of
  the pre-existing browser specs. The specs caught a dead zone at neutral: a
  drag that *started* at 0 was trapped by sticky zero. The reviews produced
  the P0/P1 list closed in round 5.
- **Round 5 — review closeout.** Gesture lifecycle safety (lost pointerup,
  unmount, glide cancellation), the two-line mobile row (181px → 341px track),
  scrub state vs open state, `overflow: clip` on the fixed frames, blocked
  export de-greened, support level named, dock indicator unified.

## Known gaps, deliberately not taken

- **HSL is transposed between surfaces.** Desktop is axis-major (pick Hue, see
  eight bands); mobile is band-major (pick Red, see H/S/L). Both are defensible
  at their density, but they are two mental models for one feature. Unifying
  them is an information-architecture decision with real cost on both sides,
  so it wants an explicit call rather than a polish-pass answer.
- **The desktop empty state renders a synthetic sample photo** with a live
  compare split, while mobile shows an honest dropzone. The sample's "after"
  side is a saturation bump, which is the reflex the product exists to
  prevent. Hiding it at every width is a two-line change, but what the desktop
  shows before a file exists is a product decision.
- **The stage inset animates `padding`**, so a dock toggle costs a short burst
  of layout and the WebGL backing store trails the animation by ~330ms
  (CSS-scaled in the meantime). The alternative, animating a transform, would
  not re-fit the photo, which is the point of the inset.
