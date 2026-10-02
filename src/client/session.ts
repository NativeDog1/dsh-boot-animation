/**
 * Session binding: which conversation is current, and whether it is new.
 *
 * Two pieces of hard-won knowledge live here and must not be lost:
 *
 * 1. `hooks.session` is a `SessionFace` — `ISession & ObservableSnapshot<SessionSnapshot>`
 *    (see `@deepseek-ai/dsh-api-session-controller`) — so "this conversation has
 *    no turns yet" is `getSnapshot().blank`. Before DSH 0.2.0 the flag was a
 *    `blankBit` field directly on the binding. Reading the field that is no
 *    longer there does not throw, it answers `undefined`, so the failure was
 *    silence: auto-play simply stopped happening. Both shapes are read, and the
 *    face is SUBSCRIBED to rather than sampled once, because the flag arrives on
 *    a nested snapshot that can settle after the binding changes.
 *
 * 2. The pin is per session, keyed by session id, and lives in localStorage.
 *    It is a client concern: the host never learns a session id from this
 *    plugin.
 *
 * 3. THE AUTO-PLAY RECORD IS BOOT-SCOPED, NOT SESSION-SCOPED (0.4.2). Up to
 *    0.4.1 the record was a per-session "already played" list in localStorage,
 *    so the intro ran exactly once per conversation and never again in it — the
 *    field report was "开了一次之后就再也没有见过" / "是个一次性的". A boot
 *    animation has to key off the APPLICATION LAUNCH, so the record now lives in
 *    sessionStorage (`dsh-boot-animation:boot`), which the browser scopes to one
 *    tab and drops when that tab closes. Opening DSH plays it once; the rest of
 *    that launch never replays it. The per-session list survives as the
 *    documented fallback path (`hasPlayed` / `markPlayed`), not as the rule.
 *
 * 4. Storage is never allowed to decide WHETHER the intro can play. Every read
 *    and write goes through `readStore`/`setItem`, which tolerate a Storage that
 *    is missing or throws (private mode, blocked third-party context, quota) and
 *    fall back to module-level memory flags. Without that fallback a blocked
 *    sessionStorage looks like "already played" forever, or like "not played
 *    yet" on every render — both are real risks now that the record decides
 *    playback.
 */
import { useCallback, useSyncExternalStore } from 'react'
import { log } from './diagnostics.js'
import type { Settings } from './store.js'

/** The part of a `SessionFace` this plugin reads. */
export type SessionFaceLike = {
  getSnapshot?: () => { blank?: unknown; sessionId?: unknown } | null | undefined
  subscribe?: (onChange: () => void) => unknown
  blankBit?: unknown
}

/** The resolved ui-session binding as the built-in source publishes it. */
export type Binding = {
  key?: unknown
  hooks?: { session?: SessionFaceLike }
  keyedHooks?: unknown
  props?: { sessionId?: unknown }
}

/** The `adapter.current` store, as far as this plugin needs it. */
export type CurrentStore = {
  subscribe: (onChange: () => void) => () => void
  getSnapshot: () => unknown
}

/**
 * True when the current conversation still has no turns, from whichever shape
 * the running host exposes.
 *
 * Exported so `scripts/verify-blank.mjs` can exercise THIS shipped function
 * rather than a copy of it. The bug it guards against is a silent one — a field
 * that moved answers `undefined` instead of throwing — so a test that only
 * checked "the bundle built" would not have caught it.
 */
export function isBlankSession(session: SessionFaceLike | undefined): boolean {
  if (session === null || session === undefined) return false
  if (typeof session.getSnapshot === 'function') {
    try {
      const snapshot = session.getSnapshot()
      // Trust the snapshot only when the key is actually present: a pre-0.2.0
      // face may not carry it, and an `undefined` there must not shadow the
      // legacy field.
      if (snapshot !== null && typeof snapshot === 'object' && 'blank' in snapshot) {
        return snapshot.blank === true
      }
    } catch {
      /* a face that throws on read falls through to the legacy field */
    }
  }
  return session.blankBit === true
}

/**
 * Resolve the current Session identity across the host shapes this plugin supports.
 *
 * Ported from @windyduan's PR #2. Reading only `props.sessionId` does not throw on
 * a host that moved the identity — it answers `undefined`, so the per-session
 * "already played" record and the pin silently stopped matching. The modern
 * Session face carries `sessionId` in its snapshot; ui-session's current adapter
 * also publishes the same identity as `binding.key`; the old prop stays last as a
 * compatibility fallback.
 *
 * Exported so `scripts/verify-session-id.mjs` exercises THIS shipped function.
 */
