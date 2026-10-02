/**
 * verify-boot-animation.mjs - prove the boot overlay fires on a NEW conversation.
 *
 * Opens the real GUI in headless Edge, clicks the shipped "new conversation"
 * control to create a blank session, then reads the overlay and the video
 * element back out of the DOM. If the video reports a real duration and a
 * moving currentTime, the asset was served, decoded and is genuinely playing.
 *
 * It also MEASURES that the overlay covers the whole client window (see
 * `COVERAGE_PROBE`): the rectangle must equal the viewport, no ancestor may
 * create a containing block for `position:fixed`, and the viewport's four corners
 * and centre must hit-test inside the overlay. That last part is what turns
 * "inset:0 is meant to cover everything" into an observation. Exits non-zero when
 * it does not cover.
 *
 * Scope, stated plainly: this is the DSH client WINDOW. It does not cover the OS
 * screen — the Windows taskbar and desktop stay visible. It is not a boot splash.
 *
 * Usage: node scripts/verify-boot-animation.mjs <debugPort> <guiUrl>
 */

const port = Number(process.argv[2] ?? 9345)
const url = process.argv[3]
if (url === undefined) {
  console.error('usage: node scripts/verify-boot-animation.mjs <debugPort> <guiUrl>')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = targets.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
      if (page !== undefined) return page
    } catch {
      /* starting */
    }
    await sleep(500)
  }
  throw new Error('no debuggable page target')
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    const pending = new Map()
    const exceptions = []
    const consoleErrors = []
    const pluginLogs = []
    let nextId = 0
    socket.onopen = () =>
      resolve({
        exceptions,
        consoleErrors,
        pluginLogs,
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = (nextId += 1)
            pending.set(id, { res, rej })
            socket.send(JSON.stringify({ id, method, params }))
          })
        },
        close: () => socket.close(),
      })
    socket.onerror = (e) => reject(new Error('ws error ' + String(e?.message ?? e)))
    socket.onmessage = (event) => {
      let m
      try {
        m = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (m.id !== undefined && pending.has(m.id)) {
        const entry = pending.get(m.id)
        pending.delete(m.id)
        if (m.error !== undefined) entry.rej(new Error(JSON.stringify(m.error)))
        else entry.res(m.result)
        return
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails ?? {}
        exceptions.push(String(d.exception?.description ?? d.text ?? 'unknown'))
      }
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = (m.params.args ?? []).map((a) => String(a.value ?? a.description ?? a.type)).join(' ')
        const entry = '[' + m.params.type + '] ' + text
        if (m.params.type === 'error') consoleErrors.push(entry)
        if (text.indexOf('dsh-boot-animation') !== -1) pluginLogs.push(entry)
      }
    }
  })
}

async function evaluate(client, expression) {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r?.exceptionDetails !== undefined) throw new Error('page threw: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
  return r?.result?.value
}

async function waitTrue(client, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await evaluate(client, expression)) return true
    } catch {
      /* navigating */
    }
    await sleep(600)
  }
  return false
}

/**
 * Does the overlay ACTUALLY cover the whole client window?
 *
 * `position:fixed;inset:0` only covers the viewport when no ancestor creates a
 * containing block for it. `transform`, `filter`, `perspective`, `contain` and
 * `will-change` (plus the vendor-prefixed spellings) all demote a fixed element
 * to positioning inside that ancestor, so the overlay would cover one panel
 * instead of the window. The probe below walks the REAL ancestor chain, reports
 * the measured rectangle, and hit-tests the corners and centre so "it covers
 * everything" is a measurement rather than an assumption.
 *
 * Returns `{ ok, reasons, detail }` — `reasons` is empty exactly when every
 * measurement passed.
 */
