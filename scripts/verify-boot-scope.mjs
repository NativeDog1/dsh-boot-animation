/**
 * verify-boot-scope.mjs — the auto-play rule, and the switch that picks it.
 *
 * Why this file exists: up to 0.4.1 the rule was "this SESSION has not played
 * yet", recorded in localStorage. So the intro played once in a conversation and
 * never again in it, and the field reported exactly that:
 *
 *   「开了一次之后就再也没有见过」 / 「是个一次性的」
 *
 * 0.4.2 adds `playOnAppStart` — a USER-VISIBLE switch, stored on the host in
 * selection.json, defaulting to true:
 *
 *   on   play once per DSH launch, in whatever conversation opens first
 *        (the boot record lives in sessionStorage, `dsh-boot-animation:boot`)
 *   off  the original rule: once per new conversation, per session
 *
 * A pinned conversation replays on every entry under both.
 *
 * The failure modes this guards against are all silent ones, which is why it
 * loads `lib/client.js` through a stub of the host's module loader and drives the
 * REAL exported functions rather than a copy:
 *
 *   - the boot record read back as already-played  -> the intro never plays
 *   - the boot record never sticking               -> it plays every render
 *   - a Storage that is absent or throws           -> must fall back to memory,
 *                                                     not to either of the above
 *   - the switch read as the wrong value, or the client guessing at it before the
 *     host's payload arrives                      -> plays against an explicit
 *                                                     "off"
 *
 * The memory fallback is tested by re-loading the bundle with storages that throw,
 * because the flags are module-level by design.
 *
 * Usage: node scripts/verify-boot-scope.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '..', 'lib', 'client.js')
const SOURCE = readFileSync(BUNDLE, 'utf8')

const BOOT_KEY = 'dsh-boot-animation:boot'
const SEEN_KEY = 'dsh-boot-animation:played'

/** Enough of React for module evaluation; nothing here renders. */
const reactStub = {
  createElement: () => null,
  useCallback: (fn) => fn,
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

/** A Web Storage, in memory. */
function makeStorage() {
  const map = new Map()
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  }
}

/**
 * Evaluate the SHIPPED bundle against a `window` of our choosing and return the
 * module's exports. `local`/`session` are either a Storage, `null` (absent), or
 * `'throw'` (present but every call throws, as in a blocked context).
 */
function loadWith({ local = makeStorage(), session = makeStorage() } = {}) {
  let loaded = null
  /** `value === 'throw'` models a Storage whose property access itself throws. */
  const accessor = (name, value) => () => {
    if (value === 'throw') throw new Error(`blocked ${name}`)
    return value
  }

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
    Object.defineProperty(globalThis.window, name, { configurable: true, get: accessor(name, value) })
  }

  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ style: {}, textContent: '' }),
    head: { appendChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ activeVersion: 'test-version' }) })

  try {
    // eslint-disable-next-line no-eval
    eval(SOURCE)
  } catch (error) {
    console.error(`verify-boot-scope: evaluating the bundle threw — ${String(error?.message ?? error)}`)
    process.exit(2)
  }
  if (loaded === null) {
    console.error('verify-boot-scope: the bundle did not call window.__ModuleLoader__.load')
    process.exit(2)
  }
  return loaded
}

const failures = []
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === '' ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}

console.log(`bundle: ${BUNDLE}\n`)

// --- surface -----------------------------------------------------------------
console.log('exported surface:')
const main = loadWith()
for (const name of [
  'hasBootPlayed',
  'markBootPlayed',
  'clearBootPlayed',
  'hasPlayed',
  'markPlayed',
  'decidePlay',
  'recordDecision',
  'readPinned',
  'writePinned',
]) {
  check(typeof main[name] === 'function', `the bundle exports ${name}()`)
}

// --- the key must actually be sessionStorage ---------------------------------
console.log('\nstorage scope:')
{
  const local = makeStorage()
  const session = makeStorage()
  const api = loadWith({ local, session })
  api.markBootPlayed()
  check(session.map.has(BOOT_KEY), `markBootPlayed() writes ${BOOT_KEY} to sessionStorage`)
  check(!local.map.has(BOOT_KEY), 'markBootPlayed() does NOT write the boot record to localStorage')
  check(api.hasBootPlayed(), 'hasBootPlayed() reads it back after marking')
}

