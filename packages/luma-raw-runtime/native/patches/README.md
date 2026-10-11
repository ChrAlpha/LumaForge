# Native Patches

This directory is for explicit patches against locked upstream native sources.

Rules:

- Do not patch extracted files directly in `native/vendor`.
- Every patch must mention the upstream source name and version from
  `native/sources.lock.json`.
- Every patch must be applied by `native/scripts/build-deps.sh`. That script
  applies no patch today, so the first patch also adds its apply step.
- Keep the upstream notices intact and record the modification in
  `THIRD_PARTY_NOTICES.md`.
- If a patch changes runtime behavior, record it in the package
  `CHANGELOG.md` and rerun the benchmarks after the CI native build passes.

The current build uses no source patches: the native artifacts are built from
the unmodified archives that `native/sources.lock.json` pins by SHA-256.
