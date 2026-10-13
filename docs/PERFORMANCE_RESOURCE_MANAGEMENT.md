# RAW Performance Resource Management

This document is intended to be self-contained. Source links and code paths are
provenance only; the runtime formulas and project-specific resource rules are
written out here so a reader does not need to chase every implementation file to
understand how LumaForge sizes preview and export work to the device it runs
on, and which owner releases each large resource it holds.

Every number below is a policy input or threshold that the code applies, not a
measurement of speed or memory use. The tests and browser specs in the
Verification Map check behavior and pixels, not throughput. A performance
claim, here or in the user guides, names its measurement: the device, the
browser, the file, and the benchmark that produced it, such as
`scripts/benchmarks/jpeg-runtime.ts` (JPEG encoding through the export row
writer) or `packages/luma-raw-runtime/benchmarks/bench-runtime.ts` (RAW decode
stages).

The policy snapshot was checked on 2026-06-01 against the resource policy
current at verification time. Source and test paths were last refreshed on
2026-10-11. The refreshes followed these moves:

- 2026-10-05: the policy and preview-plan modules moved into
  `@lumaforge/render-engine`.
- 2026-10-06: browser plan selection moved into
  `src/lib/export/export-plan.ts`, and export interruption history moved to
  source-scoped markers.
- 2026-10-08: RAW decode work moved behind one runtime host per workflow, and
  the processed-window export lifecycle moved into `@lumaforge/render-engine`.
- 2026-10-09: the `/raw` mount took ownership of the session it publishes,
  source teardown was delegated to the owners of each resource, each preview
  GPU pipeline got one lifecycle owner, and decoded preview frames got an
  identity their producer mints.
- 2026-10-11: the CPU preview's cached originals go with the worker source they
  were rendered from, a replaced decoded-frame resource no longer releases the
  frame that replaced it, and Transform events are fenced by the lifetime of
  the client that holds the frame. The on-device storage, online LUT source,
  and Transform preview lifetimes were added.

Primary implementation sources:

- `src/lib/runtime/capability-vector.ts`
- `packages/render-engine/src/policy/resource-budget.ts`
- `packages/render-engine/src/policy/interactive-policy.ts`
- `packages/render-engine/src/policy/export-policy.ts`
- `src/lib/runtime/export-runtime-resources.ts`
- `src/lib/runtime/preview-gpu-budget.ts`
- `src/lib/export/export-plan.ts`
- `packages/render-engine/src/preview/preview-plan.ts`
- `src/modules/raw-processor/services/export/export-evacuation.ts`
- `src/modules/raw-processor/services/export/export-interruption.ts`
- `src/lib/raw/luma-runtime-adapter.ts`
- `src/lib/raw/raw-runtime-host.ts`
- `packages/render-engine/src/export/processed-window-export.ts`
- `src/modules/raw-processor/state/session.atoms.ts`
- `src/modules/raw-processor/hooks/stages/ingest/useRawProcessorLifecycle.ts`
- `src/modules/raw-processor/services/workflow/raw-workflow-resources.ts`
- `src/modules/raw-processor/hooks/preview/usePreviewPipelineLifecycle.ts`
- `src/modules/raw-processor/hooks/stages/preview/usePreviewPipelineEvacuation.ts`
- `src/lib/preview/preview-frame.ts`
- `src/modules/raw-processor/hooks/stages/preview/useDecodedPreviewResource.ts`
- `src/modules/raw-processor/hooks/stages/preview/useRestorePreviewAfterExport.ts`
- `src/modules/raw-processor/hooks/useCpuPreview.ts`
- `src/modules/raw-processor/hooks/useTransformPreview.ts`
- `src/modules/raw-processor/hooks/useOnlineLutSources.ts`
- `src/modules/raw-processor/services/look/online-lut-sources.ts`
- `src/lib/lut/profile-resolution.ts`
- `src/lib/export/output-sink.ts`
- `src/lib/export/opfs-output-lifetime.ts`

External API facts checked during the 2026-06-01 refresh:

- [MDN `navigator.deviceMemory`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/deviceMemory):
  approximate, privacy-coarsened, limited browser availability.
- [MDN `navigator.hardwareConcurrency`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/hardwareConcurrency):
  browser-reported logical processor count that may be reduced by the user
  agent.
- [MDN `SharedArrayBuffer`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer):
  worker sharing requires a secure, cross-origin isolated context.
- [MDN `StorageManager.getDirectory()`](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/getDirectory):
  OPFS access is secure-context-only and can fail because of storage, memory, or
  private-browsing constraints.

## Product Boundary

The product workflow is:

```text
single RAW file -> preview -> look or LUT -> compare -> JPEG export
```

Preview and export share color intent, but they are different executors.
Interactive preview is allowed to optimize for responsiveness and may use
embedded, quick, bounded HQ, WebGPU, or CPU-degraded stages. Full-resolution
export is authoritative: it must either reproduce the declared pipeline at the
declared output size or fail closed.

The resource policy therefore has two duties:

1. Compatibility guarantee: avoid resource plans that are likely to terminate
   the tab, silently downscale export, or label a degraded result as full-res.
2. Performance maximization: use stronger preview and export budgets when the
   capability vector can justify them inside the compatibility envelope.

## Stable Capability Vector

`CapabilityVector` is a frozen, session-stable snapshot. It intentionally does
not contain quota, live heap pressure, current preview ownership, or prior export
results. Those can change during a session and are handled by export-time
resource snapshots and resource evacuation.

Fields:

