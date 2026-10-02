/**
 * verify-conversation-override.mjs — the per-conversation layer, end to end.
 *
 * The layer answers a second question: not "which clip do I usually want" but
 * "which clip does THIS conversation want". Each claim below is a requirement,
 * and each one is a way the feature could be worse than not having it:
 *
 *   A: a pin answers for ITS conversation, and for no other.
 *   B: a pin never rewrites the global selection — and clearing one returns the
 *      conversation to the global answer, not to nothing.
 *   C: a pin outranks a deliberate random request for `mode=active`/`selected`,
 *      and NEVER for `mode=random` (where random was asked for by name).
 *   D: a pin naming a clip that has gone degrades to the ordinary chain and is
 *      reported through diagnostics — never an error, never a blank overlay.
 *   E: the listing publishes only the ASKING conversation's pin; other session
 *      ids never leave the host.
 *   F: a pin is validated exactly like a global pick (no paths, no `active`
 *      alias, no unknown clip), the file keeps its exact key set, and the map is
 *      capped with the least recently used conversation evicted first.
 *   G: the client half carries the session on every per-conversation call and a
 *      conversation write does not clobber the global settings.
 *
 * The host half is exercised through the REAL routes (scripts/lib/harness.mjs),
 * and the browser half through the REAL built bundle (scripts/lib/client-bundle.mjs).
 *
 * Usage: node scripts/verify-conversation-override.mjs
 */
import { readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { builtinClips, loadClientBundle, makeFetchStub } from './lib/client-bundle.mjs'
import { createReport, startHarness } from './lib/harness.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const report = createReport('conversation override')

const SELECT = '/dsh-boot-animation/select'
const RESOLVE = '/dsh-boot-animation/resolve.json'
const LIST = '/dsh-boot-animation/videos.json'
const STATUS = '/dsh-boot-animation/status.json'

const withSession = (path, session) =>
  session === null ? path : `${path}${path.includes('?') ? '&' : '?'}session=${encodeURIComponent(session)}`

/** Resolve as one conversation (or globally, with session === null). */
async function resolveAs(h, session, mode = 'active') {
  return (await h.request('GET', withSession(`${RESOLVE}?mode=${mode}`, session))).json()
}

const { MAX_CONVERSATION_OVERRIDES, SelectionStore } = await import(
  pathToFileURL(join(ROOT, 'lib', 'host', 'selection-store.js')).href
)

console.log('a pin answers for its own conversation:')
{
  const h = await startHarness()
  try {
    const written = await h.request('POST', SELECT, {
      body: { scope: 'conversation', sessionId: 'session-alpha', id: 'builtin:cyberpunk' },
    })
    const ack = written.json()
    report.check(ack.ok === true, 'pinning a conversation is accepted')
    report.check(ack.conversationClipId === 'builtin:cyberpunk', 'and answers with the pinned ClipId')
    report.check(
      typeof ack.name === 'string' && ack.name.includes('赛博朋克'),
      'and with the clip name, so the UI can say it',
      String(ack.name),
    )

    const pinned = await resolveAs(h, 'session-alpha')
    report.check(pinned.clipId === 'builtin:cyberpunk', 'the pinned conversation resolves to it')
    report.check(pinned.how === 'conversation', 'and says WHY (how=conversation)', String(pinned.how))

    const other = await resolveAs(h, 'session-beta')
    report.check(other.clipId !== 'builtin:cyberpunk', 'another conversation is NOT affected')
    report.check(other.how !== 'conversation', 'and reports its own reason', String(other.how))

    const anon = await resolveAs(h, null)
    report.check(anon.how !== 'conversation', 'a call with no session is never answered by a pin')
  } finally {
    await h.close()
  }
}

console.log('\nthe global choice is never rewritten:')
{
  const h = await startHarness()
  try {
    await h.request('POST', SELECT, { body: { selectedClipId: 'builtin:brand' } })
    await h.request('POST', SELECT, {
      body: { scope: 'conversation', sessionId: 'session-alpha', id: 'builtin:cyberpunk' },
    })

    const listing = (await h.request('GET', withSession(LIST, 'session-alpha'))).json()
    report.check(listing.selectedClipId === 'builtin:brand', 'the global selection is still the global one')
    report.check(listing.conversationClipId === 'builtin:cyberpunk', 'while the conversation reports its own pin')
    report.check(
      listing.videos.filter((clip) => clip.conversation === true).length === 1,
      'exactly one row is flagged as this conversation\'s pin',
    )
    report.check(
      listing.videos.find((clip) => clip.conversation === true)?.id === 'builtin:cyberpunk',
      'and it is the pinned row',
    )

    const onDisk = JSON.parse(readFileSync(h.selectionFile(), 'utf8'))
    report.check(onDisk.selectedClipId === 'builtin:brand', 'the file still records the global pick')
    report.check(
      onDisk.conversationOverrides['session-alpha'] === 'builtin:cyberpunk',
      'and records the pin in its own layer',
    )
    report.check(
      // `playOnAppStart` joined the set in 0.4.2; the point of the assertion is
      // that a session id never becomes a top-level field, so the expected set is
      // spelled out rather than counted.
      Object.keys(onDisk).sort().join(',') ===
        'conversationOverrides,fitMode,playOnAppStart,randomPlayback,selectedClipId,version',
      'the settings file keeps its exact key set — no session id becomes a top-level field',
      Object.keys(onDisk).join(', '),
    )

    const cleared = await h.request('POST', SELECT, {
      body: { scope: 'conversation', sessionId: 'session-alpha', id: null },
    })
    report.check(cleared.json().conversationClipId === null, 'clearing the pin is accepted')
    const back = await resolveAs(h, 'session-alpha')
    report.check(back.clipId === 'builtin:brand', 'and the conversation returns to the GLOBAL choice')
    report.check(back.how === 'selected', 'reported as the global selection again', String(back.how))
  } finally {
    await h.close()
  }
}

console.log('\nindependence between conversations:')
{
  const h = await startHarness()
  try {
    await h.request('POST', SELECT, { body: { selectedClipId: 'builtin:brand' } })
    await h.request('POST', SELECT, { body: { scope: 'conversation', sessionId: 'session-alpha', id: 'builtin:cyberpunk' } })
    await h.request('POST', SELECT, { body: { scope: 'conversation', sessionId: 'session-beta', id: 'builtin:startup' } })

    report.check((await resolveAs(h, 'session-alpha')).clipId === 'builtin:cyberpunk', 'alpha keeps its own pin')
    report.check((await resolveAs(h, 'session-beta')).clipId === 'builtin:startup', 'beta keeps its own pin')

    await h.request('POST', SELECT, { body: { scope: 'conversation', sessionId: 'session-alpha', id: null } })
    report.check((await resolveAs(h, 'session-alpha')).clipId === 'builtin:brand', 'clearing alpha falls back')
    report.check((await resolveAs(h, 'session-beta')).clipId === 'builtin:startup', 'and leaves beta alone')
  } finally {
    await h.close()
  }
}

console.log('\na pin versus random playback:')
{
  const h = await startHarness()
  try {
    await h.request('POST', SELECT, { body: { selectedClipId: 'builtin:brand', randomPlayback: true } })
    await h.request('POST', SELECT, { body: { scope: 'conversation', sessionId: 'session-alpha', id: 'builtin:cyberpunk' } })

    const pinned = await resolveAs(h, 'session-alpha')
    report.check(
      pinned.clipId === 'builtin:cyberpunk' && pinned.how === 'conversation',
      'pinning a conversation and then being handed a random clip is not what pinning means',
      JSON.stringify(pinned),
    )
    const other = await resolveAs(h, 'session-beta')
    report.check(other.how === 'random', 'every other conversation still plays at random', String(other.how))

    const asked = await resolveAs(h, 'session-alpha', 'random')
    report.check(
      asked.how === 'random',
      'but an EXPLICIT random request is never answered by a pin',
      JSON.stringify(asked),
    )

    const selected = await resolveAs(h, 'session-alpha', 'selected')
    report.check(
      selected.clipId === 'builtin:cyberpunk' && selected.how === 'conversation',
      'mode=selected answers with the pin: it is this conversation\'s choice',
      JSON.stringify(selected),
    )
    const globalSelected = await resolveAs(h, 'session-beta', 'selected')
    report.check(
      globalSelected.clipId === 'builtin:brand' && globalSelected.how === 'selected',
      'and without a pin it is the stored global selection',
      JSON.stringify(globalSelected),
    )
  } finally {
    await h.close()
  }
}

console.log('\na pin whose clip is gone:')
{
  const h = await startHarness()
  try {
    // The user moved or deleted the file the pin names.
    h.writeSelection({
      version: 3,
      selectedClipId: 'builtin:brand',
      randomPlayback: false,
      fitMode: 'cover',
      conversationOverrides: { 'session-alpha': 'builtin:deleted-long-ago' },
    })
    const fallen = await resolveAs(h, 'session-alpha')
    report.check(fallen.clipId === 'builtin:brand', 'it degrades to the ordinary chain rather than showing nothing')
    report.check(fallen.how === 'selected', 'and reports the reason it actually used', String(fallen.how))

    const status = (await h.request('GET', STATUS)).json()
    const kinds = status.diagnostics.events.map((event) => event.kind)
    report.check(
      kinds.includes('conversation-override-stale'),
      'the stale pin is reported through diagnostics',
      kinds.join(', '),
    )
    report.check(status.conversationOverrideCount === 1, 'and is still remembered (a returned file revives it)')
  } finally {
    await h.close()
  }
}

console.log('\nonly the asking conversation learns its own pin:')
{
  const h = await startHarness()
  try {
    await h.request('POST', SELECT, { body: { scope: 'conversation', sessionId: 'session-alpha', id: 'builtin:cyberpunk' } })
    await h.request('POST', SELECT, { body: { scope: 'conversation', sessionId: 'session-beta', id: 'builtin:startup' } })

    const alphaResponse = await h.request('GET', withSession(LIST, 'session-alpha'))
    const alphaBody = alphaResponse.text
    report.check(alphaBody.includes('builtin:cyberpunk'), 'alpha is told about its own pin')
    report.check(!alphaBody.includes('session-beta'), 'and is told NOTHING about another conversation')
    // The picker lists every clip, so another conversation's clip id is present
    // simply because it is a clip. What must NOT be present is the ANSWER: no row
    // may be flagged as this conversation's pin except this conversation's own.
    report.check(
      alphaResponse.json().videos.find((clip) => clip.id === 'builtin:startup')?.conversation !== true,
      'the row another conversation pinned is not flagged as this one\'s',
    )

    const anonymous = (await h.request('GET', LIST)).json()
    report.check(anonymous.conversationClipId === null, 'a caller with no session gets no pin')
    report.check(anonymous.sessionKnown === false, 'and is told that no conversation was named')
  } finally {
    await h.close()
  }
}

console.log('\nvalidation:')
{
  const h = await startHarness()
  try {
    // A real settings file first, so "a refused write changed nothing" is a claim
    // about an existing file rather than about a file that was never created.
    await h.request('POST', SELECT, { body: { selectedClipId: 'builtin:brand' } })
    const before = readFileSync(h.selectionFile(), 'utf8')

    const cases = [
      ['a conversation write with no session', { scope: 'conversation', id: 'builtin:brand' }, 400],
      ['a blank session id', { scope: 'conversation', sessionId: '   ', id: 'builtin:brand' }, 400],
      ['a conversation write with no id', { scope: 'conversation', sessionId: 'session-alpha' }, 400],
      ['an unknown clip', { scope: 'conversation', sessionId: 'session-alpha', id: 'builtin:nope' }, 404],
      ['a PATH as a pin', { scope: 'conversation', sessionId: 'session-alpha', id: 'C:/movies/a.mp4' }, 400],
      ['the "active" alias as a pin', { scope: 'conversation', sessionId: 'session-alpha', id: 'active' }, 400],
      ['an unknown scope', { scope: 'elsewhere', id: 'builtin:brand' }, 400],
    ]
    for (const [label, body, want] of cases) {
      const response = await h.request('POST', SELECT, { body })
      report.check(response.status === want, `${label} is ${String(want)}`, `got ${String(response.status)}`)
    }

    // A refused write must not have changed anything.
    const after = readFileSync(h.selectionFile(), 'utf8')
    report.check(after === before, 'a refused write leaves the settings file byte-for-byte untouched')
    report.check(!after.includes('session-alpha'), 'and records no session id')
    // The original global behaviour is intact, byte for byte.
    const legacy = await h.request('POST', SELECT, { body: { id: 'builtin:startup' } })
    report.check(legacy.json().selectedClipId === 'builtin:startup', 'the legacy {id} body still selects globally')
  } finally {
    await h.close()
  }
}

console.log('\nthe map is bounded, and the generic patch cannot rewrite it:')
{
  const file = join(process.env.TEMP ?? process.env.TMP ?? '.', `dba-override-cap-${String(Date.now())}.json`)
  try {
    const store = new SelectionStore(file)
    for (let index = 0; index < MAX_CONVERSATION_OVERRIDES; index += 1) {
      store.setConversationOverride(`s-${String(index)}`, 'builtin:brand')
    }
    store.setConversationOverride('s-0', 'builtin:cyberpunk') // re-touch the oldest
    store.setConversationOverride('s-new', 'builtin:brand') // forces exactly one eviction

    const map = store.read().conversationOverrides
    report.check(
      Object.keys(map).length === MAX_CONVERSATION_OVERRIDES,
      `the layer is capped at exactly ${String(MAX_CONVERSATION_OVERRIDES)}`,
      String(Object.keys(map).length),
    )
    report.check(map['s-0'] === 'builtin:cyberpunk', 're-using a conversation keeps it, with its new clip')
    report.check(!('s-1' in map), 'what gets evicted is the least recently SET conversation, not the oldest key')
    report.check(map['s-new'] === 'builtin:brand', 'and the newest pin is present')

    let refused = false
    try {
      store.write({ conversationOverrides: {} })
    } catch {
      refused = true
    }
    report.check(refused, 'the map is not reachable through the generic settings patch')
  } finally {
    rmSync(file, { force: true })
    rmSync(file + '.tmp', { force: true })
  }
}

console.log('\nthe client half:')
{
  const bundle = loadClientBundle()
  const clips = builtinClips()
  const { fetchStub, calls, state } = makeFetchStub({ clips, selectedClipId: 'builtin:brand' })
  globalThis.fetch = fetchStub
  const store = new bundle.ClientStore()

  store.setSession('session-alpha')
  await store.loadCatalog()
  report.check(store.getSnapshot().sessionId === 'session-alpha', 'the store carries the conversation id')
  report.check(
    calls.some((call) => call.url.includes('session=session-alpha')),
    'the listing is asked FOR the conversation',
    calls.map((call) => call.url).join(' '),
  )
  report.check(store.getSnapshot().conversationClipId === null, 'a conversation with no pin reports none')

  const pinned = await store.setConversationClip('builtin:cyberpunk')
  const posted = JSON.parse(String(calls.filter((call) => call.url.includes('/select')).pop().body))
  report.check(pinned === true, 'pinning a conversation from the picker succeeds')
  report.check(
    posted.scope === 'conversation' && posted.sessionId === 'session-alpha',
    'the write names the scope AND the conversation',
    JSON.stringify(posted),
  )
  report.check(store.getSnapshot().conversationClipId === 'builtin:cyberpunk', 'the pin reaches the snapshot')
  report.check(
    store.getSnapshot().settings.selectedClipId === 'builtin:brand',
    'and the GLOBAL selection is left exactly as it was',
  )

  await store.playMode('active', 'new-conversation')
  const resolveCall = calls.filter((call) => call.url.includes('/resolve.json')).pop()
  report.check(resolveCall.url.includes('session=session-alpha'), 'resolve carries the conversation too')
  report.check(store.getSnapshot().playback.clipId === 'builtin:cyberpunk', 'this conversation plays the pinned clip')
  report.check(
    store.getSnapshot().playback.reason === 'conversation',
    'with the host\'s reason attached, so the overlay can say so',
    store.getSnapshot().playback.reason,
  )

  store.setSession('session-beta')
  await store.loadCatalog()
  report.check(store.getSnapshot().conversationClipId === null, 'another conversation has no pin')
  await store.playMode('active', 'new-conversation')
  report.check(store.getSnapshot().playback.clipId === 'builtin:brand', 'and follows the global choice')
  report.check(store.getSnapshot().playback.reason === 'selected', 'reported as the global selection')

  store.setSession('session-alpha')
  await store.loadCatalog()
  const cleared = await store.setConversationClip(null)
  report.check(cleared === true, 'clearing the pin from the picker succeeds')
  report.check(store.getSnapshot().conversationClipId === null, 'the pin is gone from the snapshot')
  report.check(state.conversationOverrides['session-alpha'] === undefined, 'and gone from the host')
  report.check(
    store.getSnapshot().settings.selectedClipId === 'builtin:brand',
    'while the global choice is still untouched',
  )

  store.setSession(null)
  const refused = await store.setConversationClip('builtin:brand')
  report.check(refused === false, 'with no conversation open the write is refused')
  report.check(
    store.getSnapshot().status.kind === 'dba-err',
    'and the reason is shown rather than silently swallowed',
    store.getSnapshot().status.text,
  )
}

report.finish()