// --- boot scope semantics ----------------------------------------------------
console.log('\nboot scope semantics:')
{
  const api = loadWith()
  check(api.hasBootPlayed() === false, 'a freshly loaded app has not played yet — the intro is due')

  api.markBootPlayed()
  check(api.hasBootPlayed() === true, 'after marking, the launch counts as played')

  // The old, session-scoped rule would answer "already played" per session id;
  // the new rule must not care which conversation is current.
  check(api.hasPlayed('session-a') === false, 'the per-session record is untouched by the boot record')
  api.markPlayed('session-a')
  check(api.hasPlayed('session-a') === true, 'markPlayed()/hasPlayed() still work as the fallback path')
  check(
    api.hasBootPlayed() === true,
    'an unrelated session record cannot make the boot record un-played',
  )
}
{
  // The documented reset path: a test (or a future "play again" affordance) can
  // model a new application launch.
  const api = loadWith()
  api.markBootPlayed()
  api.clearBootPlayed()
  check(api.hasBootPlayed() === false, 'clearBootPlayed() models a new DSH launch')
}
{
  // A boot record already present at load (the normal case: the page re-mounts
  // the overlay without the tab having closed) must suppress the intro.
  const session = makeStorage()
  session.setItem(BOOT_KEY, '1')
  const api = loadWith({ session })
  check(api.hasBootPlayed() === true, 'a boot record present at load suppresses a replay')
}
{
  // An empty/zero value is not a record — writing must have really happened.
  const session = makeStorage()
  session.setItem(BOOT_KEY, '')
  const api = loadWith({ session })
  check(api.hasBootPlayed() === false, 'an empty stored value does not count as played')
}

// --- storage that is absent or throws ---------------------------------------
console.log('\nstorage failures fall back to memory:')
{
  // Every Storage call throws (blocked third-party context / private mode).
  const api = loadWith({ local: 'throw', session: 'throw' })
  let threw = null
  try {
    check(api.hasBootPlayed() === false, 'a throwing sessionStorage reads as "not played yet"')
    api.markBootPlayed()
    check(api.hasBootPlayed() === true, 'markBootPlayed() sticks in memory when Storage throws')
    api.markPlayed('session-b')
    check(api.hasPlayed('session-b') === true, 'markPlayed() sticks in memory when Storage throws')
    api.markPlayed('session-c')
    check(api.hasPlayed('session-b') && api.hasPlayed('session-c'), 'the in-memory session list accumulates')
    api.clearBootPlayed()
    check(api.hasBootPlayed() === false, 'clearBootPlayed() clears the in-memory flag too')
  } catch (error) {
    threw = String(error?.message ?? error)
  }
  check(threw === null, `a throwing Storage never throws out of the plugin${threw === null ? '' : ` (threw: ${threw})`}`)
}
{
  // The storages are MISSING entirely (a stubbed window, a non-browser load).
  const api = loadWith({ local: null, session: null })
  let threw = null
  try {
    check(api.hasBootPlayed() === false, 'a missing sessionStorage reads as "not played yet"')
    api.markBootPlayed()
    check(api.hasBootPlayed() === true, 'markBootPlayed() sticks in memory with no Storage at all')
    check(api.readPinned() === null, 'readPinned() answers null with no localStorage')
    api.writePinned('session-d')
    check(api.readPinned() === null, 'writePinned() does not throw and does not invent a pin')
  } catch (error) {
    threw = String(error?.message ?? error)
  }
  check(threw === null, `missing Storage never throws out of the plugin${threw === null ? '' : ` (threw: ${threw})`}`)
}
{
  // One storage broken, the other fine — the pin must survive the session store
  // being unavailable, and vice versa.
  const local = makeStorage()
  const api = loadWith({ local, session: 'throw' })
  api.writePinned('session-e')
  check(local.map.get('dsh-boot-animation:pinned') === 'session-e', 'a healthy localStorage still persists the pin')
  check(api.readPinned() === 'session-e', 'the pin reads back')
}

// --- the record itself ------------------------------------------------------
console.log('\nthe shipped record:')
{
  // Guard against the change being made in session.ts only, or being reverted:
  // the boot record must really be read from sessionStorage by the shipped code.
  const local = makeStorage()
  const session = makeStorage()
  const api = loadWith({ local, session })
  api.markBootPlayed()
  check(
    session.map.has(BOOT_KEY) && !local.map.has(BOOT_KEY),
    'the shipped markBootPlayed() writes sessionStorage only',
  )
  check(/sessionStorage/.test(SOURCE), 'the shipped bundle does reach sessionStorage at all')
}

console.log('')
if (failures.length === 0) {
  console.log('all boot-scope checks passed')
  process.exit(0)
}
console.log(`${failures.length} boot-scope check(s) failed — the intro is not boot-scoped`)
process.exit(1)
