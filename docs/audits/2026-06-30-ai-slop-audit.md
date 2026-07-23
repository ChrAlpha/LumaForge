# AI Slop Audit: LumaForge surfaces

**Date:** 2026-06-30
**Status:** point-in-time audit; remediation status last verified 2026-07-23
**Surfaces:** `/raw` darkroom (product register), landing page (brand register)
**Reference studied:** `openclaw-control-ui` (the web frontend of github.com/openclaw/openclaw), as an external example of a non-slop, production agent UI.
**Method:** three parallel read-only agents (openclaw study, `/raw` audit, landing audit). Every load-bearing finding below was spot-verified against source by hand before it was recorded here.

## What "AI slop" means here

"AI slop" is the statistically average, template-like interface a model emits when it is given no committed design direction: gradient hero text, glow blobs, glassmorphism, three identical icon cards, generic CTAs, missing interactive states, and "functional slop" (controls that look wired but are not, preview output dressed up as a finished result). The test is register-specific:

- **Brand surface (landing):** could a viewer say "AI made this" on sight? Familiarity is a liability.
- **Product surface (`/raw`):** would a Lightroom or Capture One user trust the tool, or pause at something subtly off? Familiarity is an asset. Slop is strangeness without purpose, half-built states, and above all functional dishonesty.

LumaForge already bans the textbook tells in `PRODUCT.md` (Anti-references) and `DESIGN.md` (Theme contract). So the live risk is **regression, not origination**: an AI-generated change quietly violating a contract the project already wrote down.

## Headline

The audit splits cleanly by register, and the split is the lesson.
The verdicts and source locations below describe the 2026-06-30 snapshot, not
the current tree.

| Surface                  | Snapshot verdict (2026-06-30)                                                                                                      | Worst finding                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `/raw` (the tool)        | Broadly slop-free. Export is genuinely fail-closed; preview is never presented as authoritative; accessibility holds.              | No High findings. Isolated palette/vocabulary drift in peripheral chrome.               |
| Landing (the storefront) | Voice and interaction pass; the visual skin regressed into the dark-SaaS template, and the page dropped its own signature content. | High: gradient hero text. Plus a cluster of banned patterns and ~20 orphaned i18n keys. |

The team polished the tool and let the storefront drift. Slop enters through the surface nobody re-audits.

---

## Part 1: the reference (openclaw), or what non-slop looks like

`openclaw-control-ui` is a Vite + Lit web-component control/chat UI for an AI coding agent. A chat UI is the category most prone to slop, yet this one is clearly craft, not template. The evidence (cited for transfer, not because the stack matches ours):

1. **Tokens named by role and depth, never by color.** A 5-step background depth ramp and a 4-step text ramp (`ui/src/styles/base.css`) produce hierarchy without heavy borders. Directly relevant to a darkroom, where chrome must recede behind the photo.
2. **Measured contrast is a first-class artifact.** WCAG ratios are written next to each token (`ui/docs/design-system/color-tokens.md`) and re-proven per theme inline in CSS (`base.css`, e.g. `--accent ... contrast ≈ 5.8:1 AA text`). Color is proven, not eyeballed.
3. **Derive, do not enumerate.** ~18 anchor tokens expand to ~60 via `color-mix` (`ui/src/ui/custom-theme.ts`). The repo has 739 `color-mix` uses versus 51 gradients, and those gradients are functional status tints, not decoration.
4. **Every async surface ships three states as a reusable primitive** (`ui/src/ui/lazy-view.ts`): loading, error (with retry and the real error message), content.
5. **Empty states distinguish "new" from "filtered"** with different copy and different next actions.
6. **Motion is a 3-token scale with one global `prefers-reduced-motion` reset**, and the team deleted an animation that hurt perceived speed and documented why (`theme-transition.ts`).
7. **Copy is real instructions with parameters, externalized through i18n** ("Re-copy a tokenized URL with `{command}`"), never "Something went wrong."
8. **They built only the few behavioral primitives that need it** (a focus-trapped dialog) and used plain classes for everything else. No over-componentization. 44px targets and `:focus-visible` everywhere.

