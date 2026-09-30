/**
 * The three surfaces this plugin renders, and the rules they obey.
 *
 *   BootOverlay   the only place a <video> element exists
 *   VideoLibrary  the picker: per-clip preview, the selection, random, fit
 *   PinAction     the pin and the library opener beside Settings
 *
 * Rules that are not negotiable, because each one is a defect that shipped:
 *
 * 1. THE OVERLAY PLAYS `playback.url` FROM THE STORE. The 0.2.x overlay froze a
 *    single shared URL at mount (`useState(videoSrc)`), so a switch could not
 *    reach it and every clip played through `boot.mp4` — "whatever is active".
 *    Now the URL identifies one clip, and a change to it re-points the element.
 *
 * 2. PREVIEW SELECTS NOTHING. Each row has its own preview button that plays
 *    that row's clip and leaves `selectedClipId` alone.
 *
 * 3. THE LIBRARY STAYS OPEN DURING A PREVIEW. Auditioning A, then B, then C is
 *    the whole point; the old design closed the modal and replayed the selected
 *    clip, which read as "every preview plays the same video".
 *
 * 4. COMPONENTS ARE RENDERED AS ELEMENTS, never called as plain functions.
 *    Calling one runs its hooks against the parent's hook list, so opening the
 *    picker changed the hook count and React threw "Rendered more hooks than
 *    during the previous render".
 */
import type { ReactElement } from 'react'
import { Fragment, createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { log, notify } from './diagnostics.js'
import {
  hasPlayed,
  markPlayed,
  readPinnedSession,
  useCurrentSession,
  writePinned,
  writePinnedClip,
  type CurrentStore,
} from './session.js'
import { ensureStyle } from './styles.js'
import { mediaUrlFor, useClientStore, type ClipInfo, type ClientStore, type FitMode } from './store.js'

/** How long a play attempt may show black before the overlay gives up. */
const STALL_TIMEOUT_MS = 25000
/** How long an error stays readable before the overlay closes itself. */
const ERROR_LINGER_MS = 8000

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB'
  return (n / 1024 / 1024).toFixed(2) + ' MB'
}

/** Where a clip comes from, as one word a user can act on. */
const SOURCE_LABEL: Record<string, string> = {
  yours: '你自己加的',
  embedded: '插件内置',
  env: '环境变量',
}

/** Why this clip is on screen, in words. */
const REASON_LABEL: Record<string, string> = {
  preview: '预览',
  'new-conversation': '新对话',
  pinned: '钉住的会话',
  random: '随机播放',
  selected: '已选片头',
  active: '当前片头',
  explicit: '指定片段',
  fallback: '回退',
}

/**
 * The playback surface.
 *
 * It owns no decision: the clip id and the URL come from the store, which got
 * them from the host's resolver or from an explicit preview. Its only job is to
 * drive one <video> element and report what happened.
 */
/**
 * Stop a media element completely when the overlay leaves the tree.
 *
 * Ported from @windyduan's PR #2. Detaching a <video> from the DOM does not stop
 * it: HMR, disabling the plugin, or a slot remount all unmount the overlay while
 * the element keeps playing and holding a decoder. `load()` aborts the pending
 * media fetch and releases the decoder.
 *
 * Exported so `scripts/verify-teardown.mjs` exercises THIS shipped function.
 */
export function releaseVideo(video: HTMLVideoElement): void {
  try {
    video.pause()
    video.currentTime = 0
    video.removeAttribute('src')
    video.load()
  } catch {
    /* a detached media element can throw here; nothing remains to clean up */
  }
}

