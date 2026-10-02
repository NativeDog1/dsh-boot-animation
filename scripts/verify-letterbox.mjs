/**
 * verify-letterbox.mjs — measure, in a real browser, how much black the overlay
 * leaves around the clip.
 *
 * Why this exists: "there is a black bar" is a claim about RENDERED layout, and
 * reasoning about `object-fit` in the abstract got it wrong once already. This
 * drives Edge over CDP, puts the plugin's own overlay CSS and the plugin's own
 * video route in front of a real layout engine, and reads the numbers back:
 * the video element's box, the viewport it sits in, and the letterbox the
 * chosen `object-fit` actually produces.
 *
 * It also reproduces the everyday cause of the bars: a browser viewport is NOT
 * the clip's aspect ratio, because window chrome takes height away. A 16:9 clip
 * on a 16:9 screen is still letterboxed.
 *
 * And it measures the OVERLAY'S COVERAGE (since 0.4.2): the same page is rendered
 * twice — once bare, once inside an ancestor with `transform: translateZ(0)`,
 * which is the real-world way a `position:fixed` element stops covering the
 * window and starts covering one panel instead. The bare page must COVER; the
 * wrapped one must be DETECTED as not covering. The second half is the negative
 * control: without it, a probe that always answers "covered" would look like a
 * pass.
 *
 * Scope, stated plainly: this is the DSH client WINDOW. It does not cover the OS
 * screen — the Windows taskbar and the desktop stay visible.
 *
 * Usage: node scripts/verify-letterbox.mjs [--port 3080] [--width 2560] [--height 1400]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const num = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? fallback : Number(process.argv[i + 1])
}

const PORT = num('--port', 3080)
const WIDTH = num('--width', 2560)
const HEIGHT = num('--height', 1400)
const DEBUG_PORT = 9400 + (process.pid % 150)
const OVERLAY_URL = `http://127.0.0.1:${PORT}/dsh-boot-animation/boot.mp4`

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]
const browser = BROWSERS.find((p) => existsSync(p))
if (browser === undefined) {
  console.error('verify-letterbox: no Edge/Chrome found in the usual locations')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- page under test: the plugin's real CSS, the plugin's real video route ---
const page = `<!doctype html><meta charset="utf-8"><title>letterbox probe</title>
<style>
  html,body{margin:0;padding:0;overflow:hidden;background:#f0f}
  .dba-root{position:fixed;inset:0;z-index:2147483000;background:#000;
    pointer-events:auto;cursor:pointer;overflow:hidden}
  .dba-video{position:absolute;inset:0;width:100%;height:100%;
    object-fit:contain;background:#000;display:block}
  .dba-video.dba-cover{object-fit:cover;object-position:center}
</style>
<div class="dba-root"><video class="dba-video" id="v" src="${OVERLAY_URL}"
  muted autoplay playsinline preload="auto"></video></div>`

const dir = mkdtempSync(join(tmpdir(), 'dba-probe-'))
const pagePath = join(dir, 'probe.html')
writeFileSync(pagePath, page, 'utf8')
const pageUrl = 'file:///' + pagePath.replace(/\\/g, '/')

/**
 * The same overlay, wrapped in an ancestor that CREATES A CONTAINING BLOCK for
 * it. `transform: translateZ(0)` is the canonical case — a "just make it
 * composite" one-liner that silently demotes every `position:fixed` descendant to
 * positioning inside the wrapper. This is the negative control for the coverage
 * probe: if the probe cannot see this one, it cannot see the real thing either.
 */
const wrappedPath = join(dir, 'probe-wrapped.html')
writeFileSync(
  wrappedPath,
  `<!doctype html><meta charset="utf-8"><title>wrapped probe</title>
<style>
  html,body{margin:0;padding:0;overflow:hidden;background:#f0f}
  /* The offender. Also given a size so the difference is visible: the overlay
     now resolves against THIS box, not against the viewport. */
  #wrapper{transform:translateZ(0);width:420px;height:260px;position:relative;overflow:hidden}
  .dba-root{position:fixed;inset:0;z-index:2147483000;background:#000;
    pointer-events:auto;cursor:pointer;overflow:hidden}
  .dba-video{position:absolute;inset:0;width:100%;height:100%;
    object-fit:contain;background:#000;display:block}
</style>
<div id="wrapper"><div class="dba-root"><video class="dba-video" muted playsinline></video></div></div>`,
  'utf8',
)
const wrappedUrl = 'file:///' + wrappedPath.replace(/\\/g, '/')

