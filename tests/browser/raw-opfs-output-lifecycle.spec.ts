import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import type { Page, Route, TestInfo } from '@playwright/test'
import { expect, test } from '@playwright/test'

import { verifyManifestSha256 } from '../../packages/render-engine/src/manifest/canonicalize'
import { isDesktopChromiumProject } from './raw-preview-backend'
import { gateRawFixture, RAW_FIXTURE } from './support/fixtures'

// Two pages of one origin share OPFS and Web Locks. Each page reserves one
// `active/` subdirectory for its outputs and collects other pages' leftovers
// once per page lifetime, when its first export is planned. The spec drives
// both through the product's own export and reads storage and locks only
// through browser APIs.

const DESKTOP_CHROMIUM_ONLY =
  'The two-page OPFS lifecycle runs on desktop Chromium'

// The OPFS layout and lock names the product writes; read back, never driven.
const EXPORTS_DIRECTORY = '.lumaforge-exports'
const ACTIVE_DIRECTORY = 'active'
const TAB_DIRECTORY_PREFIX = 'tab-'
const UNTRACKED_DIRECTORY_PREFIX = 'untracked-'
const TAB_LOCK_PREFIX = 'lumaforge-export-tab:'
const OUTPUT_FILE = 'output.jpg'
const TEMP_FILE = `${OUTPUT_FILE}.tmp`
const FINALIZED_MARKER = `${OUTPUT_FILE}.finalized.json`
/** The recovery journal earlier versions wrote; no export writes one now. */
const RECOVERY_JOURNAL = 'manifest.json'
/** The RAW runtime an export worker loads once its output is open. */
const RAW_RUNTIME_WASM = '**/luma_raw.wasm'
const DAY_MS = 24 * 60 * 60 * 1000
/** Well past the seven days after which a datable pre-tab output is collected. */
const OLD_OUTPUT_AGE_MS = 30 * DAY_MS

/** Pre-tab entries this spec seeds; the collector must leave both. */
const UNDATABLE_LEGACY_DIRECTORY = 'lifecycle-undatable-legacy'
const RECOVERY_JOURNAL_DIRECTORY = 'lifecycle-recovery-journal'

type ExportDebugEvent = {
  type: string
  payload: Record<string, unknown>
}

type CollectionReport = {
  scannedEntries: number
  examinedEntries: number
  removedEntries: string[]
  keptEntries: number
  skippedEntries: number
  truncated: boolean
  failures: Array<{ entry: string | null; message: string }>
}

type HeldLock = { name: string; mode: string }

type DownloadedJpeg = {
  filename: string
  byteLength: number
  sha256: string
}

type ExportManifest = {
  kind: string
  manifest_sha256: string
  output: { sha256: string; filename: string }
}

type Evidence = Array<{ step: string; at: string; detail?: unknown }>

function record(evidence: Evidence, step: string, detail?: unknown) {
  evidence.push({ step, at: new Date().toISOString(), detail })
}

async function attachEvidence(testInfo: TestInfo, evidence: Evidence) {
  await testInfo.attach('opfs-output-lifecycle.json', {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  })
}

type ActiveTreeSnapshot = { at: number; tree: string[]; error?: string }

type LifecycleProbe = {
  events: unknown[]
  collectionTrees: ActiveTreeSnapshot[]
  readActiveTree: () => Promise<string[]>
}

/**
 * Init script for every page lifetime: records its export debug events and
 * reads `active/` the moment a collection reports, before the test's own
 * polling could let anything else change it.
 */
