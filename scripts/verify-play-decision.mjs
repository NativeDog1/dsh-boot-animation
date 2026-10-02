/**
 * verify-play-decision.mjs — the when-to-play rule, exhaustively, as data.
 *
 * Why this file exists: 0.4.1 decided playback inline inside a React effect,
 * where the only way to observe it was to render the whole app. The rule was
 * `isNewConversation && !hasPlayed(sessionId)`, so the intro played once per
 * conversation and never again — the field report 「开了一次之后就再也没有见过」 /
 * 「是个一次性的」.
 *
 * 0.4.2 does two things:
 *   - it makes the scope a USER CHOICE, `playOnAppStart`, stored on the host
 *     (default true: once per DSH launch)
 *   - it moves the rule into `decidePlay`, a pure function, so the whole matrix
 *     can be asserted here instead of being inferred from a rendered overlay
 *
 * This drives the SHIPPED bundle's exported `decidePlay` / `recordDecision`, and
 * separately drives them in sequence to prove the bookkeeping makes the second
 * call a no-op (the "plays on every render" failure).
 *
 * Usage: node scripts/verify-play-decision.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '..', 'lib', 'client.js')

const reactStub = {
  createElement: () => null,
  useCallback: (fn) => fn,
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

function makeStorage() {
  const map = new Map()
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  }
}

/** Evaluate the shipped bundle against in-memory storages. */
function load() {
  const local = makeStorage()
  const session = makeStorage()
  let loaded = null
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ factory }) => {
        loaded = factory((id) => {
          if (id === 'react' || id === 'react/jsx-runtime') return reactStub
          throw new Error(`unexpected require(${id})`)
        })
      },
    },
  }
  for (const [name, value] of [
    ['localStorage', local],
    ['sessionStorage', session],
  ]) {
    Object.defineProperty(globalThis.window, name, { configurable: true, get: () => value })
  }
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ style: {}, textContent: '' }),
    head: { appendChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })
  try {
    // eslint-disable-next-line no-eval
    eval(readFileSync(BUNDLE, 'utf8'))
  } catch (error) {
    console.error(`verify-play-decision: evaluating the bundle threw — ${String(error?.message ?? error)}`)
    process.exit(2)
  }
  return { api: loaded, local, session }
}

const failures = []
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === '' ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}

const { api } = load()
if (api === null || typeof api.decidePlay !== 'function') {
  console.error('verify-play-decision: the bundle did not export decidePlay — cannot verify')
  process.exit(2)
}

console.log(`bundle: ${BUNDLE}\n`)

/** The inputs a healthy app-start situation has, before any override. */
function base(overrides = {}) {
  return {
    sessionId: 'session-1',
    entered: true,
    settingsLoaded: true,
    settings: { selectedClipId: null, randomPlayback: false, fitMode: 'cover', playOnAppStart: true },
    pinned: null,
    isNewConversation: false,
    bootPlayed: false,
    sessionPlayed: false,
    ...overrides,
  }
}

const decide = (overrides) => api.decidePlay(base(overrides))
const label = (decision) => `${decision.action}:${decision.reason}`

console.log('no conversation yet:')
check(label(decide({ sessionId: null })) === 'none:no conversation yet', 'nothing plays without a session')

console.log('\nplayOnAppStart = ON (the default):')
check(label(decide()) === 'play:app-start', 'an ordinary conversation still gets the launch intro')
check(
  label(decide({ isNewConversation: true })) === 'play:app-start',
  'a NEW conversation plays it too (the rule does not depend on blankness)',
)
check(
  label(decide({ isNewConversation: false, sessionPlayed: true })) === 'play:app-start',
  'a conversation that played in an EARLIER launch plays again in this one',
)
check(label(decide({ bootPlayed: true })) === 'none:this launch already played', 'it does NOT play twice in one launch')
check(
  label(decide({ bootPlayed: true, isNewConversation: true })) === 'none:this launch already played',
  'a new conversation does not re-arm it inside the same launch',
)
check(
  label(decide({ entered: false })) === 'play:app-start',
  'entering is not required: the first render of the launch is enough',
)

console.log('\nplayOnAppStart = OFF (the original rule restored):')
{
  const off = { settings: { ...base().settings, playOnAppStart: false } }
  check(
    label(decide({ ...off, isNewConversation: false })) === 'none:not a new conversation',
    'a running conversation does NOT play on launch',
  )
  check(
    label(decide({ ...off, isNewConversation: true })) === 'play:new-conversation',
    'a brand-new conversation plays',
  )
  check(
    label(decide({ ...off, isNewConversation: true, sessionPlayed: true })) === 'none:this conversation already played',
    'the same new conversation does not play twice',
  )
  check(
    label(decide({ ...off, isNewConversation: false, bootPlayed: false })) === 'none:not a new conversation',
    'the boot record is irrelevant while the switch is off',
  )
  check(
    label(decide({ ...off, isNewConversation: true, bootPlayed: true })) === 'play:new-conversation',
    'a new conversation plays even if the launch record exists (the switch really switches rules)',
  )
}