const COVERAGE_PROBE = `(() => {
  const root = document.querySelector('.dba-root');
  if (!root) return { ok: false, reasons: ['no .dba-root in the document'], detail: { root: false } };
  const rect = root.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const style = getComputedStyle(root);
  const detail = {
    position: style.position,
    zIndex: style.zIndex,
    viewport: [vw, vh],
    rect: [rect.left, rect.top, rect.width, rect.height],
    scroll: [window.scrollX, window.scrollY],
  };
  const reasons = [];
  if (style.position !== 'fixed') reasons.push('the overlay is not position:fixed (it is ' + style.position + ')');
  if (rect.width < vw - 1 || rect.height < vh - 1) {
    reasons.push('the measured rectangle ' + Math.round(rect.width) + 'x' + Math.round(rect.height) + ' does not fill the viewport ' + vw + 'x' + vh);
  }
  if (Math.abs(rect.left) > 1 || Math.abs(rect.top) > 1) {
    reasons.push('the overlay is offset from the viewport origin (' + Math.round(rect.left) + ',' + Math.round(rect.top) + ')');
  }

  // The containing-block walk. An empty list means no ancestor can capture the
  // fixed positioning, which is the property the whole rule depends on.
  //
  // Each property is compared against ITS OWN neutral value: "transform-style"
  // reports "flat" by default and "will-change" reports "auto", so treating the
  // word "none" as the only neutral value would flag every page ever rendered.
  const NEUTRAL = {
    transform: 'none', transformStyle: 'flat', translate: 'none', rotate: 'none', scale: 'none',
    filter: 'none', backdropFilter: 'none', perspective: 'none',
    contain: 'none', containerType: 'normal', willChange: 'auto',
  };
  const ancestors = [];
  for (let el = root.parentElement; el !== null; el = el.parentElement) {
    const cs = getComputedStyle(el);
    const offending = [];
    for (const [prop, neutral] of Object.entries(NEUTRAL)) {
      const value = cs[prop];
      if (typeof value === 'string' && value !== '' && value !== neutral) offending.push(prop + ': ' + value);
    }
    if (offending.length > 0) {
      ancestors.push({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || '').slice(0, 60),
        inline: String(el.getAttribute('style') || '').slice(0, 90),
        offending,
      });
    }
  }
  detail.blockers = ancestors;
  if (ancestors.length > 0) {
    reasons.push('an ancestor creates a containing block for the fixed overlay: ' + JSON.stringify(ancestors[0]));
  }

  // Hit test: every sample point must land inside the overlay (the overlay
  // itself, or one of its own children such as the <video> or the skip button).
  const points = [[2, 2], [vw - 3, 2], [2, vh - 3], [vw - 3, vh - 3], [vw / 2, vh / 2]];
  const hits = points.map((point) => {
    const hit = document.elementFromPoint(point[0], point[1]);
    return {
      at: [Math.round(point[0]), Math.round(point[1])],
      tag: hit ? hit.tagName.toLowerCase() : null,
      cls: hit ? String(hit.className || '').slice(0, 40) : null,
      inOverlay: hit !== null && (hit === root || root.contains(hit)),
    };
  });
  detail.hits = hits;
  const missed = hits.filter((hit) => !hit.inOverlay);
  if (missed.length > 0) {
    reasons.push('some points are not covered by the overlay: ' + JSON.stringify(missed));
  }

  return { ok: reasons.length === 0, reasons, detail };
})()`

/** Run the probe and print one line per measurement. */
async function reportCoverage(client, label) {
  let probe = null
  try {
    probe = JSON.parse(await evaluate(client, `JSON.stringify(${COVERAGE_PROBE})`))
  } catch (error) {
    console.log(`overlay coverage: probe failed (${String(error?.message ?? error)})`)
    return null
  }
  if (probe === null || typeof probe !== 'object') {
    console.log('overlay coverage: the probe returned nothing usable — NOT verified')
    return null
  }
  const d = probe.detail ?? {}
  console.log(`overlay coverage (${label}): ${probe.ok ? 'COVERS the client window' : 'DOES NOT COVER — ' + probe.reasons.join('; ')}`)
  console.log('  position/z   :', d.position, d.zIndex)
  console.log('  viewport     :', JSON.stringify(d.viewport))
  console.log('  rect         :', JSON.stringify(d.rect))
  console.log(
    '  ancestors    :',
    d.blockers && d.blockers.length === 0
      ? 'no containing-block ancestor (fixed resolves to the viewport)'
      : JSON.stringify(d.blockers),
  )
  console.log('  hit test     :', JSON.stringify(d.hits))
  console.log('  scope note   : this covers the DSH client WINDOW, not the OS screen (taskbar/desktop are not covered)')
  return probe
}

const page = await waitForPage()
const client = await connect(page.webSocketDebuggerUrl)
await client.send('Runtime.enable')
await client.send('Page.enable')
await client.send('Page.navigate', { url })

const booted = await waitTrue(client, `document.querySelector('.dvi-mic') !== null || document.querySelector('[class*="sidebar"]') !== null`, 75000)
console.log('booted          :', booted)
await sleep(2500)

// Is the landing session already blank (then the overlay should already be up)?
const before = await evaluate(client, `JSON.stringify({ overlay: document.querySelectorAll('.dba-root').length, seen: window.localStorage.getItem('dsh-boot-animation:seen') })`)
console.log('before click    :', before)

