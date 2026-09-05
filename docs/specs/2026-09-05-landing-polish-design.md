# Landing polish and module refactor: design

- **Date:** 2026-09-05
- **Status:** approved for implementation (autonomous pass; decisions recorded here)
- **Register:** brand (`/`), Persuade mode
- **Scope:** the whole landing page, its assets, tests, and the stale
  `feat/landing-hero-redesign` branch and worktree. `/raw`, the OG image, and
  the `--color-lf-*` darkroom tokens are out of scope.

## 1. Problem

The July landing passes the anti-slop checklist, but it still reads as the
category default for a dark developer-tool landing:

- Hero is copy-left, media-right with a four-cell feature grid under the copy.
  The grid repeats the workflow section and carries no new information.
- Three sections restate one idea ("the same intent feeds preview and
  export"): evidence copy, pipeline note, and the "Preview is not export"
  guarantee.
- The trust block is three equal columns, the hairline cousin of the banned
  three-card grid.
- Every section uses the same beat (heading left, paragraph right, generous
  band), so the page has no crescendo.
- Costume mono: the figure meta and caption set prose in monospace.
- The nav shows three boxed controls in a row.
- On phones the photograph, the product's signature motif, sits below the
  fold behind the headline and a full-width button.
- The page lives in one 277-line route file plus two CSS files under
  `src/pages/(main)/`, with the compare widget in `src/components/common/`
  although nothing else uses it.
- `feat/landing-hero-redesign` (branch plus `.worktrees/landing-hero-redesign`)
  is fully merged into `main` and only adds confusion.

## 2. Goals

1. Keep the committed visual world: cool-slate `--lf-*` tokens, Geist Sans,
   Lab Green for the primary action, Calibration Amber for color explanation,
   hairline structure, real photography, the Compare Panel and Contract Rail.
2. Make the first viewport photo-first on phones and tablets while desktop
   keeps headline and photograph side by side.
3. Replace decoration with information: the feature grid becomes the real
   supported-format count read from the decoder; the trust columns become a
   run-in ledger; captions use mono only for file facts.
4. Give the page one authored motion moment: a single compare sweep on load
   that reveals the finished side and teaches the drag affordance.
5. Move the page into `src/modules/landing/` with section components, module
   CSS, colocated tests, and a thin route entry.
6. Remove the merged landing branch and worktree so `main` is the only base.

## 3. Non-goals

- New hero photograph. `SGL00940.ARW` stays; the compare remains an
  illustrative two-treatment split of the finished frame and is labeled so.
- Changes to `/raw`, the OG image renderer, `index.html`, or shared tokens.
- New dependencies, fonts, or scroll-triggered choreography.

## 4. Composition

Desktop (above 960px):

```
nav   [mark LumaForge]                  [Open RAW lab] [中文] [gh]
hero  kicker                             +--------------------------+
      H1 (max 11ch)                      |  compare stage (3:2)     |
      copy (max 58ch)                    |  muted | finished        |
      [Open RAW lab]  View source ↗      |                          |
      formats line (muted, 0.8rem)       +--------------------------+
                                         | SGL00940.ARW · 9504 × 6336 | note
workflow   intro (h2 + p)   | 01 Open the RAW      detail
                            | 02 Shape the light   detail   (5 rows)
evidence   h2 + copy, then the real session screenshot (16:10)
pipeline   h2 + note, then the seven-step rail with role ticks
ledger     dt | dd rows (3), hairlines, no heading
final      h2 + copy                              [Open RAW lab]
footer     LumaForge                    Open source under GPL-3.0 ↗
```

Phones and tablets (960px and below): one column, in this order: kicker,
compare stage, H1, copy, actions, formats line. DOM order stays kicker,
copy column, figure; CSS `order` moves the figure between the kicker and the
copy column at this breakpoint. The stage uses a 4:3 crop below 600px so the
split stays legible while the headline still enters the first viewport.

## 5. Components and files

```
src/modules/landing/
  index.ts                         re-exports LandingPage
  LandingPage.tsx                  composition: nav, main sections, footer
  content.ts                       typed key lists, HEADLINE_FORMATS, more-formats count
  content.test.ts                  headline formats exist in the decoder set
  landing.css                      tokens, base, nav, hero, compare, footer
  landing.sections.css             workflow, evidence, pipeline, ledger, final, breakpoints
  landing.structure.test.tsx       moved from src/__tests__/landing-hero-structure.test.tsx
  landing.i18n.test.tsx            moved from src/__tests__/landing-i18n.test.tsx
  components/
    LandingNav.tsx
    LandingHero.tsx
    LandingSections.tsx            Workflow, Evidence, Pipeline, Ledger, Final
    LandingFooter.tsx
    PhotoCompare.tsx               moved from components/common/LandingPhotoCompare.tsx
  hooks/
    useCompareSweep.ts             one-shot reveal, cancel on interaction
```

`src/pages/(main)/index.sync.tsx` keeps `handle`, `loader`, `Component`, and
`default`, and renders `LandingPage`. Existing imports of
`~/pages/(main)/index.sync` keep working.

### Observable interface

- `LandingPage()` renders the full page and expects `I18nProvider` and a
  router above it.
- `PhotoCompare({ label, neutralTag, finishedTag, valueText, sweep? })` keeps
  the `role="slider"` contract: `aria-valuemin=2`, `aria-valuemax=98`,
  `aria-valuenow` equals the muted percentage, keyboard Arrow, Shift, Home,
  End. `sweep` defaults to true.
- `HEADLINE_FORMATS` lists nine extensions; `countMoreFormats()` returns
  `SUPPORTED_RAW_EXTENSIONS.size - HEADLINE_FORMATS.length`.

### Sweep contract

- Starts only when `matchMedia('(prefers-reduced-motion: no-preference)')`
  matches and after the finished image has decoded, plus a 240 ms delay.
- Runs once from 86% muted to 50% over 1100 ms with an exponential ease-out
  through `requestAnimationFrame`.
- Any pointer down or key press on the slider cancels it and the control
  answers to the user immediately.
- Unmount cancels it. In jsdom the image never loads, so tests see 50%.

## 6. Visual details

- Kicker keeps the DESIGN.md label style (amber, uppercase, 0.76rem). On
  phones it is the line above the photograph.
- H1 tracking loosens from -0.045em to -0.035em. Chinese phrases keep
  `white-space: nowrap` per phrase.
- Photo frame: 8px radius, 1px hairline, photo panel shadow, one caption row.
  The caption's left cell is mono (`SGL00940.ARW · 9504 × 6336`, real file
  facts). The right cell is sans ("Illustrative compare of two treatments").
