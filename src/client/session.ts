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
 * 2. The "already played" record and session-scoped clip pins are client
 *    concerns, keyed by session id and kept in localStorage. The <=0.3.0
 *    single-pin key stays a bare-string compatibility fallback; new per-session
 *    clip bindings use a separate map, so an older client never sees a new
 *    storage shape under a key it already owns.
 */
import { useCallback, useSyncExternalStore } from 'react'
import { log } from './diagnostics.js'

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
const SESSION_CLIPS_KEY = 'dsh-boot-animation:session-clips'
const MAX_SEEN = 80

function readSeen(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : []
  } catch {
    return []
  }
}

export function hasPlayed(sessionId: string): boolean {
  return readSeen().includes(sessionId)
}

export function markPlayed(sessionId: string): void {
  try {
    const seen = readSeen()
    if (!seen.includes(sessionId)) seen.push(sessionId)
    while (seen.length > MAX_SEEN) seen.shift()
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
  } catch {
    /* private mode: it simply replays next time */
  }
}

/** The <=0.3.0 single-pin value. Keep its bare-string shape for compatibility. */
export function readPinned(): string | null {
  try {
    const value = window.localStorage.getItem(PIN_KEY)
    return value === null || value === '' ? null : value
  } catch {
    return null
  }
}

/** Only used to clear or preserve a legacy single pin; new pins use SESSION_CLIPS_KEY. */
export function writePinned(sessionId: string | null): void {
  try {
    if (sessionId === null) window.localStorage.removeItem(PIN_KEY)
    else window.localStorage.setItem(PIN_KEY, sessionId)
  } catch {
    /* private mode: the pin simply does not persist */
  }
  log('legacy pin written', { sessionId })
}

type SessionClipMap = Record<string, string>

function readSessionClips(): SessionClipMap {
  const clean = Object.create(null) as SessionClipMap
  try {
    const raw = window.localStorage.getItem(SESSION_CLIPS_KEY)
    if (raw === null || raw === '') return clean
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return clean
    for (const [sessionId, clipId] of Object.entries(parsed as Record<string, unknown>)) {
      if (sessionId !== '' && typeof clipId === 'string' && clipId !== '') clean[sessionId] = clipId
    }
  } catch {
    /* damaged/localStorage-disabled state degrades to no session-scoped pins */
  }
  return clean
}

/** The clip remembered for one session by the new multi-pin storage. */
export function readPinnedClip(sessionId: string): string | null {
  if (sessionId === '') return null
  const pins = readSessionClips()
  return Object.prototype.hasOwnProperty.call(pins, sessionId) ? pins[sessionId] : null
}

/** Add, replace or remove one session -> clip binding without touching PIN_KEY. */
export function writePinnedClip(sessionId: string, clipId: string | null): void {
  if (sessionId === '') return
  try {
    const pins = readSessionClips()
    if (clipId === null || clipId === '') delete pins[sessionId]
    else pins[sessionId] = clipId
    if (Object.keys(pins).length === 0) window.localStorage.removeItem(SESSION_CLIPS_KEY)
    else window.localStorage.setItem(SESSION_CLIPS_KEY, JSON.stringify(pins))
  } catch {
    /* private mode: the pin simply does not persist */
  }
  log('session clip pin written', { sessionId, clipId })
}

/**
 * Resolve whether one session is pinned.
 *
 * Session-scoped bindings win. A legacy <=0.3.0 bare-string pin remains readable
 * and keeps the old "follow active" behaviour until the user explicitly unpins
 * it. That lets an upgraded client add new pins without rewriting old state.
 */
export function readPinnedSession(
  sessionId: string,
): { clipId: string | null; source: 'session-map' | 'legacy' } | null {
  const clipId = readPinnedClip(sessionId)
  if (clipId !== null) return { clipId, source: 'session-map' }
  return readPinned() === sessionId ? { clipId: null, source: 'legacy' } : null
}
