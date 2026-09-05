# Landing polish and module refactor: plan

Spec: `docs/specs/2026-09-05-landing-polish-design.md`.

## Tasks

1. **Cleanup.** Remove the merged `feat/landing-hero-redesign` worktree and
   branch. Verify with `git worktree list` and `git branch --list`.
2. **Assets.** Crop `public/landing-workspace-evidence.webp` (x 720 to 1440,
   full height) into `public/landing-workspace-evidence-mobile.webp` with the
   `sharp` already present in the workspace.
3. **Module scaffold.** Create `src/modules/landing/` with `content.ts`,
   `PhotoCompare.tsx` (moved), `useCompareSweep.ts`, section components,
   `LandingPage.tsx`, `index.ts`, and the two CSS files. Point
   `src/pages/(main)/index.sync.tsx` at the module. Delete the old CSS and
   compare component.
4. **Locales.** Remove `landing.heroFeature.*` and `landing.workflowPreview`;
   add `landing.formats` and `landing.compareCaption`; update
   `landing.footer.openSource` in both files.
5. **Tests.** Move and update the structure and i18n tests, add
   `content.test.ts`, update `tests/browser/landing.spec.ts`, add
   `src/modules/landing` to the `test:ui` script.
6. **Docs.** Update `AGENTS.md` and `DESIGN.md` landing path references.
7. **Verify.** `pnpm test:ui`, `pnpm lint`, `pnpm test:app`,
   `LUMAFORGE_NATIVE_RUNTIME_MODE=prebuilt pnpm build`, focused
   `pnpm exec playwright test tests/browser/landing.spec.ts`, screenshots at
   six widths in both locales, reduced motion check.
8. **Commit** in focused commits: cleanup, asset, module refactor, tests and
   docs.

## Verification log (2026-09-05)

- Cleanup: `git worktree remove .worktrees/landing-hero-redesign` and
  `git branch -d feat/landing-hero-redesign` (branch was fully merged).
- `pnpm exec tsc --noEmit -p tsconfig.json`: clean.
- `pnpm lint:check`: clean.
- `pnpm test:ui`: 121 files, 876 tests passed (includes the moved landing
  tests and the new content test).
- `pnpm test:app`: 187 files, 1632 tests passed.
- `LUMAFORGE_NATIVE_RUNTIME_MODE=prebuilt pnpm native:prepare` and
  `LUMAFORGE_NATIVE_RUNTIME_MODE=prebuilt pnpm build`: built.
- `pnpm exec playwright test tests/browser/landing.spec.ts`: 17 passed,
  5 skipped by project (chromium-desktop and webkit-ios-safe). The first run
  exposed that holding the compare image also held the WebKit load event; the
  sweep test now navigates with `domcontentloaded`.
- Screenshots reviewed at 1440, 1280, 1100, 920, 600, and 393 in both locales
  from `vite preview`, plus a mid-sweep frame (86 to 50 in about one second
  after the photograph loads) and a WebKit 393 x 660 first viewport. The
  phone stage crop moved from 4:5 to 4:3 after the first round so the
  headline enters the first viewport under the photograph.
