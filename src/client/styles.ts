/**
 * The stylesheet, injected once.
 *
 * Kept in its own module so `scripts/check-css-template.mjs` has one obvious
 * place to guard: the sheet is a template literal, and a stray backtick inside
 * it ends the literal and breaks the build in a way that leaves the previous
 * bundle in place — which once shipped silently.
 *
 * The layout note is load-bearing: the two fit modes differ ONLY by `object-fit`.
 * An earlier "improvement" that also rewrote the layout mechanics took the overlay
 * fully black in the real app, so it was reverted and is not to be retried.
 */
export const STYLE_ID = 'dsh-boot-animation-style'

export const CSS = `
/* ---------------------------------------------------------------------------
   0.4.3: a reset that scopes to OUR subtree and nothing else.

   The official desktop client ships a GLOBAL button style (fixed height,
   padding, background, font, sometimes a border), and our controls inherited it.
   That is why the same markup looked right in a browser and wrong in the app
   (issue #6): the buttons were not ours, they were the host's with our colours
   painted on.

   :where() keeps this reset at ELEMENT specificity (it contributes 0), so every
   class rule below still wins over it. Never raise its specificity: the day it
   starts beating .dba-skip / .dba-pin, the overlay loses its only exit.
   --------------------------------------------------------------------------- */
:where(.dba-root,.dba-veil,.dba-lib,.dba-pin-wrap),:where(.dba-root,.dba-veil,.dba-lib,.dba-pin-wrap) *{box-sizing:border-box}
:where(.dba-root,.dba-veil,.dba-lib,.dba-pin-wrap) button{appearance:none;-webkit-appearance:none;
  margin:0;border:0;background:transparent;color:inherit;font:inherit;letter-spacing:normal;
  text-transform:none;text-align:center;min-width:0;min-height:0;height:auto;line-height:1.4;
  cursor:pointer;white-space:nowrap}
.dba-root{position:fixed;inset:0;z-index:2147483000;background:#000;
  display:flex;align-items:center;justify-content:center;
  pointer-events:auto;cursor:pointer;overflow:hidden;
  transition:background-color .46s ease}
.dba-video{width:100%;height:100%;object-fit:contain;background:#000;display:block;
  transform-origin:center;animation:dba-focus-in .34s ease;
  transition:opacity .46s ease,filter .46s ease,transform .46s ease}
/* The ONLY difference between the fit modes is object-fit.
   Do not "harden" this with position/inset changes: the bar fix does not need
   them, and an overlay that rendered correctly under flex + percentage sizing
   went fully black in the real app the one time the layout mechanics were
   rewritten for no reason. Minimal change, or you trade a cosmetic defect for
   a functional one.
   NOTE: never put a backtick in this block — the whole sheet is a template
   literal, and one backtick ends it. scripts/check-css-template.mjs enforces it. */
.dba-video.dba-cover{object-fit:cover;object-position:center}
/* ---------------------------------------------------------------------------
   0.4.4: the hand-off. The animation used to CUT: store.stop() unmounted this
   layer in the same frame, so the app appeared behind a hard edge.

   Now the clip defocuses and fades while a backdrop blur on the layer decays
   from 18px to none. Because the blur is BEHIND the video, the app resolves out
   of softness instead of popping in: at the first frame the video is still
   opaque and hides the blur, and by the time the video is transparent the blur
   is already clearing. One transition, no second layer, no overlay left behind.

   The timing here must stay SHORTER than HANDOFF_MS (ui.ts); a transition cut
   halfway looks worse than no transition at all. verify-handoff.mjs asserts it.
   --------------------------------------------------------------------------- */
@keyframes dba-focus-in{from{opacity:0;filter:blur(14px);transform:scale(1.04)}
  to{opacity:1;filter:blur(0);transform:scale(1)}}
@keyframes dba-defocus{from{backdrop-filter:blur(18px) saturate(1.06);-webkit-backdrop-filter:blur(18px) saturate(1.06)}
  to{backdrop-filter:blur(0px) saturate(1);-webkit-backdrop-filter:blur(0px) saturate(1)}}
.dba-root.dba-leaving{background-color:transparent;pointer-events:none;
  animation:dba-defocus .46s ease forwards}
.dba-root.dba-leaving .dba-video{opacity:0;filter:blur(16px);transform:scale(1.02)}
/* Chrome IS faded, not merely hidden: the hint runs an infinite opacity
   animation, which would otherwise keep winning over the declaration below. */
.dba-root.dba-leaving .dba-skip,.dba-root.dba-leaving .dba-hint,
.dba-root.dba-leaving .dba-what,.dba-root.dba-leaving .dba-status{opacity:0;animation:none}
@media (prefers-reduced-motion:reduce){
  .dba-video{animation:none}
  .dba-root{transition:none}
  .dba-root.dba-leaving{animation:none}
  .dba-root.dba-leaving .dba-video{transition:none}
}
/* 0.4.3 (issue #5): the top strip of the window belongs to the OS caption
   buttons on the desktop client, and a native window control always wins the
   hit test — no z-index can reach it. So the button keeps its right edge but
   drops BELOW that strip, using the Window Controls Overlay geometry the
   browser publishes. Without WCO the env() resolves to 0px and nothing moves;
   the plain declaration first keeps older engines at the old position. */
.dba-skip{position:absolute;top:20px;right:22px;z-index:2;
  top:calc(env(titlebar-area-height,0px) + 14px);
  border:1px solid rgba(255,255,255,.42);background:rgba(0,0,0,.42);
  color:#fff;border-radius:999px;padding:6px 16px;font-size:13px;line-height:1.4;
  font-family:inherit;cursor:pointer;opacity:.92;transition:opacity .15s ease,background-color .15s ease}
.dba-skip:hover,.dba-skip:focus-visible{opacity:1;background:rgba(0,0,0,.7)}
.dba-skip:focus-visible{outline:2px solid rgba(255,255,255,.8);outline-offset:2px}
.dba-hint{position:absolute;bottom:30px;left:50%;transform:translateX(-50%);
  z-index:2;color:rgba(255,255,255,.82);font-size:13px;letter-spacing:.06em;
  font-family:inherit;text-shadow:0 1px 8px rgba(0,0,0,.9);
  animation:dba-breathe 2.4s ease-in-out infinite;white-space:nowrap}
@keyframes dba-breathe{0%,100%{opacity:.55}50%{opacity:1}}
.dba-status{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  z-index:2;color:rgba(255,255,255,.88);font-size:14px;letter-spacing:.04em;
  font-family:inherit;text-align:center;max-width:78vw;
  background:rgba(0,0,0,.46);border-radius:10px;padding:10px 18px;
  text-shadow:0 1px 10px rgba(0,0,0,.9)}
.dba-what{position:absolute;top:20px;left:22px;z-index:2;
  top:calc(env(titlebar-area-height,0px) + 16px);
  color:rgba(255,255,255,.72);font-size:12px;letter-spacing:.04em;
  font-family:inherit;text-shadow:0 1px 8px rgba(0,0,0,.9)}
/* 0.4.3 (issue #1): the sidebar footer is ONE flex row shared with other
   plugins, and a neighbour that renders a full-width panel used to squeeze this
   cell until the 🎛 button could not be hit. Never shrink, and paint above. */
.dba-pin-wrap{display:inline-flex;align-items:center;gap:2px;flex:0 0 auto;
  position:relative;z-index:2;min-width:0}
.dba-pin{display:inline-flex;align-items:center;justify-content:center;
  width:28px;height:28px;padding:0;border:0;border-radius:8px;cursor:pointer;
  background:transparent;color:var(--dsw-alias-label-secondary,#6b7075);
  font-size:14px;line-height:1;font-family:inherit}
.dba-pin:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));
  color:var(--dsw-alias-label-primary,#191919)}
.dba-pin:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#408cff);outline-offset:1px}
/* ---------------------------------------------------------------------------
   0.4.5: the library panel follows the kernel, instead of carrying its own
   palette.

   Everything below used to be built from two hardcoded colours — a neutral grey
   rgba(127,127,127,…) for every surface and hairline, and the messenger green
   #07c160 for selection. The grey reads acceptably in both themes, which is
   exactly why the defect was easy to miss: the panel never stopped FOLLOWING the
   theme, it simply never LOOKED like the kernel. Green is a second accent colour
   the host does not have, so the selected row and the "on" buttons competed with
   the interface instead of reading as "this is the current item".

   Every value now comes from the kernel's own tokens, and where the kernel has no
   token for a job the fallback is that job's neutral (not a hue):

     surface      --dsw-specific-menu         the same fill a native menu uses
     blur         --dsw-menu-backdrop-filter  the same 40px/saturate the menu uses
     ink          --dsw-alias-label-primary / -secondary / -tertiary
     hairlines    --dsw-alias-border-l2 / -l3
     hover        --dsw-alias-interactive-bg-hover
     selected     --dsw-alias-brand-primary    the kernel's "current" accent
     accent wash  the same brand colour at low alpha, via color-mix

   color-mix is used instead of a second hardcoded alpha colour so the wash is
   derived from whatever the token resolves to in the active theme. Browsers
   without it fall back to the token declared before it in the same declaration.

   Keep this block free of backticks: the sheet is a template literal.
   --------------------------------------------------------------------------- */
.dba-pin.dba-pin-on{color:var(--dsw-alias-brand-primary,#2f6fd0);
  background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2f6fd0) 14%,transparent)}
.dba-veil{position:fixed;inset:0;z-index:2147483200;
  background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.46));
  display:flex;align-items:center;justify-content:center;padding:24px}
.dba-lib{width:min(620px,100%);max-height:min(78vh,660px);overflow:auto;
  background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay,#fff));
  -webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,none);
  backdrop-filter:var(--dsw-menu-backdrop-filter,none);
  color:var(--dsw-alias-label-primary,#191919);
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));
  border-radius:14px;padding:18px 18px 14px;
  box-shadow:var(--dsw-elevation-prominent,0 18px 60px rgba(0,0,0,.24));font-family:inherit;
  font-size:13px;line-height:1.55}
.dba-lib h3{margin:0 0 4px;font-size:15px;font-weight:600;
  color:var(--dsw-alias-label-primary,#191919)}
.dba-lib p{margin:0 0 12px;color:var(--dsw-alias-label-secondary,#777);font-size:12.5px}
.dba-item{display:flex;align-items:center;gap:8px;padding:9px 10px;border-radius:9px;
  border:1px solid transparent}
.dba-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.10))}
/* The current clip is marked by the kernel's accent, not a hue of our own. */
.dba-item.dba-cur{border-color:var(--dsw-alias-border-selected,var(--dsw-alias-brand-primary,#2f6fd0));
  background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2f6fd0) 10%,transparent)}
/* The per-conversation pin is a DIFFERENT question from the global selection, so
   it keeps a distinct treatment: the same accent, drawn as a dashed hairline
   rather than a second colour. */
.dba-item.dba-ses-cur{border-color:var(--dsw-alias-brand-primary,#2f6fd0);
  border-style:dashed;
  background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2f6fd0) 6%,transparent)}
.dba-item .dba-nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dba-badge{font-size:11px;padding:1px 7px;border-radius:999px;
  background:var(--dsw-alias-bg-skeleton,rgba(127,127,127,.14));
  color:var(--dsw-alias-label-secondary,#777);white-space:nowrap}
.dba-badge.dba-b-sel{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2f6fd0) 16%,transparent);
  color:var(--dsw-alias-brand-primary,#2f6fd0)}
.dba-badge.dba-b-ses{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2f6fd0) 12%,transparent);
  color:var(--dsw-alias-brand-primary,#2f6fd0)}
.dba-badge.dba-b-prev{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2f6fd0) 12%,transparent);
  color:var(--dsw-alias-brand-primary,#2f6fd0)}
/* A warning is the one place a hue is the information, so it keeps the kernel's
   own warning token rather than the neutral used everywhere else. */
.dba-badge.dba-b-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d2762b) 18%,transparent);
  color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary,#b46214));cursor:help}
.dba-meta{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap}
.dba-mark{width:14px;text-align:center;color:var(--dsw-alias-brand-primary,#2f6fd0);
  font-weight:700;font-size:12px}
.dba-row-btn{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));
  background:transparent;color:inherit;
  border-radius:7px;padding:3px 10px;font-size:12px;font-family:inherit;cursor:pointer;white-space:nowrap}
.dba-row-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dba-row-btn.dba-go{border-color:var(--dsw-alias-brand-primary,#2f6fd0);
  color:var(--dsw-alias-brand-primary,#2f6fd0);font-weight:600}
.dba-dir{margin:12px 0 0;padding:9px 10px;border-radius:9px;
  background:var(--dsw-alias-bg-skeleton,rgba(127,127,127,.10));
  font-size:11.5px;color:var(--dsw-alias-label-secondary,#777);word-break:break-all}
.dba-dir code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;
  color:var(--dsw-alias-label-primary,#333)}
.dba-ses{display:flex;align-items:center;gap:8px;margin:0 0 10px;padding:8px 10px;
  border-radius:9px;background:var(--dsw-alias-bg-skeleton,rgba(127,127,127,.08));
  border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.16));
  font-size:12px;color:var(--dsw-alias-label-secondary,#777)}
.dba-ses .dba-row-btn{margin-left:auto}
.dba-bar{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;
  padding-top:12px;border-top:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.16))}
.dba-fit{display:flex;align-items:center;gap:8px;margin-top:12px;
  font-size:12px;color:var(--dsw-alias-label-secondary,#777)}
.dba-fit .dba-flex{flex:1}
.dba-fit .dba-note{font-size:11px;opacity:.8}
.dba-btn.dba-btn-on{border-color:var(--dsw-alias-brand-primary,#2f6fd0);
  background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2f6fd0) 12%,transparent);
  color:var(--dsw-alias-brand-primary,#2f6fd0)}
.dba-btn{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));
  background:transparent;color:inherit;
  border-radius:8px;padding:5px 14px;font-size:12.5px;font-family:inherit;cursor:pointer}
.dba-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dba-btn[disabled]{opacity:.5;cursor:default}
.dba-msg{margin-top:10px;font-size:12px;min-height:16px;color:var(--dsw-alias-label-secondary,#777)}
.dba-msg.dba-err{color:var(--dsw-alias-state-error-primary,#c0392b)}
.dba-msg.dba-ok{color:var(--dsw-alias-brand-primary,#07974b)}
`

/** Inject the sheet once per document. */
export function ensureStyle(): void {
  try {
    if (document.getElementById(STYLE_ID) !== null) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    document.head.appendChild(style)
  } catch {
    /* no document (tests): styling is cosmetic, never fatal */
  }
}