function installLifecycleProbe(layout: {
  exportsName: string
  activeName: string
}) {
  const readActiveTree = async () => {
    const root = await navigator.storage.getDirectory()
    let active: FileSystemDirectoryHandle
    try {
      const exportsDirectory = await root.getDirectoryHandle(layout.exportsName)
      active = await exportsDirectory.getDirectoryHandle(layout.activeName)
    } catch (error) {
      if ((error as DOMException).name === 'NotFoundError') return []
      throw error
    }
    const paths: string[] = []
    const walk = async (directory: FileSystemDirectoryHandle, at: string) => {
      for await (const [name, handle] of (
        directory as unknown as {
          entries: () => AsyncIterable<[string, FileSystemHandle]>
        }
      ).entries()) {
        if (handle.kind === 'directory') {
          paths.push(`${at}${name}/`)
          await walk(handle as FileSystemDirectoryHandle, `${at}${name}/`)
        } else {
          paths.push(`${at}${name}`)
        }
      }
    }
    await walk(active, '')
    return paths.sort()
  }
  const probe: LifecycleProbe = {
    events: [],
    collectionTrees: [],
    readActiveTree,
  }
  ;(
    window as unknown as { __LUMAFORGE_LIFECYCLE_PROBE__: LifecycleProbe }
  ).__LUMAFORGE_LIFECYCLE_PROBE__ = probe
  window.addEventListener('lumaforge-export-debug', (event) => {
    const detail = (event as CustomEvent<{ type?: unknown }>).detail
    probe.events.push(detail)
    if (detail?.type !== 'opfs-output-collection') return
    void readActiveTree().then(
      (tree) => probe.collectionTrees.push({ at: Date.now(), tree }),
      (error: unknown) =>
        probe.collectionTrees.push({
          at: Date.now(),
          tree: [],
          error: String(error),
        }),
    )
  })
}

/**
 * Init script for one page: its tab lock request is refused, the way a
 * browser that cannot grant it would. Lock probes (`ifAvailable`) and every
 * other lock stay real.
 */
function refuseOwnerTabLock(lockPrefix: string) {
  const refused: string[] = []
  ;(
    window as unknown as { __LUMAFORGE_REFUSED_TAB_LOCKS__: string[] }
  ).__LUMAFORGE_REFUSED_TAB_LOCKS__ = refused
  const request = LockManager.prototype.request as (
    this: LockManager,
    ...args: unknown[]
  ) => Promise<unknown>
  LockManager.prototype.request = function (
    this: LockManager,
    ...args: unknown[]
  ) {
    const [name, options] = args
    const probe =
      args.length > 2 &&
      typeof options === 'object' &&
      options !== null &&
      (options as LockOptions).ifAvailable === true
    if (typeof name === 'string' && name.startsWith(lockPrefix) && !probe) {
      refused.push(name)
      return Promise.reject(
        new DOMException('Tab lock refused for this page.', 'NotAllowedError'),
      )
    }
    return request.apply(this, args)
  } as LockManager['request']
}

const LIFECYCLE_LAYOUT = {
  exportsName: EXPORTS_DIRECTORY,
  activeName: ACTIVE_DIRECTORY,
}

async function exportEvents(page: Page) {
  return (await page.evaluate(
    () =>
      (
        window as unknown as {
          __LUMAFORGE_LIFECYCLE_PROBE__: { events: unknown[] }
        }
      ).__LUMAFORGE_LIFECYCLE_PROBE__.events,
  )) as ExportDebugEvent[]
}

async function eventPayloads(page: Page, type: string) {
  return (await exportEvents(page))
    .filter((event) => event.type === type)
    .map((event) => event.payload)
}

async function waitForEventPayload(page: Page, type: string, timeout: number) {
  await expect
    .poll(async () => (await eventPayloads(page, type)).length, {
      message: `waiting for a ${type} debug event`,
      timeout,
    })
    .toBeGreaterThan(0)
  return (await eventPayloads(page, type))[0]!
}

/** The one collection this page lifetime ran, once it has finished. */
async function waitForCollectionReport(page: Page) {
  // Collection waits for an idle period, at most ten seconds.
  await waitForEventPayload(page, 'opfs-output-collection', 60_000)
  const reports = await eventPayloads(page, 'opfs-output-collection')
  expect(reports, 'one collection per page lifetime').toHaveLength(1)
  return reports[0] as unknown as CollectionReport
}

/** Every entry under `active/`, directories with a trailing slash, sorted. */
async function listActiveTree(page: Page) {
  return page.evaluate(() =>
    (
      window as unknown as {
        __LUMAFORGE_LIFECYCLE_PROBE__: {
          readActiveTree: () => Promise<string[]>
        }
      }
    ).__LUMAFORGE_LIFECYCLE_PROBE__.readActiveTree(),
  )
}

/** `active/` as the page read it right after its collection reported. */
async function waitForCollectionTree(page: Page) {
  const read = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            __LUMAFORGE_LIFECYCLE_PROBE__: {
              collectionTrees: ActiveTreeSnapshot[]
            }
          }
        ).__LUMAFORGE_LIFECYCLE_PROBE__.collectionTrees,
    )
  await expect.poll(async () => (await read()).length).toBe(1)
  const [snapshot] = await read()
  expect(snapshot!.error).toBeUndefined()
  return snapshot!
}