export function BootOverlay({ store }: { store: ClientStore }): ReactElement | null {
  ensureStyle()
  const snapshot = useClientStore(store)
  const { url, nonce, phase, clipId, reason, previewClipId } = snapshot.playback
  const fit = snapshot.settings.fitMode
  const [needsTap, setNeedsTap] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const closedRef = useRef(false)

  const close = useCallback(() => {
    closedRef.current = true
    const video = videoRef.current
    if (video !== null) {
      try {
        video.pause()
      } catch {
        /* already stopped */
      }
    }
    if (document.fullscreenElement !== null && document.exitFullscreen !== undefined) {
      document.exitFullscreen().catch(() => {})
    }
    store.stop()
  }, [store])

  useEffect(() => {
    if (url === null) return undefined
    const video = videoRef.current
    if (video === null) return undefined
    closedRef.current = false
    setNeedsTap(false)
    video.muted = true

    const startedAt = performance.now()
    /** One line carrying everything a black-frame report needs. */
    const report = (label: string): void =>
      notify(label, {
        ms: Math.round(performance.now() - startedAt),
        clipId,
        reason,
        readyState: video.readyState,
        networkState: video.networkState,
        src: video.currentSrc || video.src,
      })

    const onPlaying = (): void => {
      store.setPhase('playing')
      report('first frame painted')
    }
    video.addEventListener('playing', onPlaying)

    // Point the element at THIS clip's resource and force a fresh load. The URL
    // names one clip, so the previous clip's cached ranges cannot be spliced in.
    video.src = url
    video.load()
    const attempt = video.play()
    if (attempt !== undefined && typeof attempt.then === 'function') {
      attempt.then(() => log('play started', { clipId })).catch((error: unknown) => {
        log('play rejected', String(error))
        setNeedsTap(true)
      })
    }

    const guard = window.setTimeout(() => {
      if (!closedRef.current) {
        // Report BEFORE closing: a silent close leaves nothing to diagnose.
        store.setPhase('stalled', '视频加载超时')
        report('stalled, giving up after ' + String(STALL_TIMEOUT_MS) + 'ms')
        close()
      }
    }, STALL_TIMEOUT_MS)

    return () => {
      video.removeEventListener('playing', onPlaying)
      window.clearTimeout(guard)
      // Unmount is another way the overlay disappears (HMR, plugin disable,
      // slot remount). Detaching a <video> does not stop media by itself.
      releaseVideo(video)
    }
  }, [url, nonce, clipId, reason, store, close])

  if (url === null || phase === 'idle') return null

  const activate = (): void => {
    const video = videoRef.current
    if (video === null) return
    if (needsTap) {
      setNeedsTap(false)
      video.muted = false
      const attempt = video.play()
      if (attempt !== undefined && typeof attempt.catch === 'function') attempt.catch(() => {})
    } else if (video.muted) {
      video.muted = false
    }
    if (document.fullscreenElement === null && typeof video.requestFullscreen === 'function') {
      video.requestFullscreen().catch(() => {})
    }
  }

  const clip = clipId === null ? null : store.clip(clipId)
  const label = REASON_LABEL[reason] ?? reason

  return h(
    'div',
    { className: 'dba-root', onClick: activate },
    h('video', {
      ref: videoRef,
      className: fit === 'cover' ? 'dba-video dba-cover' : 'dba-video',
      muted: true,
      autoPlay: true,
      playsInline: true,
      preload: 'auto',
      onEnded: close,
      onError: () => {
        const video = videoRef.current
        const code = video?.error?.code ?? 0
        const message = video?.error?.message ?? ''
        notify('video element error', {
          code,
          message,
          clipId,
          src: video?.currentSrc || url,
          readyState: video?.readyState ?? -1,
        })
        // A clip that cannot be decoded is that clip's problem, not the
        // plugin's: report it, stay readable for a moment, then close.
        store.setPhase('error', '视频加载失败 —— 控制台有 [dsh-boot-animation] 日志')
        window.setTimeout(() => {
          if (!closedRef.current) close()
        }, ERROR_LINGER_MS)
      },
      onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
    }),
    h('div', { className: 'dba-what' }, `${label} · ${clip?.name ?? clipId ?? ''}`),
    phase === 'playing'
      ? null
      : h('div', { className: 'dba-status' }, phase === 'error' ? (snapshot.playback.message || '视频加载失败') : phase === 'stalled' ? '视频加载超时' : '正在加载视频…'),
    h(
      'button',
      {
        type: 'button',
        className: 'dba-skip',
        onClick: (event: { stopPropagation: () => void }) => {
          event.stopPropagation()
          close()
        },
      },
      '跳过',
    ),
    h(
      'div',
      { className: 'dba-hint' },
      needsTap ? '点击播放' : '点击开启声音 · 全屏',
      previewClipId !== null && previewClipId === clipId ? ' · 预览中' : '',
    ),
  )
}

