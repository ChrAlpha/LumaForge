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