function topLevelDirectories(tree: string[]) {
  return tree
    .filter(
      (path) => path.endsWith('/') && path.indexOf('/') === path.length - 1,
    )
    .map((path) => path.slice(0, -1))
}

function childDirectories(tree: string[], parent: string) {
  return tree
    .filter(
      (path) =>
        path.startsWith(`${parent}/`) &&
        path.endsWith('/') &&
        path.slice(parent.length + 1, -1).length > 0 &&
        !path.slice(parent.length + 1, -1).includes('/'),
    )
    .map((path) => path.slice(parent.length + 1, -1))
}

function filesIn(tree: string[], directory: string) {
  return tree
    .filter(
      (path) =>
        path.startsWith(`${directory}/`) &&
        path.length > directory.length + 1 &&
        !path.slice(directory.length + 1).includes('/'),
    )
    .map((path) => path.slice(directory.length + 1))
}

async function readActiveFile(page: Page, path: string) {
  return page.evaluate(
    async ({ exportsName, activeName, segments }) => {
      const root = await navigator.storage.getDirectory()
      let directory = await (
        await root.getDirectoryHandle(exportsName)
      ).getDirectoryHandle(activeName)
      const fileName = segments.at(-1)!
      for (const segment of segments.slice(0, -1)) {
        directory = await directory.getDirectoryHandle(segment)
      }
      const file = await (await directory.getFileHandle(fileName)).getFile()
      return file.text()
    },
    {
      exportsName: EXPORTS_DIRECTORY,
      activeName: ACTIVE_DIRECTORY,
      segments: path.split('/'),
    },
  )
}

/** Writes a file under `active/`; only seeding may create what is missing. */
async function writeActiveFile(
  page: Page,
  path: string,
  text: string,
  { create }: { create: boolean },
) {
  await page.evaluate(
    async ({ exportsName, activeName, segments, contents, mayCreate }) => {
      const root = await navigator.storage.getDirectory()
      let directory = await (
        await root.getDirectoryHandle(exportsName, { create: mayCreate })
      ).getDirectoryHandle(activeName, { create: mayCreate })
      const fileName = segments.at(-1)!
      for (const segment of segments.slice(0, -1)) {
        directory = await directory.getDirectoryHandle(segment, {
          create: mayCreate,
        })
      }
      const handle = await directory.getFileHandle(fileName, {
        create: mayCreate,
      })
      const writable = await handle.createWritable()
      await writable.write(contents)
      await writable.close()
    },
    {
      exportsName: EXPORTS_DIRECTORY,
      activeName: ACTIVE_DIRECTORY,
      segments: path.split('/'),
      contents: text,
      mayCreate: create,
    },
  )
}

/** Removes the named `active/` entries this spec created; nothing else. */
async function removeActiveEntries(page: Page, names: string[]) {
  await page.evaluate(
    async ({ exportsName, activeName, entries }) => {
      const root = await navigator.storage.getDirectory()
      let active: FileSystemDirectoryHandle
      try {
        active = await (
          await root.getDirectoryHandle(exportsName)
        ).getDirectoryHandle(activeName)
      } catch {
        return
      }
      for (const name of entries) {
        try {
          await active.removeEntry(name, { recursive: true })
        } catch (error) {
          if ((error as DOMException).name !== 'NotFoundError') throw error
        }
      }
    },
    {
      exportsName: EXPORTS_DIRECTORY,
      activeName: ACTIVE_DIRECTORY,
      entries: names,
    },
  )
}

/** Locks held anywhere in this origin, as the browser reports them. */
async function heldLocks(page: Page): Promise<HeldLock[]> {
  return page.evaluate(async () => {
    const snapshot = await navigator.locks.query()
    return (snapshot.held ?? []).map(({ name, mode }) => ({
      name: name ?? '',
      mode: mode ?? '',
    }))
  })
}

async function heldTabLockNames(page: Page) {
  return (await heldLocks(page))
    .map(({ name }) => name)
    .filter((name) => name.startsWith(TAB_LOCK_PREFIX))
    .sort()
}