| Field                | Meaning                                 | Rule                                                                    |
| -------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| `coi`                | `globalThis.crossOriginIsolated`        | Required before pthread/SAB can be true.                                |
| `pthread`            | WebAssembly thread/SAB availability     | False when `coi` is false.                                              |
| `deviceMemoryGB`     | Coarse browser memory signal            | `null` when unavailable or invalid.                                     |
| `hwConcurrency`      | Browser-reported CPU thread upper bound | Clamped to `[1, 64]`.                                                   |
| `webKitClass`        | UA family bucket                        | `chromium`, `webkit-desktop-safari`, `webkit-mobile`, or `unknown`.     |
| `deviceFormFactor`   | UA/touch-derived shape bucket           | `desktop`, `mobile`, or `unknown`; iPadOS desktop UA + touch is mobile. |
| `maybeOpfsSupported` | Stable OPFS feature hint                | Does not include quota or free space.                                   |

The key discipline is that missing memory data is not proof of high memory, and
one strong signal is not enough to unlock every budget. A browser can expose many
hardware threads while storage is private-mode disabled; a desktop can be
low-memory; an Android Chromium browser can be fast but still running on a phone
thermal envelope; a WebKit browser can have strong CPU/GPU hardware while keeping
more conservative process and memory behavior. The policy therefore reasons from
capability axes first, then derives device-class outcomes from those axes.

## Runtime Resource Budget

`deriveRuntimeResourceBudget(cap)` is the shared resource decision helper used by
interactive preview and export policy. It is the place where device class,
memory profile, bounded-HQ preview pixels, export row ceilings, export
concurrency ceilings, and safe side-work concurrency are aligned.

Definitions:

```text
knownLowMemory =
  deviceMemoryGB != null && deviceMemoryGB <= 4

desktopMemory =
  coi &&
  pthread &&
  webKitClass == "chromium" &&
  deviceFormFactor == "desktop" &&
  !knownLowMemory

mobileFormFactor =
  deviceFormFactor == "mobile" ||
  webKitClass == "webkit-mobile"

balancedPreview =
  coi &&
  pthread &&
  hwConcurrency >= 6 &&
  !knownLowMemory &&
  (mobileFormFactor ||
   webKitClass == "webkit-desktop-safari")

balancedMobileExport =
  mobileFormFactor &&
  webKitClass == "chromium" &&
  pthread &&
  hwConcurrency >= 6 &&
  deviceMemoryGB != null &&
  deviceMemoryGB >= 8
```

Resource class:

```text
if desktopMemory:
  resourceClass = "desktop-performance"
else if balancedPreview:
  resourceClass = "balanced-preview"
else if mobileFormFactor:
  resourceClass = "mobile-safe"
else:
  resourceClass = "compat-safe"
```

Worker memory profile:

```text
workerMemoryProfile = desktopMemory ? "desktop" : "low-memory"
```

This means a platform can earn more preview budget without receiving the desktop
RAW runtime profile. That separation is deliberate: preview can spend more pixels
when the device appears strong, while export continues to avoid high-risk worker
memory shapes.

### Bounded HQ Preview Budget

Base budgets:

| Budget source                 | Base bounded-HQ pixels |
| ----------------------------- | ---------------------: |
| `desktop-performance`         |           `16_000_000` |
| `balanced-preview`            |           `12_000_000` |
| `mobile-safe` / `compat-safe` |            `8_000_000` |

Known browser memory further caps this:

```text
if deviceMemoryGB == null:
  boundedHqMaxPixels = basePixels
else:
  boundedHqMaxPixels =
    min(basePixels, max(2_500_000, floor(deviceMemoryGB * 4_000_000)))
```

The `2_500_000` floor matches the quick preview cap. If the source already fits
within quick preview, bounded HQ is skipped rather than decoded redundantly.

### Export Row And Concurrency Ceilings

Export rows are more conservative than preview pixels because full-resolution
export owns RAW/JPEG workers, row buffers, and output sinks.

Row ceiling:

```text
if webKitClass == "webkit-mobile" || knownLowMemory:
  exportRowSliceCeiling = 128
else if mobileFormFactor:
  exportRowSliceCeiling = balancedMobileExport ? 256 : 128
else if !pthread || webKitClass == "webkit-desktop-safari":
  exportRowSliceCeiling = 256
else:
  exportRowSliceCeiling = 2048
```

Concurrency ceiling:

```text
if pthread &&
   !mobileFormFactor &&
   !knownLowMemory &&
   webKitClass != "webkit-mobile" &&
   webKitClass != "webkit-desktop-safari":
  exportConcurrencyCeiling = 3
else:
  exportConcurrencyCeiling = 1
```

Side-work concurrency:

```text
allowConcurrentDecodeAndLutParse =
  pthread &&
  hwConcurrency >= 4 &&
  !mobileFormFactor &&
  !knownLowMemory
```

This keeps mobile and known-low-memory devices from doing expensive background
side work while a RAW decode path is already active, even when
`hwConcurrency` is high. Desktop engines may use side-work concurrency only when
pthread and CPU signals are present, and export still applies its separate
row/concurrency limits.

## Interactive Preview Policy

`deriveInteractivePolicy(cap)` is a thin projection of the shared budget:

```text
boundedHqMaxPixels = budget.boundedHqMaxPixels
previewWorkerMemoryProfile = budget.workerMemoryProfile
allowConcurrentDecodeAndLutParse = budget.allowConcurrentDecodeAndLutParse
```

Preview capability is then decided from graphics facts:

```text
if ?forcePreview=cpu on a dev build or on localhost:
  previewMode = "cpu", reason = "forced"
else if a WebGPU adapter and device are acquired within 5 seconds:
  previewMode = "gpu"
else:
  previewMode = "cpu", reason = "webgpu-unavailable"
after a WebGPU initialization failure or device loss:
  previewMode = "cpu", reason = "gpu-preview-failed"
```

Full-resolution export does not use WebGPU, so the preview backend does not
decide whether an export can run.

Cross-origin isolation is not a preview capability gate by itself. The RAW
runtime adapter uses the policy-selected memory profile: desktop profile requires
COI, low-memory profile does not. This is why a browser without COI can still
load RAW preview through the low-memory runtime instead of showing a full-page
unsupported state.

## Full-Resolution Export Policy

`deriveExportPolicy(cap, image, intent, runtime)` consumes the same capability
vector plus an export-time resource snapshot.

