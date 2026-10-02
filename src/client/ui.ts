/**
 * The three surfaces this plugin renders, and the rules they obey.
 *
 *   BootOverlay   the only place a <video> element exists
 *   VideoLibrary  the picker: per-clip preview, the selection, random, fit, and
 *                 the per-conversation pin
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
  decidePlay,
  hasBootPlayed,
  hasPlayed,
  readPinned,
  recordDecision,
  useCurrentSession,
  writePinned,
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
  /** The host answered with this conversation's own pin, not the global choice. */
  conversation: '本会话指定',
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
 * Each row can be PREVIEWED (play it now, change nothing), SELECTED (make it the
 * clip that future overlays play everywhere) or PINNED TO THIS CONVERSATION
 * (make it the clip THIS conversation plays, leaving the global choice alone).
 * Those are three different buttons on purpose: preview and select used to be one
 * click that did the second while looking like the first, which is why "preview"
 * appeared to play the wrong video — and the conversation pin is a third
 * question again, so it gets a third button rather than overloading one.
 */
export function VideoLibrary({ store, onClose }: { store: ClientStore; onClose: () => void }): ReactElement {
  ensureStyle()
  const snapshot = useClientStore(store)
  const clips = snapshot.catalog?.clips ?? []
  const selectedClipId = snapshot.settings.selectedClipId
  const playingClipId = snapshot.playback.clipId
  const previewClipId = snapshot.playback.previewClipId
  const conversationClipId = snapshot.conversationClipId
  const hasSession = snapshot.sessionId !== null
  const nameOf = (clipId: string): string => clips.find((item) => item.id === clipId)?.name ?? clipId

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
        '「▶ 预览」立刻播这一段（不改你的选择）；「选它」设为全局片头；「仅本会话」只让当前这个会话播它。',
      ),
      h(
        'div',
        { className: 'dba-ses' },
        hasSession
          ? conversationClipId === null
            ? '本会话跟随全局片头。想只给这个会话换一段，点那一行的「仅本会话」。'
            : '本会话固定播放：' + nameOf(conversationClipId)
          : '还没有打开的会话：先打开一个对话，才能只对它生效。',
        conversationClipId === null
          ? null
          : h(
              'button',
              {
                type: 'button',
                className: 'dba-row-btn',
                disabled: busy,
                title: '取消这个会话的固定片头，回到全局选择',
                onClick: () => {
                  if (!busy) void store.setConversationClip(null)
                },
              },
              '取消（回到全局）',
            ),
      ),
      ...(clips.length === 0
        ? [h('div', { className: 'dba-item' }, h('span', { className: 'dba-nm' }, snapshot.loading ? '（正在读取…）' : '（还没找到任何视频）'))]
        : clips.map((clip: ClipInfo) =>
            h(
              'div',
              {
                key: clip.id,
                className:
                  'dba-item' +
                  (clip.id === selectedClipId ? ' dba-cur' : '') +
                  (clip.id === conversationClipId ? ' dba-ses-cur' : ''),
                title: clip.file ?? clip.id,
              },
              h('span', { className: 'dba-mark' }, clip.id === selectedClipId ? '✓' : ''),
              h('span', { className: 'dba-nm' }, clip.name),
              clip.id === conversationClipId ? h('span', { className: 'dba-badge dba-b-ses' }, '本会话') : null,
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
              h(
                'button',
                {
                  type: 'button',
                  className: 'dba-row-btn' + (clip.id === conversationClipId ? ' dba-go' : ''),
                  disabled: busy || !hasSession,
                  title: hasSession
                    ? '只让当前这个会话播这一段 —— 不改你给其它会话和全局选的那一段'
                    : '先打开一个对话，才能只对它生效',
                  onClick: () => {
                    if (!busy && hasSession) void store.setConversationClip(clip.id)
                  },
                },
                clip.id === conversationClipId ? '本会话 ✓' : '仅本会话',
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
      /**
       * The when-to-play switch (0.4.2). Its state is the HOST's
       * `playOnAppStart`, read back from `/videos.json` — never a client-side
       * guess — and the label spells out both rules so it cannot mislead.
       */
      h(
        'div',
        { className: 'dba-fit' },
        h('span', null, '什么时候播：'),
        h(
          'button',
          {
            type: 'button',
            className: 'dba-btn' + (snapshot.settings.playOnAppStart ? ' dba-btn-on' : ''),
            title:
              '每次启动 DSH 应用时播放一次片头；同一轮使用中不重复，下次打开 DSH 再播一次。' +
              '关掉后只在你新建会话时播一次。被钉住的会话不受这个开关影响，仍然每次进入都重播。',
            onClick: () => void store.setPlayOnAppStart(!snapshot.settings.playOnAppStart),
          },
          snapshot.settings.playOnAppStart
            ? '🚀 每次启动 DSH 时播放一次：开'
            : '🚀 每次启动 DSH 时播放一次：关（只在新建会话时播）',
        ),
        h(
          'span',
          { className: 'dba-note' },
          snapshot.settings.playOnAppStart
            ? '同一轮使用中不重复；下次打开 DSH 再播'
            : '只在新建会话时播一次',
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
  const { sessionId } = useCurrentSession(sessionStore)
  const [pinned, setPinned] = useState<string | null>(() => readPinned())
  const isPinned = sessionId !== null && pinned === sessionId

  const toggle = (): void => {
    const next = isPinned ? null : sessionId
    writePinned(next)
    setPinned(next)
    log('pin toggled', { from: pinned, to: next })
    if (next !== null) store.setStatus('已把这个会话设为片头会话', 'dba-ok')
  }

  const title = isPinned
    ? '这个会话已设为片头会话：每次打开都会播放片头动画（点击取消）'
    : '把这个会话设为片头会话：以后每次打开它都会播放片头动画'

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
        onClick: toggle,
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
 * Two rules, and the user picks which one by toggling `playOnAppStart` in the
 * library panel (the value lives on the HOST, in selection.json):
 *
 *   on  (default)  play once per DSH launch, in whatever conversation the app
 *                  opens first — the "boot animation" reading, and the fix for
 *                  the field report 「一次性的」
 *   off            the original rule: once per new conversation, per session
 *
 * A pinned conversation replays on every entry under BOTH rules, and neither
 * rule nor the toggle touches it. The decision itself is `decidePlay` in
 * session.ts — pure, so it can be tested exhaustively; this component only
 * gathers its inputs and calls `playMode`, so there is still exactly one
 * playback path for a pin, a random setting and an auto-play alike.
 */
export function AppRoot({ store, sessionStore }: { store: ClientStore; sessionStore: CurrentStore | null }): ReactElement {
  const snapshot = useClientStore(store)
  const { sessionId, isNewConversation } = useCurrentSession(sessionStore)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const lastSessionRef = useRef<string | null>(null)

  // Tell the store which conversation we are in BEFORE anything asks the host a
  // per-conversation question. Effects run in declaration order, so this lands
  // ahead of the auto-play effect below — otherwise the first resolve of a newly
  // entered conversation would be asked without its session.
  useEffect(() => {
    store.setSession(sessionId)
  }, [sessionId, store])

  // Read the library once, and again whenever the conversation changes: the
  // per-conversation pin is host state, so it arrives with the listing.
  useEffect(() => {
    void store.loadCatalog()
  }, [store, sessionId])

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

    const decision = decidePlay({
      sessionId,
      entered,
      settingsLoaded: snapshot.settingsLoaded,
      settings: snapshot.settings,
      pinned: readPinned(),
      isNewConversation,
      bootPlayed: hasBootPlayed(),
      sessionPlayed: hasPlayed(sessionId),
    })
    if (decision.action !== 'play') return
    // Record BEFORE asking to play, so a second pass (the session binding
    // settling, or the host's settings payload arriving) cannot queue a second
    // play of the same launch.
    recordDecision(decision, sessionId)
    log('playing the intro', { reason: decision.reason, sessionId })
    void store.playMode('active', decision.reason)
  }, [sessionId, isNewConversation, snapshot.settingsLoaded, snapshot.settings, store])

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