/**
 * A pre-tab output whose finalized marker cannot be parsed, and an old,
 * datable pre-tab output next to a recovery journal an earlier version
 * wrote. The collector must leave both: one cannot be dated, and a
 * directory that holds a journal is never collected.
 */
async function seedRetentionSentinels(page: Page) {
  const oldFinalizedAt = new Date(Date.now() - OLD_OUTPUT_AGE_MS).toISOString()
  const files: Array<[string, string]> = [
    [`${UNDATABLE_LEGACY_DIRECTORY}/${OUTPUT_FILE}`, 'legacy output bytes'],
    [`${UNDATABLE_LEGACY_DIRECTORY}/${FINALIZED_MARKER}`, '{'],
    [
      `${RECOVERY_JOURNAL_DIRECTORY}/${RECOVERY_JOURNAL}`,
      JSON.stringify({ sentinel: 'recovery journal' }),
    ],
    [`${RECOVERY_JOURNAL_DIRECTORY}/${OUTPUT_FILE}`, 'journaled output bytes'],
    [
      `${RECOVERY_JOURNAL_DIRECTORY}/${FINALIZED_MARKER}`,
      JSON.stringify({
        version: 1,
        outputFileName: OUTPUT_FILE,
        finalizedAt: oldFinalizedAt,
      }),
    ],
  ]
  for (const [path, text] of files) {
    await writeActiveFile(page, path, text, { create: true })
  }
}

async function readRetentionSentinels(page: Page) {
  const tree = await listActiveTree(page)
  const contents: Record<string, string> = {}
  for (const directory of [
    UNDATABLE_LEGACY_DIRECTORY,
    RECOVERY_JOURNAL_DIRECTORY,
  ]) {
    expect(childDirectories(tree, directory)).toEqual([])
    for (const file of filesIn(tree, directory)) {
      contents[`${directory}/${file}`] = await readActiveFile(
        page,
        `${directory}/${file}`,
      )
    }
  }
  return contents
}

/** Rewrites an output's finalized marker as old, leaving its owner as is. */
async function ageFinalizedMarker(page: Page, outputDirectory: string) {
  const path = `${outputDirectory}/${FINALIZED_MARKER}`
  const marker = JSON.parse(await readActiveFile(page, path)) as Record<
    string,
    unknown
  >
  expect(Number.isFinite(Date.parse(String(marker.finalizedAt)))).toBe(true)
  const aged = {
    ...marker,
    finalizedAt: new Date(Date.now() - OLD_OUTPUT_AGE_MS).toISOString(),
  }
  await writeActiveFile(page, path, JSON.stringify(aged), { create: false })
  expect(JSON.parse(await readActiveFile(page, path))).toEqual(aged)
  return { original: marker, aged }
}

/** The one `<owner>/<exportId>` directory an owner directory holds. */
function soleOutputDirectory(tree: string[], owner: string) {
  const exports = childDirectories(tree, owner)
  expect(exports, `${owner} holds one export`).toHaveLength(1)
  return `${owner}/${exports[0]}`
}

function exportRegion(page: Page) {
  return page.getByRole('region', { name: 'Export' }).first()
}

async function openRawLab(page: Page) {
  await page.goto('/raw')
  await expect(page.locator('[data-raw-lab-shell="viewport"]')).toBeVisible()
}

async function loadPublicDng(page: Page, rawPath: string) {
  const fileChooserPromise = page.waitForEvent('filechooser')
  await page
    .getByRole('button', { name: /finish a raw with a lut/i })
    .click({ position: { x: 24, y: 24 } })
  const fileChooser = await fileChooserPromise
  await fileChooser.setFiles(rawPath)
  await expect(
    page.locator('.raw-lab[data-raw-lab-state="loaded"]'),
  ).toBeVisible({ timeout: 90_000 })
  await expect(
    exportRegion(page).getByRole('button', {
      name: /export full-resolution jpeg/i,
    }),
  ).toBeEnabled({ timeout: 90_000 })
}

