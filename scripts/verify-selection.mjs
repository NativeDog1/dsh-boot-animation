/**
 * verify-selection.mjs — the selection schema, its migration, and its self-healing.
 *
 * Three claims are tested, and each corresponds to a requirement:
 *
 *   A: `selection.json` holds settings ONLY — never a media path. That includes
 *      the per-conversation layer: a pin is validated exactly like the global
 *      pick, so a path cannot get in through the map either.
 *   B: every historical or damaged shape migrates to a valid current selection.
 *   C: a selection file that cannot be parsed does NOT stop the plugin.
 *
 * The migration is exercised through the REAL exported `migrate()` (a pure
 * function, imported from the built host module) rather than by writing files and
 * inferring, and the end-to-end behaviour is exercised through the REAL routes.
 *
 * The per-conversation BEHAVIOUR (which clip actually plays) is asserted
 * separately, in verify-conversation-override.mjs; this file only owns the shape.
 *
 * Usage: node scripts/verify-selection.mjs
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createReport, startHarness } from './lib/harness.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const report = createReport('selection')

const { migrate, SELECTION_VERSION, defaultSelection } = await import(
  pathToFileURL(join(ROOT, 'lib', 'host', 'selection-store.js')).href
)

// ---------------------------------------------------------------- pure migration
console.log('migrate() — pure, no I/O:')
{
  const v1 = migrate({ id: 'builtin:brand', at: '2026-09-25T00:00:00.000Z' })
  report.check(v1.selection.selectedClipId === 'builtin:brand', 'v1 {id} carries its pick forward')
  report.check(v1.selection.version === SELECTION_VERSION, `v1 migrates to version ${String(SELECTION_VERSION)}`)
  report.check(v1.migrated === true, 'v1 reports that it was migrated')
  report.check(!('at' in v1.selection), 'v1 metadata (at) is dropped, not carried into v2')
}
{
  const v2 = migrate({ version: 2, selectedClipId: 'builtin:cyberpunk', randomPlayback: true, fitMode: 'contain' })
  report.check(v2.selection.selectedClipId === 'builtin:cyberpunk', 'v2 passes its pick through')
  report.check(v2.selection.randomPlayback === true, 'v2 passes randomPlayback through')
  report.check(v2.selection.fitMode === 'contain', 'v2 passes fitMode through')
  report.check(v2.migrated === true, 'a v2 file reports as migrated (it predates the conversation layer)')
  report.check(
    v2.selection.conversationOverrides !== null &&
      typeof v2.selection.conversationOverrides === 'object' &&
      Object.keys(v2.selection.conversationOverrides).length === 0,
    'a v2 file gains an empty conversation layer rather than an undefined one',
  )
}
{
  const v3 = migrate({
    version: 3,
    selectedClipId: 'builtin:brand',
    randomPlayback: false,
    fitMode: 'cover',
    conversationOverrides: { 'session-1': 'builtin:cyberpunk' },
  })
  report.check(v3.migrated === true, 'a v3 file (pre-`playOnAppStart`) reports as migrated')
  report.check(v3.selection.conversationOverrides['session-1'] === 'builtin:cyberpunk', 'a v3 file keeps its per-conversation pins')
  report.check(
    v3.selection.playOnAppStart === true,
    'a v3 file gains playOnAppStart: true — the rule v3 already implemented',
  )
}
{
  // The CURRENT version must not be reported as migrated, whatever it is. Written
  // against SELECTION_VERSION rather than a literal so bumping the schema cannot
  // silently turn this into "the newest file is always migrated".
  const current = migrate({
    version: SELECTION_VERSION,
    selectedClipId: 'builtin:brand',
    randomPlayback: false,
    fitMode: 'cover',
    playOnAppStart: false,
    conversationOverrides: { 'session-1': 'builtin:cyberpunk' },
  })
  report.check(current.migrated === false, `a v${String(SELECTION_VERSION)} file is not reported as migrated`)
  report.check(
    current.selection.conversationOverrides['session-1'] === 'builtin:cyberpunk',
    'a current file keeps its per-conversation pins',
  )
  report.check(current.selection.playOnAppStart === false, 'a current file keeps an explicit playOnAppStart: false')
}
{
  // The default only fills a MISSING field. Collapsing a stored `false` into the
  // default is the bug that would make an off toggle spring back on.
  report.check(migrate({ version: 3 }).selection.playOnAppStart === true, 'an absent playOnAppStart defaults to true')
  report.check(
    migrate({ version: 3, playOnAppStart: false }).selection.playOnAppStart === false,
    'a stored playOnAppStart: false survives the migration',
  )
  report.check(
    migrate({ version: 3, playOnAppStart: 'true' }).selection.playOnAppStart === true,
    'a non-boolean playOnAppStart falls back to the default rather than being trusted',
  )
  report.check(
    migrate({ version: 3, playOnAppStart: 'no' }).selection.playOnAppStart === true,
    'the default is true, not false, so a typo cannot turn the feature off',
  )
}
{
  // The conversation layer is validated by the SAME rules as the global pick: a
  // hand-edited file must not be able to smuggle a media path in through the map,
  // which is the whole reason a path is rejected as a selection in the first place.
  const dirty = migrate({
    version: 3,
    conversationOverrides: {
      'session-ok': 'builtin:brand',
      '   ': 'builtin:brand', // blank key
      'session-path': 'C:/movies/a.mp4', // a path, not a ClipId
      'session-active': 'active', // the route alias is not a real clip
      'session-num': 42, // wrong type
    },
  })
  const map = dirty.selection.conversationOverrides
  report.check(map['session-ok'] === 'builtin:brand', 'a well-formed pin survives the migration')
  report.check(!('   ' in map), 'a blank session key is dropped')
  report.check(!('session-path' in map), 'a PATH is not accepted as a pin')
  report.check(!('session-active' in map), 'the "active" alias is not accepted as a pin')
  report.check(!('session-num' in map), 'a non-string pin is dropped')
}
{
  // The rule that matters most: a path is not a ClipId, so it must never be
  // treated as one. Selection files are meant to be portable and hand-editable.
  const withPath = migrate({ id: 'C:\\Users\\someone\\clip.mp4' })
  report.check(withPath.selection.selectedClipId === null, 'a media PATH is rejected as a selection')
  const withSlash = migrate({ selectedClipId: '../../etc/passwd' })
  report.check(withSlash.selection.selectedClipId === null, 'a traversal-looking value is rejected')
}
{
  const corrupt = [
    ['null', null],
    ['a string', 'not json at all'],
    ['an array', ['builtin:brand']],
    ['a number', 42],
  ]
  for (const [label, value] of corrupt) {
    const result = migrate(value)
    report.check(
      result.selection.version === SELECTION_VERSION && result.selection.selectedClipId === null,
      `garbage (${label}) resolves to defaults`,
    )
  }
}
{
  const odd = migrate({ version: 99, selectedClipId: 'builtin:startup', randomPlayback: 'yes', fitMode: 'stretch' })
  report.check(odd.selection.fitMode === 'cover', 'an unknown fitMode falls back to the default')
  report.check(odd.selection.randomPlayback === false, 'a truthy non-boolean is not accepted as a boolean')
  report.check(odd.selection.selectedClipId === 'builtin:startup', 'a known ClipId survives a future version stamp')
}

// ------------------------------------------------------------------ over HTTP
console.log('\nover the real routes:')
{
  const h = await startHarness()
  try {
    const list = (await h.request('GET', '/dsh-boot-animation/videos.json')).json()
    report.check(list.selectionVersion === SELECTION_VERSION, 'the library reports the schema version')
    report.check(list.randomPlayback === false && list.fitMode === 'cover', 'a fresh install reads defaults')
    report.check(
      list.playOnAppStart === true,
      'a fresh install reads playOnAppStart: true (the once-per-DSH-launch rule is the default)',
    )

    const first = h.request('POST', '/dsh-boot-animation/select', { body: { selectedClipId: 'builtin:cyberpunk' } })
    const written = (await first).json()
    report.check(written.ok === true, 'select writes successfully')

    const onDisk = JSON.parse(readFileSync(h.selectionFile(), 'utf8'))
    report.check(onDisk.version === SELECTION_VERSION, `the file on disk is version ${String(SELECTION_VERSION)}`)
    report.check(onDisk.selectedClipId === 'builtin:cyberpunk', 'the file records the chosen ClipId')
    report.check(
      Object.keys(onDisk).sort().join(',') ===
        'conversationOverrides,fitMode,playOnAppStart,randomPlayback,selectedClipId,version',
      'the file contains settings ONLY (no paths, no timestamps)',
      Object.keys(onDisk).join(', '),
    )

    const patch = await h.request('POST', '/dsh-boot-animation/select', { body: { randomPlayback: true, fitMode: 'contain' } })
    const patched = patch.json()
    report.check(
      patched.randomPlayback === true && patched.fitMode === 'contain' && patched.selectedClipId === 'builtin:cyberpunk',
      'a partial write changes only the named fields',
    )

    // The v1 spelling still works: installed copies POST {id}.
    const legacy = await h.request('POST', '/dsh-boot-animation/select', { body: { id: 'builtin:brand' } })
    report.check(legacy.json().selectedClipId === 'builtin:brand', 'the legacy {id} body still selects')

    const bad = await h.request('POST', '/dsh-boot-animation/select', { body: { selectedClipId: 'builtin:nope' } })
    report.check(bad.status === 404, 'selecting an unknown ClipId is 404')
    const pathy = await h.request('POST', '/dsh-boot-animation/select', { body: { selectedClipId: 'C:/x.mp4' } })
    report.check(pathy.status === 400, 'selecting a PATH is 400')
    const nothing = await h.request('POST', '/dsh-boot-animation/select', { body: {} })
    report.check(nothing.status === 400, 'an empty patch is 400')
    const notPost = await h.request('GET', '/dsh-boot-animation/select')
    report.check(notPost.status === 405, 'GET on select is 405')
    const badJson = await h.request('POST', '/dsh-boot-animation/select', { body: '{not json', raw: true })
    report.check(badJson.status === 400, 'malformed JSON is 400, not a crash')
  } finally {
    await h.close()
  }
}

// ------------------------------------------------------- damaged file on disk
console.log('\na damaged selection file:')
{
  const home = join(process.env.TEMP ?? process.env.TMP ?? '.', 'dba-selection-' + String(Date.now()))
  mkdirSync(join(home, 'boot-animation'), { recursive: true })
  writeFileSync(join(home, 'boot-animation', 'selection.json'), '{ this is not json', 'utf8')
  const h = await startHarness({ home })
  try {
    const response = await h.request('GET', '/dsh-boot-animation/videos.json')
    report.check(response.status === 200, 'the plugin still serves the library')
    report.check(response.json().selectedClipId === null, 'and reports defaults rather than failing')
    const status = (await h.request('GET', '/dsh-boot-animation/status.json')).json()
    const kinds = status.diagnostics.events.map((event) => event.kind)
    report.check(
      kinds.includes('selection-unreadable') && kinds.includes('selection-reset'),
      'the damage is reported through diagnostics',
      kinds.join(', '),
    )
    const repaired = JSON.parse(readFileSync(join(home, 'boot-animation', 'selection.json'), 'utf8'))
    report.check(
      repaired.version === SELECTION_VERSION,
      `the file is rewritten as a valid v${String(SELECTION_VERSION)} selection`,
    )
    // A path must never survive a round trip, even from a legacy file.
    writeFileSync(join(home, 'boot-animation', 'selection.json'), JSON.stringify({ id: 'D:/movies/a.mp4' }))
    const second = await startHarness({ home })
    const list2 = (await second.request('GET', '/dsh-boot-animation/videos.json')).json()
    report.check(list2.selectedClipId === null, 'a legacy file carrying a path migrates to "nothing selected"')
    await second.close()
  } finally {
    await h.close()
    rmSync(home, { recursive: true, force: true })
  }
}

report.finish()
