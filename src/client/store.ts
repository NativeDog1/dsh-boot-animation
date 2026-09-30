/**
 * ClientStore — the client's ONE source of truth.
 *
 * The 0.2.x client kept this state in four unrelated places: a module-level
 * `activeVersion` fetched once per page, a `src` frozen with `useState` at
 * overlay mount, the library's own local list, and a `fit` value that lived only
 * in localStorage. Nothing could answer "which clip is playing right now", which
 * is why selecting B could keep playing A until a reload.
 *
 * Here every one of those is one field on one object, and the three clip
 * identities are deliberately NOT the same field:
 *
 *   settings.selectedClipId      what the user chose; changes ONLY on select()
 *   playback.clipId              what the <video> element is being pointed at
 *   playback.previewClipId       what the last preview asked for (may equal
 *                                neither of the others, and never persists)
 *
 * A mutation replaces the snapshot object, so `useSyncExternalStore` sees a new
 * reference exactly when something changed — and never otherwise.
 *
 * `playback.nonce` increments on every play request. Without it, asking to play
 * the same clip twice would be a no-op for React (same clipId, same url), and a
 * replay button that does nothing is the bug this guards against.
 */
import { useSyncExternalStore } from 'react'
import { log, notify } from './diagnostics.js'

export type FitMode = 'cover' | 'contain'
export type PlaybackPhase = 'idle' | 'loading' | 'playing' | 'stalled' | 'error'

/** One clip as the host lists it. */
export type ClipInfo = {
  id: string
  name: string
  file: string | null
  ext: string
  source: string
  kind?: string
  writable?: boolean
  embedded?: string | null
  bytes: number
  mtime?: string | null
  legacy?: boolean
  faststart?: boolean
  version?: string | null
  mediaUrl?: string
  copies?: number
  alsoAt?: string[]
  active?: boolean
  selected?: boolean
}

export type Catalog = {
  clips: ClipInfo[]
  userDir: string
  accepts: string[]
}

export type Settings = {
  selectedClipId: string | null
  randomPlayback: boolean
  fitMode: FitMode
}

export type Playback = {
  clipId: string | null
  previewClipId: string | null
  url: string | null
  phase: PlaybackPhase
  reason: string
  nonce: number
  message: string
}

export type Snapshot = {
  catalog: Catalog | null
  settings: Settings
  playback: Playback
  loading: boolean
  busy: boolean
  status: { text: string; kind: string }
}

const BASE = '/dsh-boot-animation'
const LIST_URL = `${BASE}/videos.json`
const SELECT_URL = `${BASE}/select`
const RESOLVE_URL = `${BASE}/resolve.json`

const EMPTY_SETTINGS: Settings = { selectedClipId: null, randomPlayback: false, fitMode: 'cover' }

const IDLE_PLAYBACK: Playback = {
  clipId: null,
  previewClipId: null,
  url: null,
  phase: 'idle',
  reason: 'none',
  nonce: 0,
  message: '',
}

/**
 * The media URL for one clip.
 *
 * Addressed by ClipId, with the clip's own content identity pinned as `?v=`.
 * That is what makes "select A, then B, then C" deterministic without a reload:
 * every clip is a different resource, so nothing can be served from the previous
 * clip's cache entry, and a pinned URL is immutable because it cannot go stale.
 */
export function mediaUrlFor(clip: ClipInfo): string {
  const path = clip.mediaUrl ?? `${BASE}/media/${encodeURIComponent(clip.id)}`
  const version = clip.version
  return typeof version === 'string' && version !== '' ? `${path}?v=${encodeURIComponent(version)}` : path
}