/**
 * The picker.
 *
 * Each row can be PREVIEWED (play it now, change nothing) or SELECTED (make it
 * the clip that future overlays play). Those are two different buttons on
 * purpose: they used to be one click that did the second while looking like the
 * first, which is why "preview" appeared to play the wrong video.
 */
export function VideoLibrary({ store, onClose }: { store: ClientStore; onClose: () => void }): ReactElement {
  ensureStyle()
  const snapshot = useClientStore(store)
  const clips = snapshot.catalog?.clips ?? []
  const selectedClipId = snapshot.settings.selectedClipId
  const playingClipId = snapshot.playback.clipId
  const previewClipId = snapshot.playback.previewClipId

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const busy = snapshot.busy

  return h(
    'div',
    {
      className: 'dba-veil',
      onClick: (event: { target: unknown; currentTarget: unknown }) => {
        if (event.target === event.currentTarget) onClose()
      },
    },
    h(
      'div',
      { className: 'dba-lib', onClick: (event: { stopPropagation: () => void }) => event.stopPropagation() },
      h('h3', null, '片头片库'),
      h(
        'p',
        null,
        '「▶ 预览」立刻播这一段（不改你的选择）；「选它」把它设为以后开片头时播放的片段。',
      ),
      ...(clips.length === 0
        ? [h('div', { className: 'dba-item' }, h('span', { className: 'dba-nm' }, snapshot.loading ? '（正在读取…）' : '（还没找到任何视频）'))]
        : clips.map((clip: ClipInfo) =>
            h(
              'div',
              {
                key: clip.id,
                className: 'dba-item' + (clip.id === selectedClipId ? ' dba-cur' : ''),
                title: clip.file ?? clip.id,
              },
              h('span', { className: 'dba-mark' }, clip.id === selectedClipId ? '✓' : ''),
              h('span', { className: 'dba-nm' }, clip.name),
              clip.id === playingClipId
                ? h('span', { className: 'dba-badge dba-b-sel' }, previewClipId === clip.id ? '预览中' : '播放中')
                : null,
              clip.legacy ? h('span', { className: 'dba-badge' }, '原片源') : null,
              (clip.copies ?? 1) > 1
                ? h(
                    'span',
                    {
                      className: 'dba-badge',
                      title:
                        '这一段在磁盘上有 ' +
                        String(clip.copies) +
                        ' 份相同的副本，已合并成一条。你的文件没有被删，只是不重复列出。',
                    },
                    '合并 ' + String(clip.copies) + ' 份重复',
                  )
                : null,
              (clip.ext === '.mp4' || clip.ext === '.m4v') && clip.faststart === false
                ? h(
                    'span',
                    {
                      className: 'dba-badge dba-b-warn',
                      title: '这个文件的索引表(moov)在末尾：浏览器要整段下载完才出画面，容易黑屏。用 ffmpeg -c copy -movflags +faststart 重排一次即可。',
                    },
                    '⚠ 未优化',
                  )
                : null,
              h('span', { className: 'dba-badge' }, SOURCE_LABEL[clip.source] ?? clip.source),
              h('span', { className: 'dba-meta' }, formatBytes(clip.bytes)),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dba-row-btn',
                  title: '立刻播放这一段，不改变你的选择',
                  onClick: () => {
                    store.preview(clip.id)
                  },
                },
                '▶ 预览',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dba-row-btn' + (clip.id === selectedClipId ? '' : ' dba-go'),
                  disabled: busy || clip.id === selectedClipId,
                  title: '设为以后开片头时播放的片段',
                  onClick: () => {
                    if (!busy) void store.selectClip(clip.id)
                  },
                },
                clip.id === selectedClipId ? '已选' : '选它',
              ),
            ),
          )),
      h(
        'div',
        { className: 'dba-dir' },
        '想加自己的片子：把 mp4 放进这个文件夹，再点「刷新」',
        h('br', null),
        h('code', null, snapshot.catalog?.userDir ?? '…'),
      ),
      h(
        'div',
        { className: 'dba-fit' },
        h('span', null, '播放方式：'),
        h(
          'button',
          {
            type: 'button',
            className: 'dba-btn' + (snapshot.settings.fitMode === 'cover' ? ' dba-btn-on' : ''),
            title: '铺满整个窗口，超出部分裁掉 —— 不留黑边',
            onClick: () => void store.setFitMode('cover' satisfies FitMode),
          },
          '铺满屏幕',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dba-btn' + (snapshot.settings.fitMode === 'contain' ? ' dba-btn-on' : ''),
            title: '完整显示整帧，长宽比不匹配时留黑边',
            onClick: () => void store.setFitMode('contain' satisfies FitMode),
          },
          '完整显示',
        ),
        h('span', { className: 'dba-flex' }),
        h(
          'button',
          {
            type: 'button',
            className: 'dba-btn' + (snapshot.settings.randomPlayback ? ' dba-btn-on' : ''),
            title: '每次开片头时，从所有可播放的片段里随机挑一段（连续两次不会挑到同一段）',
            onClick: () => void store.setRandomPlayback(!snapshot.settings.randomPlayback),
          },
          snapshot.settings.randomPlayback ? '🎲 随机播放：开' : '🎲 随机播放：关',
        ),
      ),
      h(
        'div',
        { className: 'dba-bar' },
        h(
          'button',
          {
            type: 'button',
            className: 'dba-btn',
            title: '立刻按当前设置播一次（随机开启时就是从全部片段里随机挑一段）',
            onClick: () => void store.playMode(snapshot.settings.randomPlayback ? 'random' : 'selected', 'active'),
          },
          '▶ 播一次',
        ),
        h('button', { type: 'button', className: 'dba-btn', onClick: () => void store.loadCatalog() }, '刷新'),
        h('button', { type: 'button', className: 'dba-btn', onClick: onClose }, '关闭'),
      ),
      h('div', { className: 'dba-msg ' + snapshot.status.kind }, snapshot.status.text),
    ),
  )
}