Image size:

```text
megapixels = width * height / 1_000_000
```

Row slice:

```text
rowSlice = 512
if megapixels >= 100:
  rowSlice = rowSlice / 2
rowSlice = min(rowSlice, budget.exportRowSliceCeiling)
if previousResourceFailure:
  rowSlice = rowSlice / 2
if previousCrashLikeInterruption:
  rowSlice = rowSlice / 4
rowSlice = clamp(floor(rowSlice), 64, 2048)
```

Concurrency:

```text
threadBudget = max(1, hwConcurrency - 1)
if pthread:
  maxConcurrency = min(threadBudget, budget.exportConcurrencyCeiling)
else:
  maxConcurrency = 1
if previousResourceFailure || previousCrashLikeInterruption:
  maxConcurrency = 1

preferenceWeight = { safe: 1, balanced: 2, max: 3 }[performancePreference]
concurrency = clamp(preferenceWeight, 1, maxConcurrency)
```

Output sink:

```text
requiredOpfsMB = megapixels * 4 + 64
opfsFits =
  opfsSinkAvailable &&
  opfsAvailableMB != null &&
  opfsAvailableMB > requiredOpfsMB

if opfsFits:
  outputSink = "opfs-file"
else if streamingSinkAvailable:
  outputSink = "streaming"
else:
  outputSink = "blob-handoff"
```

The `64MB` margin exists because OPFS quota is advisory and the export path has
metadata, encoder, and handoff overhead beyond image megapixels.

The app wires no streaming sink: it always reports `streamingSinkAvailable`
as false, so a browser export uses `opfs-file` or `blob-handoff`.

Persist cadence:

```text
targetRows = rowSlice <= 128 ? 2048 : 4096
persistEveryNRows =
  clamp(ceil(targetRows / rowSlice) * rowSlice, rowSlice, 4096)
```

The engine still reports `persistEveryNRows`, but neither the app nor `lmfg`
persists export progress: there is no checkpoint or export journal, and every
attempt, retries included, encodes from the first row.

Interruption history:

```text
on export start:
  write a marker for the attempt, keyed by the source file tuple
  (name, size, lastModified), owned by this page's lifetime lock
on completed, cancelled, or failed:
  remove the marker
on resource failure:
  keep the marker, marked terminal "resource-failure"

when the same file tuple is loaded again:
  previousCrashLikeInterruption =
    an unfinished marker whose owner's lifetime lock is now free
  previousResourceFailure =
    a terminal "resource-failure" marker
```

Markers live in browser storage, at most `8` per origin, and are ignored after
`7` days. They only shape the next export the user starts and the panel copy
that explains it: nothing resumes partial output, reselects the source, or
exports on its own. The markers behind a hint are removed once the safer
export of that source delivers. When storage or locks are unavailable the export still runs, without
a hint.

Product copy classification:

```text
if megapixels > 50 &&
   outputSink == "blob-handoff" &&
   mobileFormFactor:
  productCopy = "cannot-safely-complete"
else if previousCrashLikeInterruption:
  productCopy = "interrupted-retry"
else if previousResourceFailure:
  productCopy = "resource-retry"
else if outputSink == "blob-handoff" && megapixels > 50:
  productCopy = "non-durable-checkpoint"
else if workerMemoryProfile == "desktop" &&
        concurrency >= 2 &&
        rowSlice >= 512:
  productCopy = "high-performance"
else:
  productCopy = "safe-export"
```

Full-resolution export never silently downscales output dimensions. If the
policy says a large local export cannot be completed safely on a mobile-form
device with the available sink, the UI must fail closed and say so.

## Device-Class Outcomes

These are derived outcomes, not hard-coded marketing tiers. The current
implementation uses both browser-family and device-form axes so a high-core phone
does not accidentally receive the desktop worker profile, while still getting a
better preview when the stable signals justify it.

| Case                                                 | Typical examples                                                                         |                                                         Preview budget | RAW runtime profile |                                                          Export rows | Export concurrency |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------: | ------------------- | -------------------------------------------------------------------: | -----------------: |
| Desktop Chromium, COI, pthread, not known-low-memory | Desktop Chrome/Edge, ChromeOS, Linux/Windows/macOS desktop Chromium                      |                                                           up to `16MP` | `desktop`           |                                    starts at `512`, capped by `2048` |          up to `3` |
| Touch-capable desktop Chromium                       | Windows tablet/laptop with desktop UA and touch                                          |                            up to `16MP` when otherwise desktop-capable | `desktop`           |                                    starts at `512`, capped by `2048` |          up to `3` |
| Known-low-memory desktop                             | Desktop browser reporting `deviceMemoryGB <= 4`                                          |        `min(8MP, deviceMemoryGB * 4MP)`, floored at quick-preview size | `low-memory`        |                                                        `128` ceiling |                `1` |
| Strong Chromium mobile                               | Android Chrome/Edge with COI, pthread, `hwConcurrency >= 6`, known memory `>= 8GB`       |                                                           up to `12MP` | `low-memory`        |                                                        `256` ceiling |                `1` |
| Conservative Chromium mobile                         | Android Chromium without COI/pthread, unknown memory, or known memory `< 8GB`            | `12MP` only when balanced-preview signals are present; otherwise `8MP` | `low-memory`        | `128` ceiling, or `256` only for strong known-memory Chromium mobile |                `1` |
| Strong WebKit mobile                                 | Recent iPhone/iPadOS WebKit with COI, pthread, `hwConcurrency >= 6`, no known-low-memory |                                                           up to `12MP` | `low-memory`        |                                                        `128` ceiling |                `1` |
| Conservative WebKit mobile                           | Older iPhone/iPad, private/restrictive context, no pthread, or known-low-memory          |                                up to `8MP` unless memory cap lowers it | `low-memory`        |                                                        `128` ceiling |                `1` |
| Desktop Safari/WebKit                                | macOS Safari/WebKit with desktop interaction model                                       |                                    `12MP` when strong, otherwise `8MP` | `low-memory`        |                                                        `256` ceiling |                `1` |
| Mobile unknown engine                                | Android Firefox, uncommon mobile webview, or touch-only unknown UA                       |      `12MP` when balanced-preview signals are present; otherwise `8MP` | `low-memory`        |                                                        `128` ceiling |                `1` |
| Desktop unknown engine with pthread                  | Firefox-like desktop, test harness, or unclassified desktop engine                       |                              usually `8MP` unless memory cap lowers it | `low-memory`        |                                    starts at `512`, capped by `2048` |          up to `3` |
| No pthread                                           | Non-isolated deploy, old browser, hardened browser, restrictive webview                  |                                up to `8MP` unless memory cap lowers it | `low-memory`        |                   `256` ceiling, or `128` if mobile/known-low-memory |                `1` |

