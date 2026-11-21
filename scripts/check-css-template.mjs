/**
 * check-css-template.mjs — fail loudly if the CSS sheet is broken in the one way
 * that is easy to do and hard to read.
 *
 * The plugin's stylesheet lives in a template literal. A single backtick inside
 * its comments ends that literal early, and the damage does not look like a CSS
 * problem at the point of failure: the bundler reports a *TypeScript* parse
 * error ("Expected a semicolon...") pointing at a CSS line, and a stale
 * lib/client.js is left in place, so the change silently does not ship.
 *
 * That happened twice here, once reaching a commit. This check names the real
 * problem in one line, before the bundler gets a chance to mislead.
 *
 * Usage: node scripts/check-css-template.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/**
 * The sheet moved to its own module when the client half was split; this guard was
 * left pointing at index.ts, where there is no `const CSS` at all. It therefore
 * found nothing, scanned nothing and reported ok — a check that had silently
 * stopped guarding the exact failure it was written for. It reads the real file.
 */
const TARGET = join(HERE, '..', 'src', 'client', 'styles.ts')

const lines = readFileSync(TARGET, 'utf8').split(/\r?\n/)
let inside = false
const problems = []

lines.forEach((line, index) => {
  const at = index + 1
  if (!inside) {
    // `export const CSS` — the sheet is exported now, and the old pattern anchored
    // on `const CSS` alone never matched it. That was the second way this guard had
    // gone quiet without saying so: it also cleared `inside` at once, so the
    // "never closed" check below passed on an empty scan.
    if (/^\s*(?:export\s+)?const CSS = `/.test(line)) inside = true
    return
  }
  // A line that is only a backtick (plus whitespace) closes the sheet.
  if (/^\s*`\s*;?\s*$/.test(line)) {
    inside = false
    return
  }
  if (line.includes('`')) {
    problems.push(`${at}: ${line.trim()}`)
  }
})

if (inside) {
  console.error('check-css-template: the CSS template literal is never closed')
  process.exit(1)
}

if (problems.length > 0) {
  console.error('check-css-template: backtick inside the CSS template literal.')
  console.error('The sheet is a template literal, so a backtick in a comment ends it early')
  console.error('and the bundler will report a confusing parse error on a CSS line.')
  for (const p of problems) console.error('  ' + p)
  process.exit(1)
}

console.log('check-css-template: ok (no stray backticks in the CSS sheet)')