export function resolveSessionId(binding: Binding | null | undefined): string | null {
  const session = binding?.hooks?.session
  let snapshot: unknown = null
  try {
    if (session !== undefined && typeof session.getSnapshot === 'function') {
      snapshot = session.getSnapshot()
    }
  } catch {
    /* a face that throws on read falls through to the other published shapes */
  }

  const candidate =
    (snapshot !== null && typeof snapshot === 'object' && 'sessionId' in snapshot
      ? (snapshot as { sessionId?: unknown }).sessionId
      : undefined) ??
    (typeof binding?.key === 'string' ? binding.key : undefined) ??
    (typeof binding?.props?.sessionId === 'string' ? binding.props.sessionId : undefined)

  return typeof candidate === 'string' && candidate !== '' ? candidate : null
}

const noopSubscribe = () => () => {}

/** Subscribe to the current-conversation store, tolerating its absence. */
export function useCurrentSession(store: CurrentStore | null): {
  sessionId: string | null
  isNewConversation: boolean
} {
  const binding = useSyncExternalStore(
    store === null ? noopSubscribe : store.subscribe,
    store === null ? () => null : store.getSnapshot,
  ) as Binding | null

  const session = binding?.hooks?.session

  // The face is itself an observable, so subscribe to it rather than sampling it
  // once. A session is created blank and its snapshot can settle after the
  // binding changes; judging it only on the render that changed `sessionId` made
  // auto-play depend on which of two stores happened to settle first.
  const subscribeBlank = useCallback(
    (onChange: () => void): (() => void) => {
      if (session === undefined || typeof session.subscribe !== 'function') return () => {}
      const stop = session.subscribe(onChange)
      return typeof stop === 'function' ? (stop as () => void) : () => {}
    },
    [session],
  )
  const isNewConversation = useSyncExternalStore(subscribeBlank, () => isBlankSession(session))

  const sessionId = resolveSessionId(binding)
  return { sessionId, isNewConversation }
}

const SEEN_KEY = 'dsh-boot-animation:played'
const PIN_KEY = 'dsh-boot-animation:pinned'
/** Boot scope: dropped by the browser when the tab (i.e. the DSH launch) closes. */
export const BOOT_KEY = 'dsh-boot-animation:boot'
const MAX_SEEN = 80

/**
 * The part of the Web Storage API this plugin uses.
 *
 * Structural rather than the DOM `Storage` type: `tsconfig.json` compiles with
 * `lib: ["ES2023"]` (no DOM), and this also documents that nothing here needs
 * more than these three methods.
 */
export type StorageLike = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

/**
 * A Storage that may not exist and may throw on any call.
 *
 * `window.sessionStorage` can be *missing* (a host that stubs `window`, a
 * non-browser evaluation of the bundle) and the property access itself throws in
 * some sandboxed contexts, so it is always read through this call rather than at
 * module scope.
 */
function readStore(kind: 'local' | 'session'): StorageLike | null {
  try {
    const store = (kind === 'local' ? window.localStorage : window.sessionStorage) as
      | StorageLike
      | null
      | undefined
    return store ?? null
  } catch {
    /* the property access itself can throw; the memory fallback takes over */
    return null
  }
}

function getItem(kind: 'local' | 'session', key: string): string | null {
  try {
    const store = readStore(kind)
    return store === null ? null : store.getItem(key)
  } catch {
    return null
  }
}

/** `false` when nothing could be written — the caller then keeps its memory flag. */
function setItem(kind: 'local' | 'session', key: string, value: string): boolean {
  try {
    const store = readStore(kind)
    if (store === null) return false
    store.setItem(key, value)
    return true
  } catch {
    return false
  }
}

function removeItem(kind: 'local' | 'session', key: string): void {
  try {
    const store = readStore(kind)
    if (store !== null) store.removeItem(key)
  } catch {
    /* nothing to remove */
  }
}

/**
 * Memory fallbacks, used only when the real Storage cannot answer.
 *
 * A blocked Storage must not become "never plays" (if the record read back as
 * already-played) nor "plays on every render" (if the record never stuck). One
 * boolean is enough for the boot flag: it is one-way for the life of the tab.
 */
let bootPlayedInMemory = false
let seenInMemory: string[] = []

function readSeen(): string[] {
  const raw = getItem('local', SEEN_KEY)
  if (raw === null) return seenInMemory.slice()
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : []
  } catch {
    return []
  }
}

/**
 * Has this conversation already had its intro?
 *
 * Since 0.4.2 the auto-play rule is boot-scoped and no longer asks this — it is
 * kept because it is the per-session memory `markPlayed` writes, and because
 * `scripts/verify-boot-scope.mjs` exercises both as the documented fallback.
 */