The iPhone/WebKit rule is only one row in the matrix. The broader rule is:
preview budget follows bounded, observable headroom; desktop worker/export
throughput follows desktop form factor plus Chromium-family isolation/threading
signals; mobile full-resolution export stays single-worker and sink-sensitive.

## Constraint Matrix

The policy must also compose with resource constraints that are independent of
device family.

| Constraint                                       | Detection                                              | Policy consequence                                                                            | Reason                                                                       |
| ------------------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Source fits quick preview                        | `sourceWidth * sourceHeight <= 2_500_000`              | Skip bounded HQ decode                                                                        | Avoid spending memory on a redundant stage.                                  |
| Normal RAW size                                  | Below `50MP` and below `100MP` thresholds              | Use derived row/concurrency budget directly                                                   | Neither large-export rule applies to common 24-45MP photos.                  |
| Large local export                               | `megapixels > 50`                                      | If only `blob-handoff` is available, show non-durable desktop copy or fail-closed mobile copy | Large final JPEG handoff can spike memory.                                   |
| 100MP-class export                               | `megapixels >= 100`                                    | Halve starting row slice before other caps                                                    | Bound RAW/JPEG strip working set.                                            |
| OPFS available and enough quota                  | `opfsAvailableMB > megapixels * 4 + 64`                | Prefer `opfs-file`                                                                            | File-backed output; finalizing still reads the whole JPEG back once.         |
| OPFS absent, unknown, private, or low quota      | Runtime snapshot has no fitting OPFS sink              | `blob-handoff` (the app wires no streaming sink)                                              | Storage capability is volatile and cannot be cached from boot.               |
| Worker cannot open the reserved OPFS output      | OPFS writable fails to open before any decode          | Re-derive without OPFS on a fresh worker, never above the current rows/concurrency            | The reported plan names the real sink; refusals still apply.                 |
| Mobile form factor + large export + blob handoff | `mobileFormFactor`, `megapixels > 50`, no durable sink | `cannot-safely-complete`                                                                      | Fail closed instead of risking process termination or false full-res output. |
| Previous resource failure                        | Resource-failure marker for the same file tuple        | Halve rows, force concurrency `1`, fresh worker retry                                         | Do not retry near the same heap boundary.                                    |
| Previous crash-like interruption                 | Unfinished marker for the same file tuple, owner gone  | Quarter rows, force concurrency `1`, safer copy                                               | Treat tab/process interruption as stronger pressure.                         |
| User cancel                                      | Explicit user interruption                             | No row or concurrency penalty                                                                 | Intent is not evidence of resource pressure.                                 |
| WebGPU unavailable                               | Preview GPU facts                                      | CPU preview mode, reason `webgpu-unavailable`                                                 | Preserve preview usability when RAW decode still works.                      |
| WebGPU initialization failure or device loss     | Preview renderer failure                               | CPU preview mode, reason `gpu-preview-failed`                                                 | Keep the session usable on the CPU executor instead of a blank stage.        |
| Missing or hostile navigator fields              | Sanitized at capability boundary                       | Clamp integers, convert invalid memory to `null`, use `unknown` UA                            | Bad input should not unlock higher budgets.                                  |

These constraints stack. For example, a high-core Android Chromium phone with
COI, pthread, and known memory headroom may use a higher HQ preview and `256`
export rows, but it still stays single-worker and low-memory. If OPFS quota is
low, the output sink still demotes. A desktop with `deviceMemoryGB <= 4` keeps
low-memory rows. A browser with excellent GPU preview can still fail closed for a
large full-resolution export if the only output path is mobile `blob-handoff`.

## Resource Lifecycle And Evacuation

Before full-resolution export starts, the app builds a lightweight export
snapshot and disposes large preview-owned resources through the resource
registry. Required owners are:

```text
preview
bounded-hq
gpu
export-result
lut-fetch
```

`preview` covers the decoded preview frame, whichever stage decoded it, and
the original reference snapshot with any snapshot render still pending; `gpu`
covers the published processed and original WebGPU preview pipelines;
`export-result` covers the previous result's output, an OPFS file included.
Nothing registers under `bounded-hq` or `lut-fetch` today: the bounded-HQ
frame is the decoded preview frame once it replaces the quick one, and export
does not cancel online LUT requests (see Online LUT Sources).

Two things outside the registry stay alive while an export runs, both bounded:

- The Transform preview, once Transform has been opened or applied for the
  source: its worker keeps the frame it captured, at most 1600 pixels on the
  long edge, and the page keeps the last rendered overlay frame. They go when
  the source changes or the lab unmounts (see Transform Preview).
- An online LUT request already in flight: a catalog document is capped at
  1,000,000 bytes and a `.cube` download at 64 MiB.

The evacuation sequence is:

```text
user starts full-resolution export
-> freeze export graph, source facts, color intent, LUT contract, committed
   geometry, and policy, reading the session, color intent, and LUT from the
   store when the export runs
-> register the published processed and original GPU pipelines; each
   registration calls its owner's own release
-> cancel the preview's RAW session lease on the runtime host, which aborts
   in-flight preview and bounded-HQ work and disposes the RAW session once
-> revoke the embedded preview URL
-> clear the previous export result from the session
-> dispose the required owners: the decoded preview frame and its
   descriptor, original reference snapshots, the GPU pipelines through their
   owners, and the previous result's output
-> verify ResourceRegistry has no remaining required owners; otherwise fail
   with EXPORT_RESOURCE_EVICTION_INCOMPLETE
-> end the preview's RAW decode worker generation before each export worker
   attempt starts
-> start full-resolution export worker with the selected plan
```

The export keeps its own abort controller, so neither the lease cancel nor the
decode worker shutdown can cancel the export itself.

Inside the export worker (and in `lmfg` export), the engine's
`runProcessedWindowExportLifecycle` brackets the processed-window export with
the RAW session's begin and end hooks. End runs only after a successful begin;
an end failure rejects an otherwise successful export, and never replaces the
export's own failure.

On resource-looking export failure, retry uses a fresh worker/runtime context and
a lower policy. WebAssembly memory is effectively grow-only for this product, so
retrying in the same grown worker after memory pressure is not accepted as a
compatibility strategy.

### Released Preview And Restore

While the export runs, and afterwards while a ready result stands with no
decoded frame and no embedded preview URL, the preview is released: the stage
shows the export handoff in place of the WebGPU or CPU preview, whose owners
release what they hold as it unmounts. Edits, LUT application, the original
view and split, Transform, and HQ preview export are refused with the
`preview-released` reason. Delivering the result (download, copy, share,
manifest) does not read preview pixels and stays available.

Restore is the user's Restore preview action on that handoff, never an
automatic step. It reads the session from the store when it runs, takes a new
session lease on the same runtime host, and decodes only the quick frame of
the session's file with the source's pinned RAW render exposure. The restored
frame is a new accepted frame of the same session, and it keeps the export
result. A restore that a load, a reset, or route departure supersedes writes
nothing; a restore failure leaves the status ready, shows a toast, and does
not touch the completed export result.

## RAW Runtime Generations

The `/raw` workflow owns one RAW runtime host
(`src/lib/raw/raw-runtime-host.ts`). The host owns the decode bridge and at
most one source session lease at a time; beginning a lease cancels the one
before it, and every lease disposes its session exactly once.

```text
lease released after its work settled:
  dispose the session; keep the warm runtime for the next lease
lease cancelled while warming, opening, or holding a source:
  abort its work, dispose the session, and end the runtime generation
  (terminate the decode worker, settle its pending requests as cancelled,
  start the next request on a fresh bridge)
host disposed:
  cancel the lease, end the generation, and forget the prewarm history
```

Native decode work in flight cannot be interrupted, so ending its generation is
what keeps a superseded load from running ahead of the next one and holding
its memory. Readiness observers subscribe to the host's lifecycle snapshot;
observing never retains the runtime or delays its idle termination.

## Source Session Lifetime

There is no single lifecycle controller. Each resource a shown source holds
keeps one owner that makes its own release idempotent, and the moments that
end a source call those owners in a fixed order. The rules below are separate
on purpose: releasing preview pixels, leaving the route, keeping the source's
exposure pin, and keeping an export result current are different lifetimes.

### Session Store And Synchronous Reads

The current image session is one Jotai atom on the production store
(`src/modules/raw-processor/state/session.atoms.ts`), and the effective color
intent and the LUT are read from the same store
(`src/modules/raw-processor/state/workflow.atoms.ts`). Load, restore, export,
and delivery read them when they run, not from the last render, so a write is
visible to the next check in the same tick. Every asynchronous step fences on
that live read before it writes: load and restore on their session id, export
and delivery also on their export attempt and the export graph version.

### Route Departure

The session atom outlives the `/raw` mount, so the mount owns the session it
published (`src/modules/raw-processor/hooks/stages/ingest/useRawProcessorLifecycle.ts`).
When the mount unmounts it releases the source's resources at once, then ends
its session:

```text
unmount:
  mark the workflow unmounted
  release the source's resources (as listed under Source Teardown)
  a load still pending: clear it and its processor state now
  a loaded session: after a microtask, if the mount has not been set up
    again, clear it and its processor state
```

The workflow's RAW runtime host is disposed with the mount as well.

The microtask check lets a StrictMode effect replay keep its session, while a
real departure ends it, so coming back to `/raw` opens an empty lab that loads
the next RAW on a fresh runtime. A departing mount clears only the session it
published, and revokes only its own embedded preview URL; a session another
mount has put in the store since, and that session's URL, are left alone.

### Source Teardown

`src/modules/raw-processor/services/workflow/raw-workflow-resources.ts`
releases what a shown source holds when the session resets, when a new file
replaces it, and when the workflow unmounts. It holds no state of its own:

```text
drop the runtime-work and pending-load fences
abort the export work (its controller)
cancel the RAW session lease (the runtime host)
dispose the delivered export results (the resource registry)
revoke the embedded preview URL (the preview stage)
drop the preview copy canvas
```

The fences drop first, so a callback the outgoing load or restore still has in
flight finds its session gone and writes nothing. Reset and replacement then
release the decoded frame, which also releases the source's exposure pin. The
GPU pipelines are not on this list: their owners release them when the preview
unmounts or suspends.

### Preview GPU Pipelines

`src/modules/raw-processor/hooks/preview/usePreviewPipelineLifecycle.ts` is
the one owner of each preview GPU pipeline, the processed one in
`PreviewCanvas` and the original one in `OriginalGpuLayer`. It builds the
pipeline for its canvas, publishes it only after it has initialized, releases
it on unmount or suspension, and forgets it exactly once, whoever disposes it.
A pipeline disposed or abandoned while it initializes is never published.
Export evacuation does not clear a published pipeline itself:
`src/modules/raw-processor/hooks/stages/preview/usePreviewPipelineEvacuation.ts`
registers what an owner published and calls that owner's release, so a
registration that outlives its pipeline cannot touch a successor.