export class ClientStore {
  #snapshot: Snapshot = {
    catalog: null,
    settings: EMPTY_SETTINGS,
    playback: IDLE_PLAYBACK,
    loading: false,
    busy: false,
    status: { text: '', kind: '' },
  }

  #listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = (): Snapshot => this.#snapshot

  #set(patch: Partial<Snapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch }
    for (const listener of this.#listeners) {
      try {
        listener()
      } catch {
        /* one broken subscriber must not stop the others */
      }
    }
  }

  /** Read the library and the settings from the host. Safe to call repeatedly. */
  async loadCatalog(): Promise<void> {
    this.#set({ loading: true })
    try {
      const response = await fetch(LIST_URL, { cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const data = (await response.json()) as {
        videos?: ClipInfo[]
        userDir?: string
        accepts?: string[]
        selectedClipId?: string | null
        randomPlayback?: boolean
        fitMode?: FitMode
      }
      this.#set({
        catalog: {
          clips: Array.isArray(data.videos) ? data.videos : [],
          userDir: typeof data.userDir === 'string' ? data.userDir : '',
          accepts: Array.isArray(data.accepts) ? data.accepts : [],
        },
        settings: {
          selectedClipId: typeof data.selectedClipId === 'string' ? data.selectedClipId : null,
          randomPlayback: data.randomPlayback === true,
          fitMode: data.fitMode === 'contain' ? 'contain' : 'cover',
        },
        loading: false,
        status: { text: '', kind: '' },
      })
      log('catalog loaded', { clips: data.videos?.length ?? 0 })
    } catch (error) {
      notify('catalog load failed', String(error))
      this.#set({ loading: false, status: { text: '读取片库失败：' + String(error), kind: 'dba-err' } })
    }
  }

  /** Everything that reaches the host's selection endpoint goes through here. */
  async #writeSettings(patch: Record<string, unknown>, okText: string): Promise<boolean> {
    this.#set({ busy: true })
    try {
      const response = await fetch(SELECT_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const data = (await response.json()) as {
        ok?: boolean
        error?: string
        selectedClipId?: string | null
        randomPlayback?: boolean
        fitMode?: FitMode
      }
      if (data.ok !== true) {
        this.#set({ busy: false, status: { text: '保存失败：' + String(data.error ?? '未知错误'), kind: 'dba-err' } })
        return false
      }
      this.#set({
        busy: false,
        settings: {
          selectedClipId: typeof data.selectedClipId === 'string' ? data.selectedClipId : null,
          randomPlayback: data.randomPlayback === true,
          fitMode: data.fitMode === 'contain' ? 'contain' : 'cover',
        },
        status: { text: okText, kind: 'dba-ok' },
      })
      await this.loadCatalog()
      return true
    } catch (error) {
      this.#set({ busy: false, status: { text: '保存失败：' + String(error), kind: 'dba-err' } })
      return false
    }
  }

  /**
   * Choose a clip. The ONLY method that changes `settings.selectedClipId`.
   *
   * Preview deliberately does not call this: previewing a clip you have not
   * chosen must never silently become your choice.
   */
  async selectClip(clipId: string): Promise<boolean> {
    const clip = this.clip(clipId)
    const ok = await this.#writeSettings({ selectedClipId: clipId }, `已选为片头：${clip?.name ?? clipId}`)
    return ok
  }

  async setRandomPlayback(on: boolean): Promise<boolean> {
    return this.#writeSettings({ randomPlayback: on }, on ? '已开启随机播放' : '已关闭随机播放')
  }

  async setFitMode(mode: FitMode): Promise<boolean> {
    return this.#writeSettings({ fitMode: mode }, mode === 'cover' ? '已设为「铺满屏幕」' : '已设为「完整显示」')
  }

  /** One clip from the loaded catalog. */
  clip(clipId: string): ClipInfo | null {
    const catalog = this.#snapshot.catalog
    if (catalog === null) return null
    return catalog.clips.find((item) => item.id === clipId) ?? null
  }

  setStatus(text: string, kind: string): void {
    this.#set({ status: { text, kind } })
  }

  /**
   * Point the player at one clip. THE playback entry point.
   *
   * `reason` is recorded so diagnostics can say why this clip is playing
   * ('preview', 'new-conversation', 'pinned', 'random', 'manual'), and every
   * caller — preview, new conversation, pinned session, random — arrives here.
   */
  playClip(clipId: string, reason: string): boolean {
    const clip = this.clip(clipId)
    if (clip === null) {
      notify('play requested for an unknown clip', { clipId, reason })
      return false
    }
    const playback = this.#snapshot.playback
    this.#set({
      playback: {
        ...playback,
        clipId,
        url: mediaUrlFor(clip),
        phase: 'loading',
        reason,
        nonce: playback.nonce + 1,
        message: '',
      },
    })
    notify('play', { clipId, reason, url: mediaUrlFor(clip) })
    return true
  }

  /**
   * Resolve one mode without starting playback.
   *
   * Pinning uses this only when there is no explicit selectedClipId to snapshot.
   * Keeping resolution in the store preserves the same host boundary as playMode:
   * the UI never grows its own fetch/priority logic.
   */
  async resolveClipId(mode: 'active' | 'random' | 'selected' = 'active'): Promise<string | null> {
    try {
      const response = await fetch(`${RESOLVE_URL}?mode=${mode}`, { cache: 'no-store' })
      if (response.ok) {
        const data = (await response.json()) as { clipId?: string | null }
        if (typeof data.clipId === 'string' && data.clipId !== '') return data.clipId
        if (data.clipId === null) return null
      }
      notify('resolve id fell back to the catalog', { mode })
    } catch (error) {
      notify('resolve id failed', String(error))
    }

    const settings = this.#snapshot.settings
    if (mode === 'selected') return settings.selectedClipId
    if (mode === 'random' || settings.randomPlayback) {
      const pool = this.#snapshot.catalog?.clips ?? []
      return pool.length > 0 ? pool[0].id : null
    }
    return settings.selectedClipId
  }

  /**
   * Ask the host which clip should play in a given mode, then play it.
   *
   * The client never decides this itself: `selected`, `active` (which honours
   * random playback) and `random` are all answered by the host's ClipResolver, so
   * there is exactly one implementation of the priority chain and one of the
   * "do not repeat" rule. If the host cannot be reached, this degrades to
   * whatever the catalog already knows rather than failing the overlay.
   */
  async playMode(mode: 'active' | 'random' | 'selected', reason: string): Promise<boolean> {
    try {
      const response = await fetch(`${RESOLVE_URL}?mode=${mode}`, { cache: 'no-store' })
      if (response.ok) {
        const data = (await response.json()) as { clipId?: string | null; how?: string }
        if (typeof data.clipId === 'string' && data.clipId !== '') {
          return this.playClip(data.clipId, data.how ?? reason)
        }
      }
      notify('resolve fell back to the catalog', { mode })
    } catch (error) {
      notify('resolve failed', String(error))
    }
    const settings = this.#snapshot.settings
    if (settings.randomPlayback) {
      const pool = this.#snapshot.catalog?.clips ?? []
      if (pool.length > 0) return this.playClip(pool[0].id, 'fallback')
      return false
    }
    if (settings.selectedClipId !== null) return this.playClip(settings.selectedClipId, 'fallback')
    return false
  }

  /**
   * Preview one specific clip.
   *
   * Records `previewClipId` so the UI can mark what is being auditioned, and
   * plays it — without touching the selection. Previewing B while A is selected
   * must show B and leave A selected.
   */
  preview(clipId: string, reason = 'preview'): boolean {
    const played = this.playClip(clipId, reason)
    if (played) {
      this.#set({ playback: { ...this.#snapshot.playback, previewClipId: clipId } })
    }
    return played
  }

  /** Report the phase the <video> element reached. */
  setPhase(phase: PlaybackPhase, message = ''): void {
    if (this.#snapshot.playback.phase === phase && this.#snapshot.playback.message === message) return
    this.#set({ playback: { ...this.#snapshot.playback, phase, message } })
  }

  /** Stop playback (overlay closed, ended, or skipped). */
  stop(): void {
    const playback = this.#snapshot.playback
    if (playback.phase === 'idle' && playback.clipId === null) return
    this.#set({ playback: { ...playback, phase: 'idle', clipId: null, url: null, message: '' } })
  }
}

/** The store as React sees it, without the 1005-line component that used to own it. */
export function useClientStore(store: ClientStore): Snapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}