const child = spawn(
  browser,
  [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${join(dir, 'profile')}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

let socket
const handlers = new Map()
let nextId = 0

/** One CDP call over the page target's websocket. */
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = (nextId += 1)
    handlers.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (handlers.has(id)) {
        handlers.delete(id)
        reject(new Error(`timeout: ${method}`))
      }
    }, 20000)
  })

async function findTarget() {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
      const target = list.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
      if (target !== undefined) return target.webSocketDebuggerUrl
    } catch {
      /* still starting */
    }
    await sleep(400)
  }
  throw new Error('no debug target appeared')
}

async function openSocket(url) {
  const ws = new WebSocket(url)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = (e) => reject(new Error('ws error ' + String(e?.message ?? e)))
  })
  ws.onmessage = (event) => {
    let m
    try {
      m = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (m.id === undefined) return
    const h = handlers.get(m.id)
    if (h === undefined) return
    handlers.delete(m.id)
    if (m.error !== undefined) h.reject(new Error(JSON.stringify(m.error)))
    else h.resolve(m.result)
  }
  return ws
}

async function evaluate(expression) {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r?.exceptionDetails !== undefined) {
    throw new Error('page threw: ' + JSON.stringify(r.exceptionDetails).slice(0, 240))
  }
  return r?.result?.value
}

const MEASURE = (mode) => `(() => {
  const v = document.getElementById('v');
  v.pause();
  v.className = 'dba-video' + (${JSON.stringify(mode)} === 'cover' ? ' dba-cover' : '');
  const r = v.getBoundingClientRect();
  const vw = v.videoWidth, vh = v.videoHeight;
  const fit = getComputedStyle(v).objectFit;
  const scale = fit === 'cover'
    ? Math.max(r.width / vw, r.height / vh)
    : Math.min(r.width / vw, r.height / vh);
  const drawnW = vw * scale, drawnH = vh * scale;
  // Black bars exist only when the drawn image is SMALLER than the element.
  // When it is larger (cover), the excess is cropped instead — that is padding,
  // not letterboxing, and reporting it as a bar is how a correct result got
  // read as a failure once.
  const barX = Math.max(0, Math.round((r.width - drawnW) / 2));
  const barY = Math.max(0, Math.round((r.height - drawnH) / 2));
  const cropX = Math.max(0, Math.round((drawnW - r.width) / 2));
  const cropY = Math.max(0, Math.round((drawnH - r.height) / 2));
  return JSON.stringify({
    mode: ${JSON.stringify(mode)},
    objectFit: fit,
    viewport: [window.innerWidth, window.innerHeight],
    elementBox: [Math.round(r.width), Math.round(r.height)],
    drawnImage: [Math.round(drawnW), Math.round(drawnH)],
    barX, barY, cropX, cropY,
    clip: [vw, vh],
    readyState: v.readyState,
    error: v.error ? v.error.code : null,
  });
})()`

/**
 * Overlay coverage, measured in the layout engine.
 *
 * `position:fixed;inset:0` only covers the viewport when no ancestor creates a
 * containing block for it. `transform`, `filter`, `perspective`, `contain` and
 * `will-change` all demote a fixed element to positioning inside that ancestor,
 * and the symptom is the overlay covering one panel instead of the window — the
 * bug the wrapper below reproduces on purpose. `elementFromPoint` at the four
 * corners and the centre then checks that the overlay is genuinely on TOP there,
 * not merely the right size.
 */
