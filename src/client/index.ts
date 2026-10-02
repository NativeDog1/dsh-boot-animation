/**
 * dsh-boot-animation — browser half.
 *
 * Seating:
 *   - `shell.overlay`          the frame-wide floating layer for the animation
 *   - `sidebar.footer.action`  the pin toggle and the picker button, beside Settings
 * Both are list slots, so each is an added cell, never a replacement.
 *
 * NO STATIC `inject`, deliberately. A static dependency the host cannot satisfy
 * leaves this plugin's fiber PENDING forever, and the web boot treats ANY entry
 * that is not `active` as fatal — it throws `web boot: N entry did not activate`
 * and the entire GUI fails to load. That happened in the field:
 *
 *   dsh-boot-animation: pending (waiting for service: uisession)
 *
 * A cosmetic intro animation must never be able to cost someone their harness, so
 * both services are resolved through cordis's dynamic injection: the wait happens
 * in a CHILD fiber and this entry activates immediately. On a host that never
 * provides them, the plugin silently does nothing — the correct failure mode for
 * an add-on like this one. `scripts/verify-client-boot.mjs` asserts the invariant.
 *
 * Everything below `apply` is the store and the controllers; the decisions
 * themselves are in `store.ts` and, on the host, `clip-resolver.js`. This file
 * only wires them to slots.
 */
import type { ReactElement } from 'react'
import { createElement as h } from 'react'
import { log, notify } from './diagnostics.js'
import { ClientStore } from './store.js'
import type { CurrentStore } from './session.js'
import { AppRoot, PinAction, openLibrary } from './ui.js'

/** Re-exported so the shipped bundle can be tested directly, not a copy. */
export { isBlankSession, resolveSessionId } from './session.js'
/**
 * The boot-scope record and the when-to-play rule, re-exported for
 * `scripts/verify-boot-scope.mjs`: `decidePlay` is the 0.4.2 fix expressed as a
 * pure function, and a test that could not reach it would only be able to assert
 * that the bundle built.
 */
export {
  clearBootPlayed,
  decidePlay,
  hasBootPlayed,
  hasPlayed,
  markBootPlayed,
  markPlayed,
  readPinned,
  recordDecision,
  writePinned,
} from './session.js'
export { DEFAULT_PLAY_ON_APP_START } from './store.js'
export { ClientStore, mediaUrlFor } from './store.js'
export { releaseVideo } from './ui.js'

type ClientContext = {
  slots: {
    inject: (name: string, register: () => unknown) => unknown
    register: (options: Record<string, unknown>, component: unknown) => unknown
  }
  uiSession?: { adapter?: { current?: CurrentStore } }
  effect?: (callback: () => unknown, label?: string) => unknown
  /**
   * cordis's dynamic injection, `Context.inject(deps, callback)`: the wait
   * happens in a CHILD fiber, so our own entry still reaches `active`. That is
   * the difference between "this plugin has nothing to attach to" and "the whole
   * web boot fails".
   */
  inject?: (deps: string[], callback: (ready: ClientContext) => unknown) => unknown
}

/** The ui-session store, when the host provides one that behaves. */
function storeOf(ready: ClientContext): CurrentStore | null {
  const candidate = ready.uiSession?.adapter?.current
  return candidate !== undefined &&
    typeof candidate.getSnapshot === 'function' &&
    typeof candidate.subscribe === 'function'
    ? candidate
    : null
}

export function apply(ctx: ClientContext): void {
  const wire = (ready: ClientContext): void => {
    const sessionStore = storeOf(ready)
    const store = new ClientStore()
    log('services ready', { hasUiSession: ready.uiSession !== undefined, hasStore: sessionStore !== null })

    const register = (): void => {
      // Slot names are inlined on purpose: the injector's pre-flight check reads
      // register() calls statically and cannot follow a constant.
      ready.slots.inject('shell.overlay', () =>
        ready.slots.register({ name: 'shell.overlay', id: 'dsh-boot-animation', order: 900 }, () =>
          h(AppRoot, { store, sessionStore }),
        ),
      )
      ready.slots.inject('sidebar.footer.action', () =>
        ready.slots.register(
          { name: 'sidebar.footer.action', id: 'dsh-boot-animation-pin', order: 40, label: () => '片头动画' },
          () => h(PinAction, { store, sessionStore, onOpen: () => openLibrary() }) as ReactElement,
        ),
      )
    }

    if (typeof ready.effect === 'function') ready.effect(register, 'dsh-boot-animation: mounts')
    else register()
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['slots', 'uiSession'], wire)
    return
  }

  // A host without dynamic injection. Mounting eagerly is only safe when the
  // services are already there; otherwise this plugin stays idle rather than
  // risking the pending-forever state that takes the whole GUI down.
  if (ctx.slots !== undefined && ctx.uiSession !== undefined) wire(ctx)
  else notify('idle: host offers no dynamic injection and no uiSession')
}