const candidates = await evaluate(
  client,
  `(() => {
     const all = Array.from(document.querySelectorAll('button, [role="button"], a'));
     const interesting = all
       .map((el) => ({
         text: (el.textContent || '').trim().slice(0, 24),
         title: el.getAttribute('title') || '',
         aria: el.getAttribute('aria-label') || '',
         cls: (el.className || '').toString().slice(0, 40),
       }))
       .filter((c) => /新对话|新会话|新建|new (chat|conversation|session)|compose|plus/i.test(c.text + ' ' + c.title + ' ' + c.aria + ' ' + c.cls));
     return JSON.stringify({ total: all.length, interesting: interesting.slice(0, 12) });
   })()`,
)
console.log('new-conv candidates:', candidates)

const clicked = await evaluate(
  client,
  `(() => {
     const all = Array.from(document.querySelectorAll('button, [role="button"], a'));
     const pick = (el) => ((el.textContent||'') + ' ' + (el.getAttribute('title')||'') + ' ' + (el.getAttribute('aria-label')||''));
     const hit = all.find((el) => /新建会话|新对话|new (chat|conversation|session)/i.test(pick(el)))
              || all.find((el) => /新会话/i.test(pick(el)));
     if (!hit) return JSON.stringify({ ok: false });
     const label = ((hit.getAttribute('aria-label') || hit.getAttribute('title') || hit.textContent || '').trim()).slice(0, 30);
     const cls = (hit.className || '').toString().slice(0, 40);
     hit.click();
     return JSON.stringify({ ok: true, label, cls });
   })()`,
)
console.log('clicked         :', clicked)

const appeared = await waitTrue(client, `document.querySelector('.dba-root') !== null`, 25000)
console.log('overlay appeared:', appeared)

await sleep(3500)

const probe = await evaluate(
  client,
  `(() => {
     const root = document.querySelector('.dba-root');
     const v = document.querySelector('.dba-video');
     if (!root) return JSON.stringify({ overlay: false });
     return JSON.stringify({
       overlay: true,
       hint: (document.querySelector('.dba-hint') || {}).textContent || null,
       skip: (document.querySelector('.dba-skip') || {}).textContent || null,
       videoSrc: v ? v.getAttribute('src') : null,
       readyState: v ? v.readyState : null,
       duration: v ? Number(v.duration?.toFixed?.(2) ?? v.duration) : null,
       videoWidth: v ? v.videoWidth : null,
       videoHeight: v ? v.videoHeight : null,
       paused: v ? v.paused : null,
       muted: v ? v.muted : null,
       currentTime: v ? Number(v.currentTime?.toFixed?.(2) ?? v.currentTime) : null,
       error: v && v.error ? { code: v.error.code, message: v.error.message } : null,
       zIndex: root ? getComputedStyle(root).zIndex : null,
       position: root ? getComputedStyle(root).position : null,
     });
   })()`,
)
console.log('video probe     :', probe)

// The overlay must cover the whole client WINDOW, not one panel. Measured, not
// assumed: an ancestor with transform/filter/contain/will-change would demote the
// fixed positioning, and that would only show up as "it covered part of the app".
const coverage = await reportCoverage(client, 'boot overlay')

await sleep(2500)
const advanced = await evaluate(
  client,
  `(() => { const v = document.querySelector('.dba-video'); return JSON.stringify({ currentTime: v ? Number(v.currentTime?.toFixed?.(2) ?? v.currentTime) : null, paused: v ? v.paused : null }); })()`,
)
console.log('after 2.5s      :', advanced)

const skipTest = await evaluate(
  client,
  `(() => {
     const b = document.querySelector('.dba-skip');
     if (!b) return JSON.stringify({ ok: false });
     b.click();
     return JSON.stringify({ ok: true });
   })()`,
)
await sleep(600)
const afterSkip = await evaluate(client, `JSON.stringify({ overlay: document.querySelectorAll('.dba-root').length })`)
console.log('skip clicked    :', skipTest, afterSkip)

console.log('\n--- plugin console output ---')
if (client.pluginLogs.length === 0) console.log('(none)')
for (const line of client.pluginLogs) console.log('  ' + line)

console.log('\nuncaught exceptions:', client.exceptions.length === 0 ? '(none)' : client.exceptions.slice(0, 5))
console.log('console errors     :', client.consoleErrors.length === 0 ? '(none)' : client.consoleErrors.slice(0, 5))
client.close()
// Non-zero when the overlay did NOT cover the window. The earlier probes are
// diagnostic only (they print what they saw), so a broken run must not exit 0.
const coverageOk = coverage === null ? false : coverage.ok === true
if (!coverageOk) {
  console.log('\nFAIL: the overlay did not cover the whole client window (see overlay coverage above)')
  process.exit(1)
}
console.log('\nok: the overlay covered the whole client window')
process.exit(0)