/** The pin toggle that lives beside Settings at the sidebar foot. */
export function PinAction({
  store,
  sessionStore,
  onOpen,
}: {
  store: ClientStore
  sessionStore: CurrentStore | null
  onOpen: () => void
}): ReactElement {
  ensureStyle()
  const snapshot = useClientStore(store)
  const { sessionId } = useCurrentSession(sessionStore)
  const [, refreshPin] = useState(0)
  const pin = sessionId === null ? null : readPinnedSession(sessionId)
  const isPinned = pin !== null

  const toggle = async (): Promise<void> => {
    if (sessionId === null) return

    if (pin !== null) {
      writePinnedClip(sessionId, null)
      // A legacy bare-string pin has no entry in the new map. Clearing it is the
      // only write we make to the old key, and only because the user explicitly
      // asked to unpin that exact session.
      if (pin.source === 'legacy') writePinned(null)
      refreshPin((n) => n + 1)
      log('pin toggled off', { sessionId, source: pin.source })
      store.setStatus('已取消这个会话的片头固定', 'dba-ok')
      return
    }

    // Snapshot the explicit choice when there is one. A fresh install can have
    // no selectedClipId yet; ask the existing resolver for the clip that is
    // active right now rather than inventing a second priority chain in the UI.
    let clipId = snapshot.settings.selectedClipId
    if (clipId === null || store.clip(clipId) === null) clipId = await store.resolveClipId('active')
    if (clipId === null) {
      store.setStatus('暂时无法确定这个会话要固定哪一段片头', 'dba-err')
      return
    }

    writePinnedClip(sessionId, clipId)
    refreshPin((n) => n + 1)
    log('pin toggled on', { sessionId, clipId })
    store.setStatus(`已把这个会话固定为：${store.clip(clipId)?.name ?? clipId}`, 'dba-ok')
  }

  const pinnedName = pin?.clipId === null || pin === null ? null : (store.clip(pin.clipId)?.name ?? pin.clipId)
  const title = isPinned
    ? pinnedName === null
      ? '这个会话已设为片头会话：每次打开都会按当前设置播放（点击取消）'
      : `这个会话已设为片头会话：每次打开固定播放「${pinnedName}」（点击取消）`
    : '把这个会话设为片头会话：记住当前片头，以后每次打开它都播放这一段'

  return h(
    'span',
    { className: 'dba-pin-wrap', style: { display: 'inline-flex', alignItems: 'center' } },
    h(
      'button',
      {
        type: 'button',
        className: isPinned ? 'dba-pin dba-pin-on' : 'dba-pin',
        title,
        'aria-label': title,
        disabled: sessionId === null,
        onClick: () => {
          void toggle()
        },
      },
      isPinned ? '🎬' : '🎞',
    ),
    h(
      'button',
      {
        type: 'button',
        className: 'dba-pin dba-lib-open',
        title: '片头片库：查看、预览、切换或添加片头视频',
        'aria-label': '打开片头片库',
        onClick: onOpen,
      },
      '🎛',
    ),
  )
}

