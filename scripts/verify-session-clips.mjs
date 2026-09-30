/**
 * verify-session-clips.mjs — session-scoped pins remember independent ClipIds.
 *
 * Runs the shipped client bundle. The storage helpers are exported by the real
 * module, and resolveClipId() uses the same /resolve.json boundary as playback.
 */
import { builtinClips, loadClientBundle, makeFetchStub } from './lib/client-bundle.mjs'
import { createReport } from './lib/harness.mjs'

const report = createReport('session-clips')
const bundle = loadClientBundle()
const LEGACY = 'dsh-boot-animation:pinned'
const MAP = 'dsh-boot-animation:session-clips'

report.check(typeof bundle.readPinnedClip === 'function', 'the bundle exports readPinnedClip')
report.check(typeof bundle.readPinnedSession === 'function', 'the bundle exports readPinnedSession')
report.check(typeof bundle.writePinnedClip === 'function', 'the bundle exports writePinnedClip')

console.log('\nindependent session -> clip bindings:')
window.localStorage.setItem(LEGACY, 'legacy-session')
bundle.writePinnedClip('session-a', 'builtin:brand')
bundle.writePinnedClip('session-b', 'builtin:startup')

report.check(bundle.readPinnedClip('session-a') === 'builtin:brand', 'session A remembers clip A')
report.check(bundle.readPinnedClip('session-b') === 'builtin:startup', 'session B remembers clip B')
report.check(
  bundle.readPinnedSession('session-a')?.source === 'session-map',
  'new pins resolve from the session map',
)
report.check(
  bundle.readPinnedSession('legacy-session')?.source === 'legacy',
  'the <=0.3.0 bare-string pin still resolves',
)
report.check(
  window.localStorage.getItem(LEGACY) === 'legacy-session',
  'writing new pins does not rewrite the legacy PIN_KEY',
)

console.log('\nunpinning one session leaves the others alone:')
bundle.writePinnedClip('session-a', null)
report.check(bundle.readPinnedClip('session-a') === null, 'session A can be removed')
report.check(bundle.readPinnedClip('session-b') === 'builtin:startup', 'session B remains pinned')
report.check(bundle.readPinnedSession('legacy-session')?.source === 'legacy', 'the legacy pin remains intact')

console.log('\ndamaged / mixed storage is contained:')
window.localStorage.setItem(MAP, '{not json')
report.check(bundle.readPinnedClip('session-b') === null, 'damaged JSON degrades to no mapped pins')
report.check(bundle.readPinnedSession('legacy-session')?.source === 'legacy', 'damaged new storage cannot hide the legacy pin')

window.localStorage.setItem(MAP, JSON.stringify({
  good: 'builtin:awakening',
  number: 42,
  empty: '',
}))
report.check(bundle.readPinnedClip('good') === 'builtin:awakening', 'valid map entries survive')
report.check(bundle.readPinnedClip('number') === null, 'non-string map values are ignored')
report.check(bundle.readPinnedClip('empty') === null, 'empty ClipIds are ignored')

console.log('\nresolving a clip to snapshot on pin:')
{
  const { fetchStub } = makeFetchStub({
    clips: builtinClips(),
    selectedClipId: null,
    resolvedClipId: 'builtin:awakening',
  })
  globalThis.fetch = fetchStub
  const store = new bundle.ClientStore()
  await store.loadCatalog()
  report.check(
    await store.resolveClipId('active') === 'builtin:awakening',
    'a fresh install can resolve the active clip without playing it',
  )
}

report.finish()