### Decoded Frame Identity

`src/modules/raw-processor/hooks/stages/preview/useDecodedPreviewResource.ts`
is the only producer of decoded preview frames. Accepting a frame mints its
descriptor (`DecodedPreviewFrame` in `src/lib/preview/preview-frame.ts`): the
session id, a frame id unique to that accepted frame, the stage, the size,
the exposure it carries, and, for a bounded-HQ frame that replaces the live
quick frame of the same session, that quick frame's id. A restored frame
gets a new frame id.

Consumers never mint an identity. The processed and original GPU layers, the
CPU preview worker, the histogram, the original reference snapshot, and the
Transform source key their requests by the descriptor, and readiness counts
only when the frame a consumer drew is the accepted one, or is the quick
predecessor the accepted bounded-HQ frame names. Equal dimensions, version
counters, or byte lengths never make two frames the same, so after an
equal-sized replacement a late answer for the replaced source readies
nothing.

A descriptor names its pixels only while they are the live frame. When export
evacuation releases the decoded frame, its descriptor goes with it, and
consumers see no frame until a restore or a new load accepts one.

### Source Exposure Versus Released Pixels

The RAW render exposure is pinned per source, not per frame: the first quick
frame of a source sets it, and bounded-HQ frames, the restored frame, and the
export render with it. Evacuation releases the pixels but keeps the pin, so a
restore after export renders with the exposure the export used. Only releasing the
source clears the pin: a reset, a replacement, or a new mount, whose workflow
starts without one.

### Export Result Currency

A completed export result is current only while the session still holds it
and the live inputs still name its request; delivery checks that through
`src/modules/raw-processor/services/export/export-result-actions.ts` before
and during each delivery. Released preview pixels do not make a result stale,
and restoring the preview does not make a stale one current. Reset,
replacement, and route departure dispose the delivered results with the
source, and an edit that retires the result makes a delivery still reading
its file refuse with a reason.

### CPU Preview Caches

`src/modules/raw-processor/hooks/useCpuPreview.ts` owns the CPU preview
worker client and the original (neutral) frames it caches so a look toggle
does not render again. Cached frames belong to the worker source they were
rendered from: loading another source, a source with no accepted frame (the
export releases it), and unmount drop the cache and every render still
outstanding, and a late frame from a replaced source is neither shown nor
cached. With no accepted frame the client is disposed, which ends its worker.

### Preview Histogram

`src/modules/raw-processor/hooks/usePreviewHistogram.ts` decides when a
histogram run starts (throttled while values move, refined once they settle)
and hands each run to `src/lib/preview/histogram-executor.ts`. The executor
measures on a worker (`src/lib/preview/histogram.worker.ts`) that holds the
rows of one decoded frame and one 3D LUT; a run carries only its color graph.
A run never samples more than 500k pixels, so the worker gets a packed copy of
only the rows a settled run reads: at most about 3 MB, made once per accepted
frame and transferred, whatever the preview's size. A settled run reads the
same rows on the worker as it would on the main thread, so its bins match.
Turning the histogram off, a look it cannot measure, losing the frame, and
unmounting terminate the worker and drop that copy. Where module workers are
unavailable, or once the worker fails, runs measure on the main thread in
chunks that yield after 6 ms.

Measured on a 3264 x 4901 bounded-HQ preview in Chromium at 4x CPU throttle,
over a 40-step exposure scrub: the main thread spent 5.2 to 6.6 seconds in the
histogram's row processing before the worker, and none after.

### Transform Preview

`src/modules/raw-processor/hooks/useTransformPreview.ts` owns one Transform
client, and `src/modules/raw-processor/hooks/useRawTransformFeature.ts`
decides when it captures a frame: only while Transform is open, applied, or
asked for. The client's worker holds the captured frame, bounded to 1600 pixels
on the long edge, and answers geometry on it. A new RAW session clears the
frame and every answer, a worker crash drops the rendered frame, and unmounting
the lab terminates the worker. Each client has an epoch that is never reused,
and the session counts a capture, request, answer, or failure only from the
client holding the current capture, so an earlier client cannot move the
accepted geometry.

The export does not read this frame. It plans and resamples the committed
geometry at full resolution in the engine, and it waits until the session has
accepted the preview's answer to the newest request; releasing the preview
does not change that acceptance.

### Online LUT Sources

`src/modules/raw-processor/hooks/useOnlineLutSources.ts` requests no catalog
when it mounts. A listed source is requested when a surface that shows its
catalog asks for it; a `?luts=` link, adding a source, and Refresh request at
once, and a failed source waits for Retry or Refresh. Each catalog request and
each `.cube` download has its own abort controller: requesting a source again
aborts its earlier request, Cancel aborts a download, and unmount aborts them
all. A catalog document is limited to 1,000,000 bytes and a `.cube` download to
64 MiB. Only one catalog LUT downloads at a time.

Downloaded `.cube` bytes persist in the Cache Storage cache
`lumaforge-online-profiles` (`src/lib/profiles/fetch.ts`, opened by
`src/modules/raw-processor/services/look/orchestrate-lut-load.ts`). A catalog
asset that declares a SHA-256 is cached under `sha256:<hash>` and checked
against that hash whenever it is read back; a cached entry that does not match
is downloaded again and overwritten, so it does not fail the load. A direct
`.cube` URL is cached under `url:<normalized URL>` and returned as stored. A
catalog asset without a hash is not cached. The next download of the same key
reuses the stored bytes. Nothing removes these entries and the cache has no
total size bound; each entry is at most the 64 MiB download limit. Where the browser has no Cache Storage,
the cache lives in page memory instead. An error from Cache Storage while
reading or writing an entry fails that LUT load.

## On-Device Storage

The RAW file is never stored, and the only image the app stores is an
`opfs-file` export result. The app keeps these entries in the browser's
storage for its origin and reads each one back. It tolerates an entry's
absence, so storage that is unavailable or full only loses the entry, with one
exception: a Cache Storage error while reading or writing the LUT cache fails
that LUT load (see Online LUT Sources).