- Compare tags stay pills at the bottom corners. The handle stays a 46px
  circle with the chevrons icon; hover and drag add the green focus ring.
- Nav: the RAW lab link keeps the raised bordered plate; the locale toggle
  and GitHub link become ghost controls (transparent, hover wash from the
  raised token). Below 448px the wordmark and locale collapse to icons and the
  RAW lab link turns Lab Green.
- Ledger: `dl` grid `minmax(200px, 0.3fr) 1fr`, 22px row padding, hairline
  rows, `dt` at 700 weight, `dd` secondary text.
- Text selection uses an amber tint (`oklch(0.78 0.14 63 / 0.32)`).
- Evidence uses `<picture>`: a 720 × 900 crop of the same screenshot below
  640px, the full 1440 × 900 frame otherwise. Both are local WebP files.
- Section bands: hero base, workflow raised, evidence sunk, pipeline base,
  ledger raised, final base. Hairlines separate every band.

## 7. Copy

Removed keys: `landing.heroFeature.0..3`, `landing.workflowPreview`.
Added keys: `landing.formats` (with `{{more}}`), `landing.compareCaption`.
Changed: `landing.footer.openSource` becomes a license fact.

English:

- `landing.formats`: "Opens .ARW, .NEF, .CR3, .CR2, .RAF, .RW2, .ORF, .DNG,
  .PEF and {{more}} more RAW formats. No account, no install, no upload."
- `landing.compareCaption`: "Illustrative compare of two treatments"
- `landing.footer.openSource`: "Open source under GPL-3.0"

Chinese:

- `landing.formats`: "支持 .ARW、.NEF、.CR3、.CR2、.RAF、.RW2、.ORF、.DNG、.PEF
  及另外 {{more}} 种 RAW 格式。无需账号、无需安装、不上传。"
- `landing.compareCaption`: "两种处理的示意对比"
- `landing.footer.openSource`: "GPL-3.0 开源"

All other landing strings stay as they are; the locked strings in the i18n
tests keep their values.

## 8. Test strategy

- `content.test.ts`: every headline format is in `SUPPORTED_RAW_EXTENSIONS`
  and `countMoreFormats()` is positive.
- `landing.structure.test.tsx` (moved): real local WebP compare, evidence
  `<picture>` with both local sources, five workflow rows, seven-step rail
  with roles, three ledger rows, skip link, slider bounds, formats line shows
  the computed count, no feature grid, CSS contract scan on the module CSS.
- `landing.i18n.test.tsx` (moved): unchanged assertions plus the formats
  line in both locales.
- `tests/browser/landing.spec.ts`: keep every existing check except the
  feature-grid regex; evidence natural size accepts the mobile crop on the
  WebKit project; add a sweep check (desktop: value settles at 50 within two
  seconds; reduced motion: value is 50 immediately) and a mobile check that
  the compare stage top sits above the H1.
- Manual: screenshots at 1440, 1280, 1100, 920, 600, and 393 in both locales,
  plus reduced motion.

## 9. Complexity budget

- No new dependencies.
- Module TSX under 500 lines total; CSS under 950 lines total.
- One new hook, one moved component, one new asset (about 60 KB).

## 10. Cleanup

- `git worktree remove .worktrees/landing-hero-redesign`
- `git branch -d feat/landing-hero-redesign` (merged into `main`)
- Delete `src/components/common/LandingPhotoCompare.tsx` and the two old
  test files after moving them.
- Update path references in `AGENTS.md` and `DESIGN.md`.