const COVERAGE = (label) => `(() => {
  const root = document.querySelector('.dba-root');
  if (!root) return JSON.stringify({ label: ${JSON.stringify(label)}, ok: false, reasons: ['no .dba-root in the document'], detail: {} });
  const rect = root.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const style = getComputedStyle(root);
  const reasons = [];
  const detail = {
    position: style.position,
    zIndex: style.zIndex,
    viewport: [vw, vh],
    rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
    scroll: [window.scrollX, window.scrollY],
  };
  if (style.position !== 'fixed') reasons.push('position is ' + style.position + ', not fixed');
  if (rect.width < vw - 1 || rect.height < vh - 1) {
    reasons.push('the box ' + Math.round(rect.width) + 'x' + Math.round(rect.height) + ' does not fill the viewport ' + vw + 'x' + vh);
  }
  if (Math.abs(rect.left) > 1 || Math.abs(rect.top) > 1) {
    reasons.push('the box is offset from the viewport origin by (' + Math.round(rect.left) + ',' + Math.round(rect.top) + ')');
  }
  // The containing-block walk: an empty list means fixed really resolves against
  // the viewport, which is the property the whole rule rests on.
  //
  // Each property is compared against ITS OWN neutral value, not against the word
  // "none". "transform-style" reports "flat" by default and "will-change" reports
  // "auto"; treating those as offenders would flag every page ever rendered and
  // make the probe useless. (Learned the hard way: the first version failed its
  // own bare case because of "transform-style: flat".)
  const NEUTRAL = {
    transform: 'none', transformStyle: 'flat', translate: 'none', rotate: 'none', scale: 'none',
    filter: 'none', backdropFilter: 'none', perspective: 'none',
    contain: 'none', containerType: 'normal', willChange: 'auto',
  };
  const blockers = [];
  for (let el = root.parentElement; el !== null; el = el.parentElement) {
    const cs = getComputedStyle(el);
    const bad = [];
    for (const [prop, neutral] of Object.entries(NEUTRAL)) {
      const value = cs[prop];
      if (typeof value === 'string' && value !== '' && value !== neutral) bad.push(prop + ': ' + value);
    }
    if (bad.length > 0) blockers.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 40), offending: bad });
  }
  detail.blockers = blockers;
  if (blockers.length > 0) reasons.push('an ancestor creates a containing block: ' + JSON.stringify(blockers[0]));

  const points = [[2, 2], [vw - 3, 2], [2, vh - 3], [vw - 3, vh - 3], [Math.round(vw / 2), Math.round(vh / 2)]];
  const hits = points.map((point) => {
    const hit = document.elementFromPoint(point[0], point[1]);
    return {
      at: point,
      tag: hit ? hit.tagName.toLowerCase() : null,
      inOverlay: hit !== null && (hit === root || root.contains(hit)),
      outside: hit !== null && !(hit === root || root.contains(hit)) ? String(hit.className || hit.tagName).slice(0, 30) : null,
    };
  });
  detail.hits = hits;
  const missed = hits.filter((hit) => !hit.inOverlay);
  if (missed.length > 0) reasons.push(missed.length + ' of ' + hits.length + ' sample points are not covered: ' + JSON.stringify(missed));

  return JSON.stringify({ label: ${JSON.stringify(label)}, ok: reasons.length === 0, reasons, detail });
})()`

/** Print one coverage measurement in the same shape as the letterbox table. */
function reportCoverage(raw) {
  const probe = JSON.parse(raw)
  const d = probe.detail ?? {}
  console.log(
    `  coverage[${probe.label}]`.padEnd(34) +
      `pos=${String(d.position)} z=${String(d.zIndex)} viewport=${JSON.stringify(d.viewport)} box=${JSON.stringify(d.rect)} ` +
      `ancestors=${d.blockers === undefined ? '?' : d.blockers.length === 0 ? 'none' : JSON.stringify(d.blockers)}`,
  )
  console.log(
    `  hit[${probe.label}]`.padEnd(34) +
      (d.hits ?? []).map((h) => `${h.at.join(',')}→${h.inOverlay ? 'overlay' : 'OUTSIDE:' + String(h.outside)}`).join('  '),
  )
  return probe
}