| Entry                                               | Kind          | Owner                                                                                                      | Read for                                                                                                              | Removed or replaced                                                                                               |
| --------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `.lumaforge-exports/active/tab-<id>/<export>`       | OPFS          | `src/lib/export/output-sink.ts`                                                                            | Delivering an `opfs-file` result                                                                                      | By the result's owner (next export, reset, replacement, route departure); after the tab closes, see below         |
| `.lumaforge-exports/active/untracked-<id>/<export>` | OPFS          | `src/lib/export/output-sink.ts`                                                                            | Delivering a result from a page that could not hold its tab lock                                                      | By the result's owner only; never collected                                                                       |
| `.lumaforge-exports/active/<export>`                | OPFS          | written by versions released before tab directories; collected by `src/lib/export/opfs-output-lifetime.ts` | Collection only                                                                                                       | Once older than seven days, see below                                                                             |
| `lumaforge.export-interruption.v1.<attempt>`        | localStorage  | `src/modules/raw-processor/services/export/export-interruption.ts`                                         | The interruption hint for the same file tuple                                                                         | On completion, cancel, or failure; once its hint was used; pruned by the next export past `7` days or `8` markers |
| `lumaforge.raw.onlineLutSources.v1`                 | localStorage  | `src/modules/raw-processor/services/look/online-lut-sources.ts`                                            | Saved LUT sources and the default sources the user removed (`removedDefaultUrls`)                                     | Rewritten when the user changes the list                                                                          |
| `lumaforge.lutProfileSelections.v1`                 | localStorage  | `src/lib/lut/profile-resolution.ts`                                                                        | The contract a user chose for a `.cube`, keyed by its content fingerprint                                             | Never; a newer choice for the same fingerprint replaces it                                                        |
| `lumaforge.exportDebugEvents.v1`                    | localStorage  | `src/lib/export/execution-profile.ts`                                                                      | Export diagnostics                                                                                                    | Only the newest `256` events are kept                                                                             |
| `lumaforge-online-profiles`                         | Cache Storage | `src/lib/profiles/fetch.ts`                                                                                | Downloaded `.cube` bytes, keyed by `sha256:<hash>` or `url:<normalized URL>`, reused by the next download of that key | Never; no total size bound, each entry up to 64 MiB; a failed read or write fails that LUT load                   |
| `lumaforge.locale`                                  | localStorage  | `src/lib/i18n.tsx`                                                                                         | The chosen language                                                                                                   | Never                                                                                                             |
| `lumaforge.raw.mobile.lensHintSeen.v1`              | localStorage  | `src/modules/raw-processor/components/mobile/MobileCompareLens.tsx`                                        | Whether the mobile compare lens hint was seen                                                                         | Never                                                                                                             |
| `raw-tool-cards-open`                               | localStorage  | `src/modules/raw-processor/state/tool-card.atoms.ts`                                                       | Which desktop tool cards are open                                                                                     | Rewritten when the user opens or closes a card; never removed                                                     |

The development build also reads the localStorage flag `lumaforge:react-scan`
(`src/main.tsx`), which the app never writes. The app likewise reads the
localStorage key `color-mode` (`src/hooks/common/useDark.ts`) for the document
theme and the toast theme, and never writes it.
`src/components/common/ErrorElement.tsx` keeps the sessionStorage flag `reload`
so that the current tab reloads at most once after a failed module load.

### OPFS Output Lifetime

A page writes its OPFS outputs under one `tab-<id>` directory and holds the
exclusive Web Lock `lumaforge-export-tab:<id>` from its first OPFS export
until it closes, taken before any output exists. Once per page, at idle time
after its first export starts, `src/lib/export/opfs-output-lifetime.ts` collects what other pages
left:

```text
tab-<id> whose lock this page is granted (its page is gone):
  removed
tab-<id> whose lock is held (its page is alive), or this page's own:
  kept, however old
untracked-<id>:
  kept; only its owner removes it
a directory directly under active/ (written before tab directories):
  removed once its finalized marker, or else its newest file, is more than
  seven days old
  left alone when it holds a recovery journal (manifest.json), more than 16
  entries, a subdirectory, or anything unreadable or undated
```

One pass lists at most `4096` names and examines at most `64` entries,
starting at a random point when it cannot cover them all. Without Web Locks
nothing is collected. Collection never delays or fails the export that
scheduled it; its outcome is a debug event.

### Readers Kept And Contracts Refused

The entries above include data that released builds write on users'
devices: the pre-tab OPFS output directories, the localStorage registries and
preferences (saved LUT sources, contract choices, the language, the lens hint,
and the open desktop tool cards in `raw-tool-cards-open`), and the
`lumaforge-online-profiles` Cache Storage LUT cache. Their readers stay.
Removing one would orphan a user's saved LUT sources, contract choices, cached
LUT downloads, or exported files, so such a reader is not a compatibility
shim. For example, a default LUT source the user removed while the default
lived at its earlier catalog URL stays removed after the default URL moved.

That is a different question from contracts the project refuses on purpose:

- The app writes no export journal or checkpoint and reads none. An earlier
  version's recovery journal is neither resumed nor turned into an
  interruption hint; the collector leaves its directory in place.
- The app writes render manifests and reads none back. `lmfg` and `lmfg-mcp`
  read them through `parseRenderManifest`: the seal over the whole file, then
  the full current structure. A manifest without a field the current writer
  records is refused (`lmfg` reports `manifest.invalid`), never filled in with
  defaults.
- Engine and runtime exports that were retired are removed outright, with a
  `### Breaking` entry in that package's CHANGELOG, not kept behind forwarding
  shims.

## What Must Not Change Accidentally

- Do not make HQ preview export the primary product promise. It is a fallback or
  social-size compromise; full-resolution export remains authoritative.