Even here a handful of small slop tells survive (a hardcoded `#c0392b` as a last-resort fallback that violates the team's own "no hardcoded hex" rule, a skip-link the docs promise but the shell does not ship, a few inline styles). The takeaway is not "openclaw is perfect," it is "load-bearing, self-consistent discipline across three UIs is what separates craft from template."

---

## Part 2: landing audit (brand register)

Verified against `src/pages/(main)/index.sync.tsx`, `src/pages/(main)/index.css`, `src/styles/tailwind.css`, `src/locales/en.json`, `src/components/common/LandingCompareSvg.tsx`.

| Severity | Location                                                            | Pattern                                                                                                                                                                                                                                               | Why it reads as slop / breaks the contract                                                                                                                                                              | Fix direction                                                                                      |
| -------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **High** | `index.css:178-185` (`.lf-hero h1`)                                 | Gradient text: `linear-gradient(180deg, oklch(0.97…240), oklch(0.72…240))` + `background-clip:text` + transparent fill                                                                                                                                | The single most-flagged SaaS-hero tell, an explicit `DESIGN.md` Don't, and hue 240 is the cool/blue family the brand avoids. Applied to the wordmark "LumaForge" itself.                                | Solid `--lf-text`. Let weight and scale carry the hero.                                            |
| Med      | `index.css:140-151` (`.lf-hero-glow`), `504-510` (`.lf-final`)      | Two stacked radial "glow blobs" behind the hero (one is `oklch(0.14 0.02 240 / 0.2)`, a blue glow) and a green glow under the final CTA                                                                                                               | `PRODUCT.md` and `DESIGN.md` both ban decorative blobs/orbs. Brand depth is meant to come from photographic layers and hairlines.                                                                       | Remove the radials; if separation is needed use a tonal band (`--lf-bg-raised`) or a hairline.     |
| Med      | `index.css:36` (`.lf-nav`), `357` (`.lf-compare-tag`)               | Glassmorphism as marketing chrome: `backdrop-filter: blur(16px)`                                                                                                                                                                                      | `DESIGN.md` scopes glass to `/raw` as a photographic substrate tinter; a blurred nav is generic SaaS chrome.                                                                                            | Opaque/tonal nav plate over a hairline; reserve `backdrop-filter` for `/raw`.                      |
| Med      | `index.sync.tsx:32-48, 260-266` + `index.css:393-395` (`.lf-proof`) | Three same-size icon cards (`repeat(3,1fr)`, 22px icon + h3 + p)                                                                                                                                                                                      | The canonical "three feature cards," explicitly banned. Partially mitigated: hairline-divided cells (not boxes) and varied icon colors.                                                                 | Re-express as the `DESIGN.md` Contract Rail (numbered rows tied to real transforms).               |
| Med      | `index.css:13-14, 271, 292, 521` (+ `og-image.ts`)                  | Pure neutrals spelled in OKLCH: `oklch(1 0 0 / …)` and `oklch(0 0 0 / …)` for borders and shadows                                                                                                                                                     | Violates the `DESIGN.md` "No Pure Neutral" rule. High leverage: `--lf-border` drives every hairline, so one token fix re-tints the whole divider system.                                                | Tint toward the slate hue: borders `oklch(0.9 0.01 255 / α)`, shadows `oklch(0.1 0.01 255 / α)`.   |
| Med      | `index.sync.tsx:237-244` + `index.css:283-293`                      | Fake macOS product window with three traffic-light dots                                                                                                                                                                                               | Stock "make the screenshot look like an app" ornament. Mitigated: dots are monochrome, and the filename (`DSC_4832.ARW`) and pipeline (`ARRI LogC → Rec.709`) are real and on-brand.                    | Drop the dots; keep the real filename and pipeline label as the frame's identity.                  |
| Med      | `index.sync.tsx:286-299` + `index.css:498-502` (`.lf-final`)        | Centered template-stack CTA (icon + h2 + p + button, centered, over a glow)                                                                                                                                                                           | Banned "centered template stack," compounding with the glow above.                                                                                                                                      | Asymmetric or left-aligned closing block, or fold the CTA into the contract-rail conclusion.       |
| Med      | `LandingCompareSvg.tsx` vs `en.json:14`                             | The hero "photo" is a synthetic vector (linear/radial gradients + `feTurbulence` grain, no real `<image>`), while its alt text says "A desert road **photograph**"                                                                                    | `DESIGN.md` is emphatic about photographic-first surfaces, and the alt text mis-describes what renders (an a11y defect too). The OG image (`og-image.ts:285-386`) does it right with a real photo.      | Use a real RAW/finished pair in the hero compare; fix the alt text to match.                       |
| Med      | `src/locales/en.json`                                               | Dropped signature content and ~20 orphaned i18n keys: en.json defines 50 `landing.*` keys, the page uses ~30. Orphaned: `landing.contract.0-5` (the Contract Rail), `positioning.*`, `pipeline.*`, `luts.*`, `primaryActions`, `start`, `viewSource`. | The page shed its most differentiating content (the Contract Rail is a named Signature Component) and collapsed to the generic skeleton. This is the clearest illustration of regression into template. | Reinstate the contract-rail section, or delete the dead keys if the section is intentionally gone. |
| Low      | `index.sync.tsx:222, 297`                                           | `ArrowRight` icon on both CTAs                                                                                                                                                                                                                        | Generic SaaS micro-convention. The CTA labels themselves are good.                                                                                                                                      | Optional: drop the arrow or use a domain glyph.                                                    |

**Done well (preserve):**

- Copy is dash-clean (programmatically verified: zero em dashes, en dashes, `--`, or ellipses in `landing.*`) and the CTAs are product-named ("Open RAW lab," "Star on GitHub"), not "Get started / Learn more."
- The before/after compare is a real, keyboard-accessible interaction: `role="slider"`, `aria-valuemin/max/now`, Arrow/Shift/Home/End (`index.sync.tsx:132-168`). This is the brand's Compare motif as behavior, not a screenshot.
- Concrete product specifics, no "AI-powered" vagueness (`.ARW/.NEF/.RAF`, `.cube`, `ARRI LogC → Rec.709`).
- The OG image uses a real photograph with genuine before/after filters (`og-image.ts:285-386`).
- `prefers-reduced-motion` respected in both JS (`index.sync.tsx:65-87`) and CSS (`index.css:616-624`).
- The `@theme --color-lf-*` tokens are all OKLCH and all tinted (`tailwind.css:172-197`); the pure-neutral problem is in the landing-local `.lf-*` values, not the shared token set.
- Borders are structural hairline dividers, not the banned decorative colored side-stripes.

**Verdict:** partial pass. The voice and interaction layer clearly escape the "AI made this" test; the visual skin and the dropped signature content do not. The fix is mostly subtractive (remove gradient text, glows, glass, traffic dots) plus restoring the Contract Rail and a real hero photo.

---

## Part 3: `/raw` audit (product register)

Verified against the desktop tool rail, preview/workflow chrome, the three `raw-lab` CSS files, and a full read of the export path.

**Export honesty (the functional-slop spot-check) passes.** `services/export/orchestrate-full-res-export.ts` fails closed at every gate before it touches the worker:

- Readiness gate (`:144-153`): if `!canExport`, it shows `toast.error('Full-resolution export is not ready', { description })` and returns.
- Color-graph gate (`:179-198`): if `!graph.supported`, it sets `lastErrorCode: 'EXPORT_UNSUPPORTED_PIPELINE'`, `retryRecommended: false`, and returns. An unreproducible pipeline never exports a degraded result.
- Policy gate (`:233-238`): a `cannot-safely-complete` plan throws `EXPORT_POLICY_CANNOT_COMPLETE`.
- Only after all gates does it call the real `runFullResolutionExportJob` (`:461`) with the resolved graph.

Preview output is never dressed as authoritative: the copy itself carries the distinction (`raw.export.run` "Export full-resolution JPEG" vs `raw.export.runPreview` "Export HQ preview JPEG"; `raw.export.ready` "JPEG ready" vs `raw.export.previewReady` "HQ preview JPEG ready"). This is the product's core promise implemented for real, and the opposite of functional slop.

| Severity | Location                                                                                                           | Pattern                                                                                                                                                                                                                                           | Why it matters here                                                                                                                                                                                                                           | Fix direction                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Med      | `SupportBadge.tsx:13-15`                                                                                           | Off-palette theme-following tokens `bg-green/10 text-green` / `bg-yellow/10 text-yellow`, hand-rolled span instead of the shared `Chip`. `green`/`yellow` are not remapped in `.raw-lab`, and `yellow` is not in the darkroom palette (amber is). | Leaks the system `data-theme` into a theme-fixed surface and renders an off-system hue.                                                                                                                                                       | Use `<Chip surface="on-photo" tone="green">` / `tone="amber">`, the primitive `LutSourceWarning` already uses. |
| Med      | `ProgressOverlay.tsx:300-301, 314` (`ErrorOverlay`)                                                                | Off-palette `bg-red/10 text-red`, a mingcute glyph, generic `text-text`, `rounded-lg`.                                                                                                                                                            | The error message does render (`:308`), so fail-closed messaging holds, but raw `red` contradicts the darkroom's own destructive token (`lf-rose`, used correctly in `RawResetConfirmationDialog`).                                           | Repaint with `lf-rose` and `lf-on-photo-*`; swap to the lucide icon; align radius.                             |
| Med      | `tools/HSLTool.tsx:120, 142`                                                                                       | HSL axis tabs re-hardcode `oklch(0.96 0.006 255/0.05)`, `/0.10`, and the inset highlight, with comments admitting they "match segmented-chrome `SEGMENTED_THUMB_BG`" instead of importing it.                                                     | `DESIGN.md` §6 centralizes segmented paint so one file changes the look everywhere. Strength and the LUT contract tabs consume the constants; only HSL forks. This is the exact inconsistent-vocabulary drift the contract exists to prevent. | Import and apply `SEGMENTED_TRACK` / `SEGMENTED_THUMB_BG` / `SEGMENTED_ITEM_TEXT*` / `SEGMENTED_FOCUS_RING`.   |
| Low      | `Dropzone.tsx:275-309` (`FileDropzone`), `ProgressOverlay.tsx:328-356` (`SuccessToast`)                            | Dead components, barrel-exported but never rendered, carrying off-palette tokens and a `shadow-lg` (against the flat/no-shadow rule).                                                                                                             | `PRODUCT.md` bans leftover component-gallery content; latent slop that could be mounted later with the wrong palette.                                                                                                                         | Delete, or repaint to darkroom tokens and drop the shadow.                                                     |
| Low      | `ProgressOverlay.tsx`, `CpuPreviewBanner.tsx`, `Dropzone.tsx`, `ComparePreviewStage.tsx`, `CompareSplitHandle.tsx` | Mixed icon vocabulary: mingcute (`i-mingcute-*`) and Unicode glyphs (`↑`, `✓`, `↔`) where most tools use lucide.                                                                                                                                  | AGENTS/DESIGN say use lucide when available; a C1/Lr user notices mismatched iconography. Each has a lucide equivalent.                                                                                                                       | Standardize on lucide.                                                                                         |
| Low      | `src/locales/en.json:170, 183, 272, 273`                                                                           | Em dashes in `raw.*` copy ("GPU preview unavailable — using a slower CPU preview…").                                                                                                                                                              | The project bans em dashes / `--` in UI copy. Grammatically fine, but a copy-rule violation.                                                                                                                                                  | Replace with a period or colon.                                                                                |
| Low      | `src/providers/root-providers.tsx:31`                                                                              | `MotionConfig` sets `transition` but not `reducedMotion="user"`. CSS transitions and the progress ring are reduced; brief Framer JS springs (overlay entrance, LUT tab `layoutId` thumb) are not.                                                 | `PRODUCT.md` says respect `prefers-reduced-motion`; bulk motion is handled, this closes the residual gap.                                                                                                                                     | Add `reducedMotion="user"` to the root `MotionConfig`, one line.                                               |
| Low      | `FileFactsTool.tsx:46`, `ExportTool.tsx:104`                                                                       | Dimensions rendered with a literal `x` (`6000 x 4000`).                                                                                                                                                                                           | Minor typographic register in a photographer tool; the convention is `×`.                                                                                                                                                                     | Use `×` (U+00D7).                                                                                              |

**Done well (the strong baseline):**

- Export honesty (above) is airtight.
- `CompareSplitHandle.tsx`: `role="slider"` with full keyboard support, pointer capture, rAF-batched preview. Strong a11y and perf.
- `slider-tracks.ts`: Lightroom/ACR-faithful directional gradient tracks (temperature blue to yellow, tint magenta to green). The familiar, trustworthy affordance.
- `segmented-chrome.ts`, `WorkspaceHeader.tsx`, `ToolCard.tsx`: faithful to `DESIGN.md` §6 (Lift-Wash ladder, ghost actions, inset-hairline seams, `tabular-nums`).
- `LUTProfileStatus.tsx` / `LutSourceWarning.tsx`: amber used correctly for color-contract explanation; state always icon + text, never color alone; proper `aria-*` and `role=status aria-live`.
- `RawResetConfirmationDialog.tsx`: legitimate destructive guard (`role="alertdialog"`, real title/description, `lf-rose`), not a reflexive modal.
- CSS hygiene: no raw hex in component TSX; `#000`/`#fff` appear only as mask-alpha (the correct idiom); documented oklch-with-hex-fallback.
- Tone/Color/HSL tools share one dirty-state vocabulary (`lf-amber-soft` plus the live numeric value), so state is never color-alone.

**Verdict:** broadly slop-free with isolated issues. The core (export path, compare, tool rail chrome, LUT contract surfaces) is coherent and contract-faithful. The defects cluster in peripheral/legacy chrome that escapes the darkroom token system via theme-following `green/yellow/red` and bypasses the shared `Chip`, plus the HSL tabs forking the centralized paint. All are mechanical token/primitive swaps, not redesigns.

---

## Synthesis

1. **Slop here is regression, not origination.** Every landing finding violates a rule the project already wrote. The defenses exist; they were bypassed.
2. **The two registers fail differently.** The landing failed the "looks AI-made" test on its visual skin. `/raw` would pass the "do I trust this tool" test. A single slop checklist that ignores register would mis-grade both.
3. **The dangerous slop (functional) is absent where it would matter most.** Export is honest. That is the contract worth protecting above all others, and it holds.
4. **Slop entered through the un-re-audited surface.** The tool gets continuous attention; the landing was allowed to drift until it dropped its own signature content. The durable guardrail (next) exists to make that drift visible before it ships.

The standing rules derived from this audit live in `docs/specs/2026-06-30-anti-ai-slop-guardrails.md`.

## Original remediation and current status

The original low-risk remediation list was:

1. **Landing High:** remove the gradient hero text (one CSS block).
2. **Landing one-token win:** tint `--lf-border` (and the box-shadow neutrals) toward hue 255; re-tints every hairline at once.
3. **Landing subtractive pass:** remove the two glow blobs, the nav blur, and the traffic-light dots.
4. **Landing structural:** decide the Contract Rail's fate (reinstate the section or delete the ~20 orphaned keys), and replace the synthetic hero SVG with a real photo pair plus correct alt text.
5. **`/raw` mechanical swaps:** `SupportBadge` and `ErrorOverlay` onto darkroom tokens / shared `Chip`; import the segmented constants in `HSLTool`; delete the two dead components; add `reducedMotion="user"`; de-dash the four `raw.*` strings.

**Current status (verified 2026-07-23):**

- Landing items 1–4 are complete. The July landing redesign removed the
  gradient/glow/glass/template treatments, tinted the neutrals, restored the
  Contract Rail, replaced the synthetic compare with real photography, and
  reconciled the landing copy and locale keys. The current landing passes the
  standing pre-ship guardrail.
- `/raw` item 5 remains open. The original line numbers have moved, but the
  source patterns remain: off-palette `SupportBadge` / `ErrorOverlay`, forked
  HSL segmented paint, exported dead components, missing root
  `reducedMotion="user"`, em dashes in `raw.*` copy, and literal `x`
  dimensions. This audit records them; it does not expand the landing
  remediation into a `/raw` refactor.

## Appendix: documentation drift (not a slop defect)

Resolved 2026-07-23. `DESIGN.md` now identifies its warm-paper front-matter as
historical, and its current Theme contract describes the landing as a fixed
cool-slate surface with landing-local `--lf-*` tokens. The
`src/styles/tailwind.css` token comment matches that contract.
