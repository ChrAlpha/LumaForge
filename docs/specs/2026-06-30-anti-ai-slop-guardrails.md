# Anti-AI-slop guardrails

**Date:** 2026-06-30
**Last verified:** 2026-07-23
**Status:** standing reference (not a point-in-time spec)
**Applies to:** UI edits under `src/pages/(main)/` (landing), `src/modules/raw-processor/` (`/raw`), and the shared components or primitives those surfaces consume.

## Why this exists

LumaForge already bans the textbook AI-slop tells in `PRODUCT.md` (Anti-references) and `DESIGN.md` (Theme contract). The live risk is therefore **regression, not origination**: an AI-generated change reintroducing a banned pattern or bypassing a contract that already exists. The 2026-06-30 audit (`docs/audits/2026-06-30-ai-slop-audit.md`) found exactly this on the landing page. Those landing defects were later remediated; this document remains the standing checklist that prevents their return. It operationalizes the lessons from that audit and from a study of `openclaw-control-ui` as a non-slop reference.

## The test, by register

Pick the register from the surface that consumes the change. `src/pages/(main)/*` is brand. `src/modules/raw-processor/*` and the `/raw` chrome are product. Shared primitives and components inherit the register of their consumer; their directory alone does not decide it.

- **Brand (landing):** would a viewer say "AI made this" on sight? Familiarity is a liability. Distinctiveness is the job.
- **Product (`/raw`):** would a Lightroom or Capture One user trust the tool, or pause at something subtly off? Familiarity is an asset. Slop is strangeness without purpose, half-built states, and functional dishonesty.

## Reflex bans: match and refuse

These are what a model reaches for by default. If you are about to write one, stop and rewrite with different structure.

- **Gradient text.** No `background-clip:text` over a gradient. Use a solid `--lf-text` / `--color-lf-on-*`; carry emphasis with weight and scale. (Audit: `index.css:178`.)
- **Decorative glow blobs / radial orbs** behind sections. Use a tonal band (`--lf-bg-raised`) or a hairline for separation.
- **Glassmorphism as default.** `backdrop-filter` is a `/raw` photographic-substrate tool only. Never landing or generic chrome.
- **Three identical icon cards** (hero plus three features). Use the Contract Rail (numbered rows tied to real color transforms).
- **Hero-metric template** (big number, small label, supporting stats).
- **Centered template stack** (icon, h2, paragraph, button, all centered).
- **Side-stripe accent borders** (`border-left/right` greater than 1px as a color accent). Use full borders, background tints, or leading numbers.
- **Pure neutrals.** Never `#fff`/`#000`, never `oklch(1 0 0)` / `oklch(0 0 0)`, even at low alpha. Tint toward the scoped hue-255 slate; minimum chroma 0.005 to 0.01.
- **Raw hex in component code.** OKLCH plus tokens only. The documented oklch-with-hex-fallback idiom in CSS is the one exception.
- **Generic CTAs** ("Get started", "Learn more", "Submit"). Name the action ("Open RAW lab").
- **Em dashes and `--` in UI copy.** Use a period, colon, or parentheses. (Audit: `en.json:170,183,272,273`.)
- **Modal as first thought.** Exhaust inline and progressive disclosure first. `RawResetConfirmationDialog` (a real destructive `alertdialog`) is the bar for when a dialog is justified.
- **Theme-following Tailwind colors in `/raw`** (`green`, `yellow`, `red`, `text`, `fill`, `bg`). `/raw` is a theme-fixed darkroom; use `--color-lf-*` tokens or the shared `Chip`. (Audit: `SupportBadge`, `ErrorOverlay`.)
- **Forking centralized chrome.** Import `segmented-chrome.ts` and `slider-tracks.ts`; never re-hardcode their values "to match." (Audit: `HSLTool`.)
- **Leftover component-gallery content** on product surfaces (dead, barrel-exported components carrying off-palette tokens). Delete it.

## The positive contract: do this

Derived from the openclaw reference study, operationalized for our React + Tailwind + OKLCH stack.

- **Tokens by role and depth, OKLCH, tinted.** Reuse `--color-lf-*` (app) and `--lf-*` (landing). Do not invent ad hoc colors. Every neutral carries a tint.
- **Prove contrast.** Target WCAG AA. For a new foreground/background pair, note the ratio in a comment. Never encode state with color alone; pair it with an icon and text (`PRODUCT.md` accessibility).
- **Full state coverage.** Every control ships default, hover, `:focus-visible`, active, disabled. Every async surface ships loading, empty, and error. Error states show the real message and a next action (the export path already does this; match it).
- **Empty states teach.** Distinguish "nothing yet" (drop a RAW file to begin) from "filter excludes everything." `UnsupportedState` and `MobileEmptyState` are the references.
- **Motion conveys state.** 150 to 250 ms, ease-out, no bounce. Respect `prefers-reduced-motion` globally. No decorative or page-load choreography in the tool. Use the presets in `src/lib/spring`.
- **Copy is specific and externalized.** Route every string through i18n. Name recovery actions. No template filler.
- **Reuse primitives.** Reach for `src/components/ui` (`Chip`, `Dialog`, `Slider`, `Segment`) and the shared chrome modules before hand-rolling. Build a new behavioral primitive rarely and deliberately, never a one-off pill or tab that a primitive already covers.
- **Photographic-first on brand.** When explaining RAW, LUTs, compare, or export, use a real image surface. Alt text must match what actually renders.

## The functional-slop rule (most important)

Preview and export are not interchangeable, and this is the contract worth protecting above all others.

- Export must **fail closed with plain language** when the runtime cannot prove the declared pipeline is reproducible. The gates in `src/modules/raw-processor/services/export/orchestrate-full-res-export.ts` (readiness, color-graph supported, policy can-complete) are the contract. Do not add a path that silently exports a degraded or preview-only result.
- Keep the copy distinction intact: full-resolution versus HQ preview; "JPEG ready" versus "HQ preview JPEG ready."
- A control that looks wired must be wired. No fake screens, no dead components mounted on product surfaces.

## Pre-flight (before editing UI)

1. Identify the register (landing is brand, `/raw` is product).
2. Read `PRODUCT.md` Anti-references and the `DESIGN.md` Theme contract (plus `DESIGN.md` §6 for `/raw` chrome).
3. Find the token and primitive that already cover the need (`--color-lf-*`, `src/components/ui`, `segmented-chrome.ts`, `slider-tracks.ts`).

## Pre-ship (before claiming done)

- Scan the diff against the reflex-ban list above; none introduced.
- All new neutrals tinted; no raw hex; no theme-following colors in `/raw`.
- Every new control: full state set, `:focus-visible`, accessible label; state never color-alone.
- Copy externalized and specific; no em dashes, no generic CTAs.
- Interaction, render, export, or mobile changes validated in a browser (`AGENTS.md` Verification).
- Brand surfaces: run the "could someone say AI made this?" test on a screenshot before shipping.

## Provenance

Derived from `docs/audits/2026-06-30-ai-slop-audit.md` and a study of `openclaw-control-ui` (github.com/openclaw/openclaw) as a non-slop reference. Links are provenance, not required reading; this document is self-contained.
