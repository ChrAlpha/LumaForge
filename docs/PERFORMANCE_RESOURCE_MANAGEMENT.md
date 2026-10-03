# RAW Performance Resource Management

This document is intended to be self-contained. Source links and code paths are
provenance only; the runtime formulas and project-specific resource rules are
written out here so a reader does not need to chase every implementation file to
understand how LumaForge preserves compatibility without leaving available
performance unused.

Snapshot checked on 2026-06-01 against the resource policy current at
verification time.

Primary implementation sources:

- `src/lib/runtime/capability-vector.ts`
- `src/lib/runtime/resource-budget.ts`
- `src/lib/runtime/interactive-policy.ts`
- `src/lib/runtime/export-policy.ts`
- `src/lib/runtime/export-runtime-resources.ts`
- `src/lib/export/execution-profile.ts`
- `src/modules/raw-processor/services/preview/preview-resolution-policy.ts`
- `src/modules/raw-processor/services/export/export-evacuation.ts`
- `src/lib/raw/luma-runtime-adapter.ts`

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
export owns RAW/JPEG workers, checkpoint state, row buffers, and output sinks.

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
if a WebGPU adapter and device are available within the probe timeout:
  previewMode = "gpu"
else if ?forcePreview=cpu on a dev or localhost build:
  previewMode = "cpu", reason = "forced"
else:
  previewMode = "cpu", reason = "webgpu-unavailable"
after a WebGPU initialization failure or device loss:
  previewMode = "cpu", reason = "gpu-preview-failed"
```

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
metadata, checkpoint, encoder, and handoff overhead beyond image megapixels.

Persist cadence:

```text
targetRows = rowSlice <= 128 ? 2048 : 4096
persistEveryNRows =
  clamp(ceil(targetRows / rowSlice) * rowSlice, rowSlice, 4096)
```

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
| Normal RAW size                                  | Below `50MP` and below `100MP` thresholds              | Use derived row/concurrency budget directly                                                   | Keep common 24-45MP photos responsive.                                       |
| Large local export                               | `megapixels > 50`                                      | If only `blob-handoff` is available, show non-durable desktop copy or fail-closed mobile copy | Large final JPEG handoff can spike memory.                                   |
| 100MP-class export                               | `megapixels >= 100`                                    | Halve starting row slice before other caps                                                    | Bound RAW/JPEG strip working set.                                            |
| OPFS available and enough quota                  | `opfsAvailableMB > megapixels * 4 + 64`                | Prefer `opfs-file`                                                                            | Durable, bounded output path.                                                |
| OPFS absent, unknown, private, or low quota      | Runtime snapshot has no fitting OPFS sink              | Use streaming if wired; otherwise `blob-handoff`                                              | Storage capability is volatile and cannot be cached from boot.               |
| Mobile form factor + large export + blob handoff | `mobileFormFactor`, `megapixels > 50`, no durable sink | `cannot-safely-complete`                                                                      | Fail closed instead of risking process termination or false full-res output. |
| Previous resource failure                        | Session/export state marks resource-looking failure    | Halve rows, force concurrency `1`, fresh worker retry                                         | Do not retry near the same heap boundary.                                    |
| Previous crash-like interruption                 | Interrupted checkpoint/recovery state                  | Quarter rows, force concurrency `1`, safer copy                                               | Treat tab/process interruption as stronger pressure.                         |
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
snapshot and disposes large preview-owned resources. Required owners are:

```text
preview
bounded-hq
gpu
export-result
lut-fetch
```

The evacuation sequence is:

```text
user starts full-resolution export
-> freeze export graph, source facts, current params, LUT contract, and policy
-> abort in-flight preview and bounded-HQ work
-> dispose active preview RAW runtime session
-> dispose WebGPU preview pipeline and textures
-> release bounded-HQ decoded buffer
-> release previous export Blob/object URLs
-> release obsolete LUT fetch buffers
-> verify ResourceRegistry has no remaining required owners
-> start full-resolution export worker with the selected plan
```

Export completion may restore preview best-effort from the current session file.
Failure to restore bounded HQ preview must not invalidate a completed export.

On resource-looking export failure, retry uses a fresh worker/runtime context and
a lower policy. WebAssembly memory is effectively grow-only for this product, so
retrying in the same grown worker after memory pressure is not accepted as a
compatibility strategy.

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

## Verification Map

Policy and invariant tests:

- `src/lib/runtime/capability-vector.test.ts`
- `src/lib/runtime/resource-budget.test.ts`
- `src/lib/runtime/interactive-policy.test.ts`
- `src/lib/runtime/export-policy.test.ts`
- `src/lib/runtime/export-policy.property.test.ts`
- `src/lib/export/execution-profile.test.ts`

Preview capability and degraded-mode tests:

- `src/lib/preview/raw-preview-capability.test.ts`
- `src/modules/raw-processor/hooks/useCapabilityGate.test.tsx`
- `src/modules/raw-processor/__tests__/raw-preview-degrade.test.tsx`
- `src/lib/preview/cpu-preview-parity.test.ts`

Export lifecycle and resource tests:

- `src/modules/raw-processor/services/export/export-evacuation.test.ts`
- `src/modules/raw-processor/hooks/stages/export/useExportResourceManagement.test.tsx`
- `tests/browser/raw-export-lifecycle-resources.spec.ts`
- `tests/browser/raw-ios-safe-export.spec.ts`
- `tests/browser/raw-hq-preview-export.spec.ts`

When changing this policy, run the smallest focused unit set first, then
production-like browser validation for any user-visible RAW preview, export
handoff, or mobile/WebKit behavior change.