/**
 * The overlay's host component: the only place the "when to play" rules live.
 *
 * A new conversation plays once (recorded per session); a pinned conversation
 * replays on every entry. A session-scoped pin carries an explicit ClipId and
 * therefore goes straight to `playClip`; legacy <=0.3.0 pins still follow
 * `playMode('active')`. Both paths converge on the same playback controller.
 */
export function AppRoot({ store, sessionStore }: { store: ClientStore; sessionStore: CurrentStore | null }): ReactElement {
  const snapshot = useClientStore(store)
  const { sessionId, isNewConversation } = useCurrentSession(sessionStore)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const lastSessionRef = useRef<string | null>(null)

  // Read the library once, then whenever the picker or a write says it changed.
  useEffect(() => {
    void store.loadCatalog()
  }, [store])

  // Register as the picker's opener. The pin lives in another slot and cannot
  // share React state with this tree, so it reaches us through this set.
  useEffect(() => {
    const handler = (): void => setLibraryOpen(true)
    libraryOpeners.add(handler)
    return () => {
      libraryOpeners.delete(handler)
    }
  }, [])

  useEffect(() => {
    if (sessionId === null) return
    const entered = lastSessionRef.current !== sessionId
    lastSessionRef.current = sessionId

    const pin = readPinnedSession(sessionId)
    // playClip needs the catalog to translate a ClipId into its versioned media
    // URL. Do not consume the "entered" edge until that one prerequisite exists.
    if (pin?.clipId !== null && pin !== null && snapshot.catalog === null) return

    if (pin !== null) {
      if (!entered) return
      if (pin.clipId === null) {
        log('legacy pinned session opened', sessionId)
        void store.playMode('active', 'pinned')
      } else {
        log('session-scoped pinned clip opened', { sessionId, clipId: pin.clipId })
        if (!store.playClip(pin.clipId, 'pinned')) {
          // A user file may have moved since it was pinned. Preserve the plugin's
          // graceful-fallback rule rather than turning one stale mapping into a
          // broken overlay.
          void store.playMode('active', 'pinned')
        }
      }
      return
    }
    if (isNewConversation && !hasPlayed(sessionId)) {
      markPlayed(sessionId)
      log('new conversation', sessionId)
      void store.playMode('active', 'new-conversation')
    }
  }, [sessionId, isNewConversation, snapshot.catalog, store])

  // A Fragment, not a wrapper element: the overlay is `position:fixed`, and an
  // extra box in the tree is exactly the kind of change that once took this
  // overlay fully black in the real app. A Fragment adds no DOM node at all.
  return h(
    Fragment,
    null,
    h(BootOverlay, { store }),
    libraryOpen ? h(VideoLibrary, { store, onClose: () => setLibraryOpen(false) }) : null,
  )
}

/** Openers registered by mounted AppRoots. */
export const libraryOpeners = new Set<() => void>()

/** Ask whichever AppRoot is mounted to show the picker. */
export function openLibrary(): void {
  for (const open of libraryOpeners) {
    try {
      open()
    } catch {
      /* a stale subscriber must not break the pin */
    }
  }
}

export { mediaUrlFor }