/** Clicks the product's Export and requires the plan to write to OPFS. */
async function startFullResolutionExport(page: Page) {
  const before = (await eventPayloads(page, 'export-plan-selected')).length
  await exportRegion(page)
    .getByRole('button', { name: /export full-resolution jpeg/i })
    .click()
  await expect
    .poll(
      async () => (await eventPayloads(page, 'export-plan-selected')).length,
    )
    .toBeGreaterThan(before)
  const plan = (await eventPayloads(page, 'export-plan-selected'))[before]!
  // Collection only concerns OPFS outputs; a blob or streaming plan would
  // leave nothing to retain or collect and must not pass for coverage.
  expect(plan.outputSink, 'the export plan writes to OPFS').toBe('opfs-file')
  // The OPFS output is the file itself: no recovery journal is planned.
  expect(plan.checkpointDurableExpected).toBe(false)
  return plan
}

async function waitForJpegReady(page: Page) {
  await expect(exportRegion(page).getByText('JPEG ready')).toBeVisible({
    timeout: 300_000,
  })
}

async function downloadJpeg(page: Page): Promise<DownloadedJpeg> {
  const downloadPromise = page.waitForEvent('download')
  await exportRegion(page)
    .getByRole('button', { name: /^download$/i })
    .click()
  const download = await downloadPromise
  const path = await download.path()
  const bytes = await readFile(path)
  return {
    filename: download.suggestedFilename(),
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

async function downloadManifest(page: Page) {
  const manifestButton = exportRegion(page).getByRole('button', {
    name: /^manifest$/i,
  })
  await expect(manifestButton).toBeEnabled({ timeout: 180_000 })
  const downloadPromise = page.waitForEvent('download')
  await manifestButton.click()
  const download = await downloadPromise
  const manifest = JSON.parse(
    await readFile(await download.path(), 'utf8'),
  ) as ExportManifest
  expect(verifyManifestSha256(manifest)).toBe(true)
  expect(manifest.kind).toBe('export')
  return manifest
}

test.describe('tab-owned OPFS outputs across two pages', () => {
  test('keeps a live page’s old output through another page’s collection and collects it once the page is gone', async ({
    context,
    page: pageA,
  }, testInfo) => {
    test.skip(!isDesktopChromiumProject(testInfo), DESKTOP_CHROMIUM_ONLY)
    const rawPath = gateRawFixture(testInfo, RAW_FIXTURE)
    testInfo.setTimeout(900_000)
    const evidence: Evidence = []

    await context.addInitScript(installLifecycleProbe, LIFECYCLE_LAYOUT)
    const pageB = await context.newPage()

    try {
      await openRawLab(pageA)
      await openRawLab(pageB)
      expect(await listActiveTree(pageA), 'a fresh context').toEqual([])
      expect(await heldTabLockNames(pageA)).toEqual([])

      await seedRetentionSentinels(pageA)
      const sentinels = await readRetentionSentinels(pageA)
      record(evidence, 'seeded retention sentinels', Object.keys(sentinels))

      // A exports through the product and keeps its result.
      await loadPublicDng(pageA, rawPath)
      const planA = await startFullResolutionExport(pageA)
      await waitForJpegReady(pageA)
      const downloadA = await downloadJpeg(pageA)
      const manifestA = await downloadManifest(pageA)
      expect(manifestA.output.sha256).toBe(downloadA.sha256)
      expect(manifestA.output.filename).toBe(downloadA.filename)
      // A's export also ran A's own collection, with nothing to collect.
      const reportA = await waitForCollectionReport(pageA)
      record(evidence, 'A exported', {
        derivedLabel: planA.derivedLabel,
        download: downloadA,
        manifestOutputSha256: manifestA.output.sha256,
        collection: reportA,
      })
      expect(reportA).toMatchObject({ removedEntries: [], failures: [] })
      expect(await readRetentionSentinels(pageA)).toEqual(sentinels)

      const treeAfterA = await listActiveTree(pageA)
      const tabDirectoriesAfterA = topLevelDirectories(treeAfterA).filter(
        (name) => name.startsWith(TAB_DIRECTORY_PREFIX),
      )
      expect(tabDirectoriesAfterA, 'only A has written').toHaveLength(1)
      const tabA = tabDirectoriesAfterA[0]!
      const lockA = `${TAB_LOCK_PREFIX}${tabA.slice(TAB_DIRECTORY_PREFIX.length)}`
      const outputA = soleOutputDirectory(treeAfterA, tabA)
      expect(filesIn(treeAfterA, outputA)).toEqual([
        OUTPUT_FILE,
        FINALIZED_MARKER,
      ])
      // The directory is named for the lock A holds for its lifetime.
      expect(await heldLocks(pageA)).toContainEqual({
        name: lockA,
        mode: 'exclusive',
      })
      expect(await heldTabLockNames(pageB)).toEqual([lockA])
      record(evidence, 'A owns its tab directory', {
        tabDirectory: tabA,
        outputDirectory: outputA,
        heldTabLocks: await heldTabLockNames(pageB),
        tree: treeAfterA,
      })

      const { aged: agedMarkerA } = await ageFinalizedMarker(pageA, outputA)
      record(evidence, 'aged A finalized marker', agedMarkerA)

      // B's own export runs B's collection while A is alive.
      await loadPublicDng(pageB, rawPath)
      expect(await eventPayloads(pageB, 'opfs-output-collection')).toEqual([])
      await startFullResolutionExport(pageB)
      const firstReportB = await waitForCollectionReport(pageB)
      const treeAtFirstB = await waitForCollectionTree(pageB)
      record(evidence, 'B collected with A alive', {
        report: firstReportB,
        tree: treeAtFirstB,
      })
      expect(filesIn(treeAtFirstB.tree, outputA)).toEqual([
        OUTPUT_FILE,
        FINALIZED_MARKER,
      ])
      expect(firstReportB).toMatchObject({
        removedEntries: [],
        truncated: false,
        failures: [],
      })
      // A's tab directory was probed and kept; the sentinels were skipped.
      expect(firstReportB.examinedEntries).toBeGreaterThanOrEqual(3)
      expect(firstReportB.keptEntries).toBeGreaterThanOrEqual(1)
      expect(firstReportB.skippedEntries).toBeGreaterThanOrEqual(2)
      expect(await readRetentionSentinels(pageB)).toEqual(sentinels)
      await waitForJpegReady(pageB)

      const treeAfterFirstB = await listActiveTree(pageB)
      expect(filesIn(treeAfterFirstB, outputA)).toEqual([
        OUTPUT_FILE,
        FINALIZED_MARKER,
      ])
      expect(
        JSON.parse(
          await readActiveFile(pageB, `${outputA}/${FINALIZED_MARKER}`),
        ),
      ).toEqual(agedMarkerA)
      const tabDirectoriesAfterFirstB = topLevelDirectories(
        treeAfterFirstB,
      ).filter((name) => name.startsWith(TAB_DIRECTORY_PREFIX))
      expect(tabDirectoriesAfterFirstB).toHaveLength(2)
      const firstTabB = tabDirectoriesAfterFirstB.find((name) => name !== tabA)!
      const redownloadA = await downloadJpeg(pageA)
      expect(redownloadA).toEqual(downloadA)
      record(evidence, 'A output survived B collection', {
        firstTabB,
        redownload: redownloadA,
        tree: treeAfterFirstB,
      })

      // Closing A ends its lifetime; the browser releases its lock.
      await pageA.close()
      record(evidence, 'closed A')
      await expect
        .poll(() => heldTabLockNames(pageB), {
          message: 'A tab lock is released once A is closed',
          // Tearing down a page that has exported takes Chromium seconds.
          timeout: 90_000,
        })
        .not.toContain(lockA)
      const treeAfterClose = await listActiveTree(pageB)
      expect(filesIn(treeAfterClose, outputA)).toEqual([
        OUTPUT_FILE,
        FINALIZED_MARKER,
      ])
      record(evidence, 'A lock released, directory still present', {
        heldTabLocks: await heldTabLockNames(pageB),
      })

      // A reload starts a new page lifetime, whose own export collects again.
      await pageB.reload()
      await expect(
        pageB.locator('[data-raw-lab-shell="viewport"]'),
      ).toBeVisible()
      await loadPublicDng(pageB, rawPath)
      expect(await eventPayloads(pageB, 'opfs-output-collection')).toEqual([])
      await expect
        .poll(() => heldTabLockNames(pageB), {
          message: 'B released its lock when it reloaded',
          timeout: 90_000,
        })
        .toEqual([])
      await startFullResolutionExport(pageB)
      const secondReportB = await waitForCollectionReport(pageB)
      const treeAtSecondB = await waitForCollectionTree(pageB)
      record(evidence, 'reloaded B collected after A closed', {
        report: secondReportB,
        tree: treeAtSecondB,
      })
      // Both closed lifetimes are gone: A, and B before its reload.
      expect([...secondReportB.removedEntries].sort()).toEqual(
        [tabA, firstTabB].sort(),
      )
      expect(secondReportB.failures).toEqual([])
      expect(topLevelDirectories(treeAtSecondB.tree)).not.toContain(tabA)
      await waitForJpegReady(pageB)

      const treeAfterSecondB = await listActiveTree(pageB)
      expect(topLevelDirectories(treeAfterSecondB)).not.toContain(tabA)
      expect(topLevelDirectories(treeAfterSecondB)).not.toContain(firstTabB)
      expect(await readRetentionSentinels(pageB)).toEqual(sentinels)
      record(evidence, 'A directory collected, sentinels kept', {
        tree: treeAfterSecondB,
      })
    } finally {
      await attachEvidence(testInfo, evidence)
      if (!pageB.isClosed()) {
        await removeActiveEntries(pageB, [
          UNDATABLE_LEGACY_DIRECTORY,
          RECOVERY_JOURNAL_DIRECTORY,
        ])
      }
      await pageB.close()
    }
  })

  test('keeps a page’s writing and finished outputs from collection when its tab lock is refused', async ({
    context,
    page: pageA,
  }, testInfo) => {
    test.skip(!isDesktopChromiumProject(testInfo), DESKTOP_CHROMIUM_ONLY)
    const rawPath = gateRawFixture(testInfo, RAW_FIXTURE)
    testInfo.setTimeout(900_000)
    const evidence: Evidence = []
    let untrackedA: string | null = null
    const heldRuntimeRequests: string[] = []
    let releaseRuntime = () => {}
    const runtimeReleased = new Promise<void>((resolve) => {
      releaseRuntime = resolve
    })
    const holdRuntime = async (route: Route) => {
      heldRuntimeRequests.push(new URL(route.request().url()).pathname)
      await runtimeReleased
      await route.continue()
    }

    await context.addInitScript(installLifecycleProbe, LIFECYCLE_LAYOUT)
    await pageA.addInitScript(refuseOwnerTabLock, TAB_LOCK_PREFIX)
    const pageB = await context.newPage()

    try {
      await openRawLab(pageA)
      await openRawLab(pageB)
      expect(await listActiveTree(pageB), 'a fresh context').toEqual([])

      // B is ready before A writes, so its collection can run mid-write.
      await loadPublicDng(pageB, rawPath)
      await loadPublicDng(pageA, rawPath)

      // A's export worker opens its output before it loads the RAW runtime.
      // Holding that one download keeps A's output open and unfinished for
      // as long as B needs; storage and locks are left alone.
      await pageA.route(RAW_RUNTIME_WASM, holdRuntime)
      const planA = await startFullResolutionExport(pageA)
      const lockFailure = await waitForEventPayload(
        pageA,
        'opfs-output-tab-lock-failed',
        30_000,
      )
      await expect
        .poll(() => heldRuntimeRequests.length, {
          message: 'A export waits on the RAW runtime with its output open',
          timeout: 60_000,
        })
        .toBeGreaterThan(0)
      const temporaryOutputs = (await listActiveTree(pageB)).filter(
        (path) =>
          path.startsWith(UNTRACKED_DIRECTORY_PREFIX) &&
          path.endsWith(`/${TEMP_FILE}`),
      )
      expect(
        temporaryOutputs,
        'A writes its output under an untracked directory',
      ).toHaveLength(1)
      const outputA = temporaryOutputs[0]!.slice(0, -(TEMP_FILE.length + 1))
      untrackedA = outputA.split('/')[0]!
      const lockA = `${TAB_LOCK_PREFIX}${untrackedA.slice(UNTRACKED_DIRECTORY_PREFIX.length)}`
      const refusedLocks = await pageA.evaluate(
        () =>
          (
            window as unknown as {
              __LUMAFORGE_REFUSED_TAB_LOCKS__?: string[]
            }
          ).__LUMAFORGE_REFUSED_TAB_LOCKS__ ?? [],
      )
      expect(refusedLocks).toEqual([lockA])
      expect(await heldTabLockNames(pageA)).not.toContain(lockA)
      record(evidence, 'A writes without a tab lock', {
        derivedLabel: planA.derivedLabel,
        lockFailure,
        refusedLocks,
        heldRuntimeRequests,
        outputDirectory: outputA,
        heldTabLocks: await heldTabLockNames(pageA),
      })

      // B's own export collects while A's output is open.
      await startFullResolutionExport(pageB)
      const firstReportB = await waitForCollectionReport(pageB)
      const treeAtFirstB = await waitForCollectionTree(pageB)
      record(evidence, 'B collected while A was writing', {
        report: firstReportB,
        tree: treeAtFirstB,
      })
      expect(filesIn(treeAtFirstB.tree, outputA)).toContain(TEMP_FILE)
      expect(filesIn(treeAtFirstB.tree, outputA)).not.toContain(
        FINALIZED_MARKER,
      )
      expect(firstReportB.removedEntries).toEqual([])
      expect(firstReportB.failures).toEqual([])
      expect(firstReportB.keptEntries).toBeGreaterThanOrEqual(1)

      releaseRuntime()
      record(evidence, 'released A RAW runtime')
      // A still finishes and delivers what its manifest names.
      await waitForJpegReady(pageA)
      await pageA.unroute(RAW_RUNTIME_WASM, holdRuntime)
      const downloadA = await downloadJpeg(pageA)
      const manifestA = await downloadManifest(pageA)
      expect(manifestA.output.sha256).toBe(downloadA.sha256)
      expect(filesIn(await listActiveTree(pageA), outputA)).toEqual([
        OUTPUT_FILE,
        FINALIZED_MARKER,
      ])
      await waitForJpegReady(pageB)
      const treeAfterFirstB = await listActiveTree(pageB)
      const tabDirectoriesAfterFirstB = topLevelDirectories(
        treeAfterFirstB,
      ).filter((name) => name.startsWith(TAB_DIRECTORY_PREFIX))
      expect(tabDirectoriesAfterFirstB, 'only B holds a tab lock').toHaveLength(
        1,
      )
      const firstTabB = tabDirectoriesAfterFirstB[0]!
      const marker = await ageFinalizedMarker(pageA, outputA)
      // A finalized only after B's pass had been read back.
      expect(Date.parse(String(marker.original.finalizedAt))).toBeGreaterThan(
        treeAtFirstB.at,
      )
      record(evidence, 'A finished; marker aged', {
        download: downloadA,
        manifestOutputSha256: manifestA.output.sha256,
        finalizedAt: marker.original.finalizedAt,
        agedMarker: marker.aged,
        firstTabB,
        tree: treeAfterFirstB,
      })

      // A new B lifetime collects again with A's output finished and old.
      await pageB.reload()
      await expect(
        pageB.locator('[data-raw-lab-shell="viewport"]'),
      ).toBeVisible()
      await loadPublicDng(pageB, rawPath)
      expect(await eventPayloads(pageB, 'opfs-output-collection')).toEqual([])
      await expect
        .poll(() => heldTabLockNames(pageB), {
          message: 'B released its lock when it reloaded',
          timeout: 90_000,
        })
        .toEqual([])
      await startFullResolutionExport(pageB)
      const secondReportB = await waitForCollectionReport(pageB)
      const treeAtSecondB = await waitForCollectionTree(pageB)
      record(evidence, 'reloaded B collected after A finished', {
        report: secondReportB,
        tree: treeAtSecondB,
      })
      expect(filesIn(treeAtSecondB.tree, outputA)).toEqual([
        OUTPUT_FILE,
        FINALIZED_MARKER,
      ])
      // The pass did collect B's closed lifetime, and left A's output alone.
      expect(secondReportB.removedEntries).toEqual([firstTabB])
      expect(secondReportB.failures).toEqual([])
      await waitForJpegReady(pageB)

      const treeAfterSecondB = await listActiveTree(pageB)
      expect(filesIn(treeAfterSecondB, outputA)).toEqual([
        OUTPUT_FILE,
        FINALIZED_MARKER,
      ])
      const redownloadA = await downloadJpeg(pageA)
      expect(redownloadA).toEqual(downloadA)
      record(evidence, 'A output survived both collections', {
        redownload: redownloadA,
        tree: treeAfterSecondB,
      })
    } finally {
      releaseRuntime()
      await attachEvidence(testInfo, evidence)
      // No collector ever reclaims an untracked directory; this one exists
      // only because the spec refused A's lock.
      if (untrackedA && !pageB.isClosed()) {
        await removeActiveEntries(pageB, [untrackedA])
      }
      await pageB.close()
    }
  })
})
