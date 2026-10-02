/**
 * verify-app-start-setting.mjs — `playOnAppStart` is a real, host-owned setting.
 *
 * Why this file exists: 0.4.2 replaces a silent behaviour change with a SWITCH.
 * The requirement has three halves, and each is a defect if it breaks:
 *
 *   1. it lives on the HOST (`selection.json` via POST /select), not in
 *      localStorage — localStorage is partitioned per origin, so a DSH port
 *      change would silently drop the user's choice
 *   2. the client is TOLD the value (`/videos.json` and `/status.json` publish
 *      it), so the UI shows the stored truth instead of a guess
 *   3. it defaults to true, and an older selection file gains exactly that
 *      default rather than `undefined`
 *
 * Exercised through the REAL routes and the REAL file, like verify-selection.
 * The DECISION the client makes from the value is asserted separately, in
 * verify-play-decision.mjs.
 *
 * Usage: node scripts/verify-app-start-setting.mjs
 */
import { readFileSync } from 'node:fs'
import { createReport, startHarness } from './lib/harness.mjs'

const report = createReport('app-start setting')

console.log('the default, over the real routes:')
{
  const h = await startHarness()
  try {
    const list = (await h.request('GET', '/dsh-boot-animation/videos.json')).json()
    report.check(list.playOnAppStart === true, 'a fresh install is told playOnAppStart: true')

    const status = (await h.request('GET', '/dsh-boot-animation/status.json')).json()
    report.check(status.playOnAppStart === true, 'status.json publishes it too (so a bug report can be read)')

    console.log('\nwriting it off and on again:')
    const off = await h.request('POST', '/dsh-boot-animation/select', { body: { playOnAppStart: false } })
    const offBody = off.json()
    report.check(off.status === 200 && offBody.ok === true, 'POST /select accepts playOnAppStart: false')
    report.check(offBody.playOnAppStart === false, 'and answers with the stored value')

    const afterOff = (await h.request('GET', '/dsh-boot-animation/videos.json')).json()
    report.check(afterOff.playOnAppStart === false, 'the next read reports false — no stale default')

    const onDiskOff = JSON.parse(readFileSync(h.selectionFile(), 'utf8'))
    report.check(onDiskOff.playOnAppStart === false, 'false is what the file holds (not omitted, not a string)')
    report.check(onDiskOff.version === 4, `the on-disk schema is 4, got ${String(onDiskOff.version)}`)

    const on = await h.request('POST', '/dsh-boot-animation/select', { body: { playOnAppStart: true } })
    report.check(on.json().playOnAppStart === true, 'turning it back on round-trips')
    const afterOn = (await h.request('GET', '/dsh-boot-animation/videos.json')).json()
    report.check(afterOn.playOnAppStart === true, 'the read agrees again')

    console.log('\nit is independent of the other settings:')
    await h.request('POST', '/dsh-boot-animation/select', { body: { playOnAppStart: false } })
    const other = await h.request('POST', '/dsh-boot-animation/select', {
      body: { selectedClipId: 'builtin:brand', randomPlayback: true, fitMode: 'contain' },
    })
    const otherBody = other.json()
    report.check(
      otherBody.playOnAppStart === false,
      'writing an unrelated setting does not reset the toggle',
      `got ${String(otherBody.playOnAppStart)}`,
    )
    report.check(
      otherBody.selectedClipId === 'builtin:brand' && otherBody.randomPlayback === true && otherBody.fitMode === 'contain',
      'and the unrelated fields really were written',
    )

    console.log('\nbad input is refused, not coerced:')
    const stringy = await h.request('POST', '/dsh-boot-animation/select', { body: { playOnAppStart: 'false' } })
    report.check(stringy.status === 500, `a string body is refused (got ${String(stringy.status)})`)
    const stillOff = (await h.request('GET', '/dsh-boot-animation/videos.json')).json()
    report.check(
      stillOff.playOnAppStart === false,
      'the refused write left the previous value alone — no silent flip to the default',
    )
    const numbery = await h.request('POST', '/dsh-boot-animation/select', { body: { playOnAppStart: 0 } })
    report.check(numbery.status === 500, `a number body is refused (got ${String(numbery.status)})`)
    const nullish = await h.request('POST', '/dsh-boot-animation/select', { body: { playOnAppStart: null } })
    report.check(nullish.status === 500, `a null body is refused (got ${String(nullish.status)})`)
    const afterBad = (await h.request('GET', '/dsh-boot-animation/videos.json')).json()
    report.check(afterBad.playOnAppStart === false, 'and none of the refusals changed the stored value')
  } finally {
    await h.close()
  }
}

console.log('\nan older selection file (v3, no playOnAppStart):')
{
  // A harness whose $DSH_HOME already holds a v3 file — every installed copy at
  // the moment of upgrade, which is the case that must not read `undefined`.
  const h = await startHarness()
  try {
    await h.writeSelection({ version: 3, selectedClipId: 'builtin:cyberpunk', randomPlayback: true, fitMode: 'contain' })
    const list = (await h.request('GET', '/dsh-boot-animation/videos.json')).json()
    report.check(list.playOnAppStart === true, 'a v3 file reads as playOnAppStart: true')
    report.check(list.selectedClipId === 'builtin:cyberpunk', 'and keeps its pick')
    report.check(list.selectionVersion === 4, 'and is reported at the current schema version')

    const onDisk = JSON.parse(readFileSync(h.selectionFile(), 'utf8'))
    report.check(onDisk.playOnAppStart === true, 'the migration is persisted, so the next read is ordinary')
    const status = (await h.request('GET', '/dsh-boot-animation/status.json')).json()
    const kinds = status.diagnostics.events.map((event) => event.kind)
    report.check(kinds.includes('selection-migrated'), 'the migration is reported through diagnostics', kinds.join(', '))
  } finally {
    await h.close()
  }
}

console.log('\na v4 file that says false:')
{
  const h = await startHarness()
  try {
    await h.writeSelection({
      version: 4,
      selectedClipId: null,
      randomPlayback: false,
      fitMode: 'cover',
      playOnAppStart: false,
      conversationOverrides: {},
    })
    const list = (await h.request('GET', '/dsh-boot-animation/videos.json')).json()
    report.check(list.playOnAppStart === false, 'a stored false is what the client is told')
    report.check(list.selectionVersion === 4, 'and no needless migration happened')
  } finally {
    await h.close()
  }
}

report.finish()