console.log('\nthe host has not answered yet:')
{
  check(
    label(decide({ settingsLoaded: false })) === 'none:settings not loaded yet',
    'nothing is decided before the host settings arrive (ON would be a guess)',
  )
  check(
    label(
      decide({
        settingsLoaded: false,
        isNewConversation: true,
        settings: { ...base().settings, playOnAppStart: false },
      }),
    ) === 'none:settings not loaded yet',
    'and nothing is decided before the payload either, even for a new conversation',
  )
}

console.log('\nthe pin outranks everything:')
{
  check(label(decide({ pinned: 'session-1' })) === 'play:pinned', 'entering the pinned conversation replays it')
  check(
    label(decide({ pinned: 'session-1', bootPlayed: true })) === 'play:pinned',
    'the launch record does not suppress a pin',
  )
  check(
    label(decide({ pinned: 'session-1', settings: { ...base().settings, playOnAppStart: false } })) === 'play:pinned',
    'the switch does not suppress a pin either',
  )
  check(
    label(decide({ pinned: 'session-1', entered: false })) === 'none:already in the pinned conversation',
    'staying in the pinned conversation does not replay it again',
  )
  check(
    label(decide({ pinned: 'session-2' })) === 'play:app-start',
    'a pin on ANOTHER conversation does not make this one pinned',
  )
  check(
    label(
      decide({
        pinned: 'session-2',
        isNewConversation: false,
        settings: { ...base().settings, playOnAppStart: false },
      }),
    ) === 'none:not a new conversation',
    'and an unrelated pin does not play in a running conversation with the switch off',
  )
}

console.log('\nthe bookkeeping makes the second call a no-op:')
{
  const { api: first } = load()
  const turn = (overrides = {}) => {
    const state = base(overrides)
    const decision = first.decidePlay({
      ...state,
      bootPlayed: first.hasBootPlayed(),
      sessionPlayed: first.hasPlayed(state.sessionId),
    })
    if (decision.action === 'play') first.recordDecision(decision, state.sessionId)
    return label(decision)
  }
  check(turn() === 'play:app-start', 'the first pass of the launch plays')
  check(turn() === 'none:this launch already played', 'a second pass in the same launch does not')
  check(turn({ sessionId: 'session-2', entered: true }) === 'none:this launch already played', 'switching conversations does not re-arm it')
  check(
    turn({ sessionId: 'session-2', isNewConversation: true, entered: true }) === 'none:this launch already played',
    'creating a new conversation does not re-arm it',
  )
  check(turn({ pinned: 'session-2', sessionId: 'session-2', entered: true }) === 'play:pinned', 'entering a pinned conversation still replays')
  check(first.hasPlayed('session-1') === true, 'the per-session fallback record was written in app-start mode too')
}

console.log('\nwith the switch OFF the launch record is never written:')
{
  const { api: second } = load()
  const offSettings = { ...base().settings, playOnAppStart: false }
  const decide2 = (overrides = {}) => second.decidePlay(base({ settings: offSettings, ...overrides }))

  const firstNew = decide2({ isNewConversation: true })
  check(label(firstNew) === 'play:new-conversation', 'a new conversation plays')
  second.recordDecision(firstNew, 'session-1')
  check(
    label(decide2({ isNewConversation: true, sessionPlayed: second.hasPlayed('session-1') })) ===
      'none:this conversation already played',
    'the same conversation does not play again',
  )
  check(second.hasBootPlayed() === false, 'the launch record was NOT written while the switch is off')
  check(
    label(decide2({ isNewConversation: true, sessionPlayed: true })) === 'none:this conversation already played',
    'and a fresh launch (no session record) would play again — the two rules really differ',
  )
}
{
  // A fresh launch of the same app: a new module instance has no boot record, so
  // the switch ON plays again — that is the entire point of the setting.
  const { api: fresh } = load()
  check(label(fresh.decidePlay(base())) === 'play:app-start', 'the next DSH launch plays again (no boot record yet)')
}

console.log('')
if (failures.length === 0) {
  console.log('all play-decision checks passed')
  process.exit(0)
}
console.log(`${failures.length} play-decision check(s) failed`)
process.exit(1)