try {
  socket = await openSocket(await findTarget())
  await call('Page.enable')
  await call('Runtime.enable')
  await call('Page.navigate', { url: pageUrl })

  const deadline = Date.now() + 30000
  let ready = false
  while (Date.now() < deadline) {
    const raw = await evaluate(MEASURE('cover'))
    const s = JSON.parse(raw)
    if (s.readyState >= 2 && s.clip[0] > 0) {
      console.log(`clip loaded: readyState=${s.readyState} clip=${s.clip.join('x')} video error=${s.error}`)
      ready = true
      break
    }
    await sleep(400)
  }
  if (!ready) console.log('WARNING: clip never reached readyState>=2 — measuring layout anyway')

  const cover = JSON.parse(await evaluate(MEASURE('cover')))
  const contain = JSON.parse(await evaluate(MEASURE('contain')))
  const bareCoverage = reportCoverage(await evaluate(COVERAGE('bare')))

  // The negative control: the same overlay inside a transformed ancestor. The
  // probe MUST see this one, otherwise "bare covered" proves nothing.
  await call('Page.navigate', { url: wrappedUrl })
  await sleep(600)
  const wrappedCoverage = reportCoverage(await evaluate(COVERAGE('wrapped-in-transform')))
  const wrappedBlamed = (wrappedCoverage.detail?.blockers ?? []).some((b) =>
    (b.offending ?? []).some((offence) => String(offence).startsWith('transform')),
  )

  const fmt = (m) =>
    `  ${m.mode.padEnd(8)} object-fit=${m.objectFit.padEnd(8)} viewport=${m.viewport.join('x')} ` +
    `clip=${m.clip.join('x')} element=${m.elementBox.join('x')} drawn=${m.drawnImage.join('x')} ` +
    `→ black bar ${m.barX}px L/R, ${m.barY}px T/B` +
    (m.cropX > 0 || m.cropY > 0 ? ` (crops ${m.cropX}px L/R, ${m.cropY}px T/B)` : '')

  console.log('\nmeasured in the browser layout engine:')
  console.log(fmt(cover))
  console.log(fmt(contain))

  const failures = []
  if (cover.objectFit !== 'cover') failures.push(`fill mode resolved to object-fit:${cover.objectFit}`)
  if (cover.barX !== 0 || cover.barY !== 0) {
    failures.push(`fill mode still leaves ${cover.barX}px L/R and ${cover.barY}px T/B of black`)
  }
  if (cover.elementBox[0] !== cover.viewport[0] || cover.elementBox[1] !== cover.viewport[1]) {
    failures.push(`video element ${cover.elementBox.join('x')} does not fill viewport ${cover.viewport.join('x')}`)
  }
  if (contain.barX === 0 && contain.barY === 0) {
    failures.push('NOTE: at this viewport the two fit modes render identically — choose a size where they differ')
  }

  // Coverage: the overlay must cover the client window, and the probe must be
  // able to prove the opposite case too. Both halves are required — a probe that
  // always says "covered" would pass the first and fail the second.
  if (bareCoverage.ok !== true) {
    failures.push(`the overlay does not cover the window: ${bareCoverage.reasons.join('; ')}`)
  }
  if (wrappedCoverage.ok !== false) {
    failures.push(
      'the negative control did NOT fail as it must: an ancestor with transform:translateZ(0) left the overlay ' +
        'looking fully covering, so this probe cannot detect a containing-block ancestor at all',
    )
  } else if (!wrappedBlamed) {
    failures.push('the negative control failed, but not because of the transform on the ancestor — the probe is blaming the wrong thing')
  }

  console.log('')
  if (failures.length === 0) {
    console.log('PASS: fill mode covers the whole viewport with no black bars')
    console.log(`      (whole-frame mode would leave ${contain.barX}px L/R, ${contain.barY}px T/B at this size)`)
    console.log('PASS: the overlay box equals the viewport, no ancestor creates a containing block,')
    console.log('      and all 5 sample points hit-test inside it')
    console.log('      (negative control detected: a transform ancestor DOES break it)')
    console.log('      scope: the DSH client WINDOW — not the OS screen (taskbar/desktop stay visible)')
  } else {
    console.log('FAIL:')
    for (const f of failures) console.log('  - ' + f)
    process.exitCode = 1
  }
} catch (error) {
  console.error('verify-letterbox failed:', String(error?.message ?? error))
  process.exitCode = 2
} finally {
  try {
    socket?.close()
  } catch {
    /* already closed */
  }
  child.kill()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* leave the temp dir if it is locked */
  }
}
