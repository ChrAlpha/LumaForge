# Luma RAW Runtime Fixtures

CI uses locked public fixtures:

```bash
pnpm --filter @lumaforge/luma-raw-runtime fixtures:fetch-public
```

The default fetch command downloads only `purpose: "ci-smoke"` fixtures.
It is kept small so native smoke tests remain practical in CI.

`public.lock.json` is the provenance record for every fixture: its source
URL, upstream host, license declaration, device, RAW family, purpose, and
SHA-256.
The fetch script checks every download, and every cached file it
reuses, against that hash and fails on a mismatch.
Each download URL is
tried up to `LUMAFORGE_FIXTURE_ATTEMPTS` times (default 3) with a per-attempt
time limit of `LUMAFORGE_FIXTURE_TIMEOUT_MS` (default 120000) before the next
URL: `LUMAFORGE_FIXTURE_MIRROR` (a mirror base URL) first when it is set, then
the canonical URL, then any mirrors the lockfile lists.
A mirrored file must
have the locked hash too.

The `ci-smoke` DNG is also the fixture the `lmfg` CLI suite runs against.
Its fixture-gated specs skip when the file or the native artifacts are
missing, unless `LMFG_REQUIRE_FIXTURE=1` turns that into a failure;
`LMFG_FIXTURE_PATH` points them at another file.

For local compatibility diagnostics, fetch every locked public fixture:

```bash
pnpm --filter @lumaforge/luma-raw-runtime fixtures:fetch-public:all
```

Downloaded RAW files are cached under:

```text
packages/luma-raw-runtime/fixtures/.cache/public/
```

That directory is ignored and must not be committed.

Run the phone RAW diagnostics matrix after native artifacts exist.
It decodes
each fixture through the package's Node runtime (`dist/node.js`) over the
native build in `dist/native`:

```bash
pnpm --filter @lumaforge/luma-raw-runtime build:native:desktop
pnpm --filter @lumaforge/luma-raw-runtime build
pnpm --filter @lumaforge/luma-raw-runtime fixtures:fetch-public:all
pnpm --filter @lumaforge/luma-raw-runtime fixtures:diagnose-mobile-raw
```

The diagnostics report is written to:

```text
packages/luma-raw-runtime/fixtures/.cache/reports/mobile-raw-compatibility.json
```

The JSON report is engineering evidence only.
Do not convert it into official Apple ProRAW, Google Pixel RAW, Samsung Expert RAW, or Android DNG support copy
without a separate support-policy decision.

Local performance benchmarks default to the browser file picker:

```bash
pnpm --filter @lumaforge/luma-raw-runtime bench:serve
```

Open `benchmarks/bench-runtime.html`, select one or more local RAW files, and
copy the JSONL output.
The benchmark page does not read fixture paths from the environment.

There is currently no headless high-megapixel benchmark helper in this package.
If one is added, its contract is:

```bash
LUMAFORGE_RAW_FIXTURE_DIR=/absolute/path/to/local/fixtures \
  pnpm --filter @lumaforge/luma-raw-runtime <headless-benchmark-command>
```

That helper must fail with a clear message when `LUMAFORGE_RAW_FIXTURE_DIR` is
missing.
Do not hard-code local absolute fixture paths in runtime source, benchmark
code, or CI.