export function hasPlayed(sessionId: string): boolean {
  return readSeen().includes(sessionId)
}

export function markPlayed(sessionId: string): void {
  const seen = readSeen()
  if (!seen.includes(sessionId)) seen.push(sessionId)
  while (seen.length > MAX_SEEN) seen.shift()
  if (!setItem('local', SEEN_KEY, JSON.stringify(seen))) seenInMemory = seen
}

/** Has the intro already played in THIS launch of the DSH GUI? */
export function hasBootPlayed(): boolean {
  const raw = getItem('session', BOOT_KEY)
  if (raw === null) return bootPlayedInMemory
  return raw !== '' && raw !== '0'
}

/** Record that this launch has had its intro. Called BEFORE `playMode` plays. */
export function markBootPlayed(): void {
  bootPlayedInMemory = true
  setItem('session', BOOT_KEY, String(Date.now()))
}

/** Forget the boot record — lets a test model a fresh application launch. */
export function clearBootPlayed(): void {
  bootPlayedInMemory = false
  removeItem('session', BOOT_KEY)
}

export function readPinned(): string | null {
  const value = getItem('local', PIN_KEY)
  return value === null || value === '' ? null : value
}

export function writePinned(sessionId: string | null): void {
  if (sessionId === null) removeItem('local', PIN_KEY)
  else setItem('local', PIN_KEY, sessionId)
  log('pin written', { sessionId })
}

/** What the when-to-play rule decided, as data. */
export type PlayDecision =
  | { action: 'none'; reason: string }
  | { action: 'play'; reason: 'pinned' | 'app-start' | 'new-conversation' }

/** Everything the decision reads. Passed in, so the rule is testable as data. */
export type PlayDecisionInput = {
  sessionId: string | null
  /** The conversation changed on this render (a fresh entry into it). */
  entered: boolean
  /** Did the host payload arrive? Undecided until it does. */
  settingsLoaded: boolean
  settings: Settings
  /** `readPinned()` — the conversation the user pinned, or null. */
  pinned: string | null
  /** `isBlankSession(...)` — the conversation has no turns yet. */
  isNewConversation: boolean
  /** `hasBootPlayed()` — this DSH launch already played. */
  bootPlayed: boolean
  /** `hasPlayed(sessionId)` — the fallback per-session record. */
  sessionPlayed: boolean
}

/**
 * THE when-to-play rule, as one pure function.
 *
 * Three outcomes, in priority order:
 *
 *   1. PINNED     the current conversation is the pinned one and we just entered
 *                 it -> replay. Unaffected by `playOnAppStart` and by any record.
 *   2. APP-START  `playOnAppStart` is on and this launch has not played yet ->
 *                 play once, wherever we are.
 *   3. NEW CONV.  `playOnAppStart` is off -> the original rule: a conversation
 *                 with no turns yet that has not played before.
 *
 * The `settingsLoaded` gate is what keeps the client from guessing: the toggle is
 * the host's, so until the host answers, no rule is applied at all. Guessing
 * either way would play the intro against a user who turned it off.
 *
 * Pure on purpose — `scripts/verify-play-decision.mjs` drives THIS function over
 * the whole matrix instead of inferring the rule from a rendered overlay.
 */
export function decidePlay(input: PlayDecisionInput): PlayDecision {
  if (input.sessionId === null) return { action: 'none', reason: 'no conversation yet' }

  if (input.pinned !== null && input.pinned === input.sessionId) {
    if (!input.entered) return { action: 'none', reason: 'already in the pinned conversation' }
    return { action: 'play', reason: 'pinned' }
  }

  if (!input.settingsLoaded) return { action: 'none', reason: 'settings not loaded yet' }

  if (input.settings.playOnAppStart) {
    return input.bootPlayed ? { action: 'none', reason: 'this launch already played' } : { action: 'play', reason: 'app-start' }
  }

  if (!input.isNewConversation) return { action: 'none', reason: 'not a new conversation' }
  if (input.sessionPlayed) return { action: 'none', reason: 'this conversation already played' }
  return { action: 'play', reason: 'new-conversation' }
}

/**
 * Apply a decision's bookkeeping. Called by the effect, never by `decidePlay`,
 * so the pure rule stays pure and side effects stay in one place.
 */
export function recordDecision(decision: PlayDecision, sessionId: string | null): void {
  if (decision.action !== 'play' || decision.reason === 'pinned') return
  if (decision.reason === 'app-start') markBootPlayed()
  // The per-session record is written in BOTH modes: it is the fallback for a
  // host that never answers with settings, and `markPlayed` de-duplicates.
  if (sessionId !== null) markPlayed(sessionId)
}