- Do not use preview success as proof that full-resolution export is safe.
- Do not let any mobile-form browser receive the desktop RAW memory profile just
  because it reports many hardware threads.
- Do not treat a touch-capable desktop UA as mobile; the form-factor classifier
  must distinguish desktop touch hardware from phone/tablet UAs.
- Do not use missing `deviceMemoryGB` as evidence of abundant memory.
- Do not silently downscale a full-resolution export and keep the full-res label.
- Do not keep preview buffers, WebGPU textures, previous export blobs, or in-flight
  bounded-HQ work alive while export starts.
- Do not reintroduce a named-profile table as the decision source. Names are
  telemetry/product-copy labels only; policy is derived from capability, intent,
  and export-time resources.
- Do not add a broad lifecycle controller that clears other owners' state.
  Source teardown calls each owner's own idempotent release, and only a
  pipeline's lifecycle owner forgets a published GPU pipeline.
- Do not identify a decoded frame by its size, a version counter, or a byte
  length. Only the frame's producer mints a descriptor, and released pixels
  take theirs with them.
- Do not clear the source's exposure pin when the preview is released, and do
  not keep it across a reset, a replacement, or route departure.
- Do not treat a released preview as a stale export result, or a restored
  preview as proof that a result is current.
- Do not collect a tab's OPFS directory without holding its lock, and do not
  collect an untracked directory or one holding a recovery journal.
- Do not remove a reader of data that a released build writes to users'
  devices (OPFS export directories, localStorage registries, the
  `lumaforge-online-profiles` Cache Storage cache).
- Do not let a cached CPU preview frame outlive the worker source it was
  rendered from.

## Verification Map

Policy and invariant tests:

- `src/lib/runtime/capability-vector.test.ts`
- `packages/render-engine/src/policy/resource-budget.test.ts`
- `packages/render-engine/src/policy/interactive-policy.test.ts`
- `packages/render-engine/src/policy/export-policy.test.ts`
- `packages/render-engine/src/policy/export-policy.property.test.ts`
- `src/lib/runtime/preview-gpu-budget.test.ts`
- `src/lib/export/export-plan.test.ts`
- `src/lib/export/execution-profile.test.ts`

Preview capability and degraded-mode tests:

- `src/lib/preview/raw-preview-capability.test.ts`
- `src/modules/raw-processor/hooks/useCapabilityGate.test.tsx`
- `src/modules/raw-processor/__tests__/raw-preview-degrade.test.tsx`
- `packages/render-engine/src/preview/preview-plan.test.ts`
- `packages/render-engine/src/preview/preview-parity.test.ts`

Export lifecycle and resource tests:

- `src/modules/raw-processor/services/export/export-evacuation.test.ts`
- `src/modules/raw-processor/hooks/stages/export/useExportResourceManagement.test.tsx`
- `src/modules/raw-processor/services/export/export-interruption.test.ts`
- `src/modules/raw-processor/services/export/export-recovery.test.ts`
- `src/lib/raw/raw-runtime-host.test.ts`
- `packages/render-engine/src/export/processed-window-export.test.ts`
- `tests/browser/raw-export-lifecycle-resources.spec.ts`
- `tests/browser/raw-ios-safe-export.spec.ts`
- `tests/browser/raw-hq-preview-export.spec.ts`

Session lifetime, teardown, GPU ownership, and frame identity tests:

- `src/modules/raw-processor/hooks/useImageSession.test.tsx`
- `src/modules/raw-processor/hooks/stages/ingest/useRawProcessorLifecycle.test.tsx`
- `src/modules/raw-processor/services/workflow/raw-workflow-resources.test.ts`
- `src/modules/raw-processor/services/ingest/orchestrate-raw-load.test.ts`
- `src/modules/raw-processor/hooks/preview/usePreviewPipelineLifecycle.test.tsx`
- `src/modules/raw-processor/hooks/stages/preview/usePreviewPipelineEvacuation.test.tsx`
- `src/lib/preview/preview-frame.test.ts`
- `src/modules/raw-processor/hooks/stages/preview/useDecodedPreviewResource.test.tsx`
- `src/modules/raw-processor/services/preview/preview-compare-readiness.test.ts`
- `src/modules/raw-processor/hooks/useCpuPreview.test.ts`
- `src/modules/raw-processor/hooks/stages/preview/useRestorePreviewAfterExport.test.tsx`
- `src/modules/raw-processor/services/export/export-result-actions.test.ts`
- `tests/browser/raw-p3-lifetime.spec.ts`

Preview side workers, online LUT sources, and on-device storage tests:

- `src/modules/raw-processor/hooks/useTransformPreview.test.tsx`
- `src/modules/raw-processor/hooks/useRawTransformFeature.test.tsx`
- `src/lib/transform/transform-client.test.ts`
- `src/modules/raw-processor/hooks/useOnlineLutSources.test.tsx`
- `src/modules/raw-processor/services/look/online-lut-sources.test.ts`
- `src/lib/lut/profile-resolution.test.ts`
- `src/lib/export/output-sink.test.ts`
- `src/lib/export/opfs-output-lifetime.test.ts`
- `tests/browser/raw-online-lut-source.spec.ts`
- `tests/browser/raw-opfs-output-lifecycle.spec.ts`

`tests/browser/raw-p3-lifetime.spec.ts` covers route departure and return,
equal-sized source replacement, Transform across the bounded HQ with export
and Restore, and delivery after the preview is released, on the Chromium
project (software WebGPU) and the WebKit project, which has no WebGPU and runs
the CPU preview. It checks behavior and pixels, not hardware performance.

When changing this policy, run the smallest focused unit set first, then
production-like browser validation for any user-visible RAW preview, export
handoff, or mobile/WebKit behavior change. The `packages/render-engine` tests
run with `pnpm --filter @lumaforge/render-engine test` once the runtime
packages are built (`pnpm cli:build:deps`); neither `pnpm test:app` nor
`pnpm test:runtime` includes them.
