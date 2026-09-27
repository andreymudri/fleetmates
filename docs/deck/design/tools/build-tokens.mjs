// Generates tokens.css from tokens.json and writes the contrast table (contrast.md).
// Usage: node docs/deck/design/tools/build-tokens.mjs docs/deck/design
import fs from 'node:fs';
const D = process.argv[2];
const J = JSON.parse(fs.readFileSync(D + '/tokens.json', 'utf8'));

const tokens = []; // {path, type, value, desc}
function walk(node, path, inheritedType) {
  const type = node.$type || inheritedType;
  if (Object.prototype.hasOwnProperty.call(node, '$value')) {
    tokens.push({ path, type, value: node.$value, desc: node.$description });
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('$')) continue;
    if (v && typeof v === 'object') walk(v, [...path, k], type);
  }
}
walk(J, [], undefined);
const byPath = new Map(tokens.map((t) => [t.path.join('.'), t]));
const cssName = (p) => '--' + (Array.isArray(p) ? p.join('-') : p.replace(/\./g, '-'));

function resolveRaw(v) {
  if (typeof v === 'string') {
    const m = v.match(/^\{(.+)\}$/);
    if (m) { const t = byPath.get(m[1]); if (!t) throw new Error('bad ref ' + v); return resolveRaw(t.value); }
  }
  return v;
}
function css(v, type) {
  if (typeof v === 'string') {
    const m = v.match(/^\{(.+)\}$/);
    if (m) { if (!byPath.has(m[1])) throw new Error('bad ref ' + v); return `var(${cssName(m[1])})`; }
    return v;
  }
  if (Array.isArray(v) && type === 'fontFamily') return v.map((f) => (/\s/.test(f) ? `'${f}'` : f)).join(', ');
  if (Array.isArray(v) && type === 'cubicBezier') return `cubic-bezier(${v.join(', ')})`;
  if (type === 'shadow') {
    const one = (s) => `${s.inset ? 'inset ' : ''}${s.offsetX} ${s.offsetY} ${s.blur} ${s.spread} ${css(s.color)}`;
    return Array.isArray(v) ? v.map(one).join(', ') : one(v);
  }
  if (type === 'typography') {
    const lh = typeof v.lineHeight === 'number' ? v.lineHeight : css(v.lineHeight);
    return `${css(v.fontWeight)} ${css(v.fontSize)}/${lh} ${css(v.fontFamily)}`;
  }
  return String(v);
}

let out = [];
out.push('/* fleetmates deck design tokens. GENERATED from tokens.json by tools/build-tokens.mjs (design-system.md section 2.3). Do not edit by hand. */');
out.push('/* Single fixed dark theme (Decided). No light mode, no theme switching. */');
out.push('');
out.push('/* Fonts are self-hosted (08-security.md CSP: font-src self). The app imports the @font-face rules from the geist npm package; no CDN. */');
out.push('');
out.push(':root {');
out.push('  color-scheme: dark;');
let lastGroup = '';
for (const t of tokens) {
  const g = t.path[0];
  if (g !== lastGroup) { out.push(''); out.push(`  /* ${g} */`); lastGroup = g; }
  if (t.type === 'typography') {
    out.push(`  ${cssName(t.path)}: ${css(t.value, 'typography')};`);
    out.push(`  ${cssName(t.path)}-tracking: ${css(t.value.letterSpacing)};`);
  } else {
    out.push(`  ${cssName(t.path)}: ${css(t.value, t.type)};`);
  }
}
out.push('');
out.push('  /* composed motion shorthands */');
out.push('  --transition-hover: background-color var(--motion-duration-fast) var(--motion-easing-standard), color var(--motion-duration-fast) var(--motion-easing-standard), border-color var(--motion-duration-fast) var(--motion-easing-standard);');
out.push('  --transition-press: transform var(--motion-duration-fast) var(--motion-easing-standard);');
out.push('}');
out.push('');
out.push(`html { font-size: var(--font-size-base); }
body {
  margin: 0;
  background: var(--bg-canvas);
  color: var(--text-default);
  font: var(--type-body);
  -webkit-font-smoothing: antialiased;
}
a { color: var(--text-link); }
a:hover { color: var(--text-link-hover); }

/* Focus: one ring for everything interactive (Proposed). Never remove outlines without this replacement. */
:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
.focus-inset:focus-visible { outline-offset: calc(var(--focus-ring-width) * -1); }

/* Visually hidden but announced. Replaces the canvas "left: -9999px" labels. */
.sr-only {
  position: absolute !important;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.sr-only-focusable:focus,
.sr-only-focusable:focus-within {
  position: static !important;
  width: auto;
  height: auto;
  margin: 0;
  overflow: visible;
  clip: auto;
  white-space: normal;
}

/* Named motions (design-system.md section 9). */
@keyframes deck-breathe { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.35; transform: scale(0.75); } }
@keyframes deck-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(224, 175, 104, 0); } 50% { box-shadow: 0 0 0 5px rgba(224, 175, 104, 0.16); } }
@keyframes deck-rec-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
@keyframes deck-arrive { 0%, 100% { box-shadow: 0 0 0 3px rgba(230, 233, 247, 0.35), 0 0 16px 4px rgba(230, 233, 247, 0.25); } 50% { box-shadow: 0 0 0 7px rgba(230, 233, 247, 0.08), 0 0 26px 8px rgba(230, 233, 247, 0.12); } }
@keyframes deck-caret { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
@keyframes deck-shimmer { 0% { background-position: -400px 0; } 100% { background-position: 400px 0; } }
@keyframes deck-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes deck-rise-in { from { opacity: 0; transform: translateY(var(--motion-distance-dialog)) scale(0.98); } to { opacity: 1; transform: none; } }
@keyframes deck-drawer-in { from { transform: translateX(100%); } to { transform: none; } }
@keyframes deck-toast-in { from { opacity: 0; transform: translateX(var(--motion-distance-toast)); } to { opacity: 1; transform: none; } }

.motion-breathe { animation: deck-breathe var(--motion-duration-loop-ambient) var(--motion-easing-ambient) infinite; }
.motion-pulse { animation: deck-pulse var(--motion-duration-loop-ambient) var(--motion-easing-ambient) infinite; }
.motion-rec-pulse { animation: deck-rec-pulse var(--motion-duration-loop-alert) var(--motion-easing-ambient) infinite; }
.motion-arrive { animation: deck-arrive var(--motion-duration-loop-ambient) var(--motion-easing-ambient) infinite; }
.motion-caret { animation: deck-caret var(--motion-duration-loop-blink) steps(1, end) infinite; }
.motion-shimmer {
  background: linear-gradient(90deg, var(--bg-skeleton) 0, var(--bg-skeleton-highlight) 40%, var(--bg-skeleton) 80%);
  background-size: 800px 100%;
  animation: deck-shimmer var(--motion-duration-loop-alert) linear infinite;
}

/* Reduced motion: handled once, here. Loops stop in a static state that still carries the meaning
   (every animated signal also has a label or icon). Transforms are removed; short opacity fades stay. */
@media (prefers-reduced-motion: reduce) {
  :root {
    --motion-duration-fast: 0ms;
    --motion-duration-normal: 100ms;
    --motion-duration-moderate: 100ms;
    --motion-duration-slow: 100ms;
    --motion-distance-dialog: 0px;
    --motion-distance-toast: 0px;
    --motion-distance-press: 0px;
  }
  .motion-breathe,
  .motion-pulse,
  .motion-rec-pulse,
  .motion-caret,
  .motion-shimmer { animation: none; }
  .motion-pulse { box-shadow: 0 0 0 1px var(--color-amber-700); }
  .motion-arrive { animation: none; box-shadow: 0 0 0 3px rgba(230, 233, 247, 0.35); }
  .motion-shimmer { background: var(--bg-skeleton); }
  @keyframes deck-drawer-in { from { opacity: 0; } to { opacity: 1; } }
  *, *::before, *::after { scroll-behavior: auto !important; }
}
`);
fs.writeFileSync(D + '/tokens.css', out.join('\n'));

// ---------- contrast ----------
const lum = (h) => {
  const n = parseInt(h.slice(1), 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
    .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
};
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const R = (p) => { const v = resolveRaw(byPath.get(p).value); if (!/^#[0-9a-f]{6}$/i.test(v)) throw new Error(p + ' not hex ' + v); return v; };
// [fg token, bg token, usage, kind] kind: body (4.5), large (3), ui (3)
const pairs = JSON.parse(fs.readFileSync(new URL('./contrast-pairs.json', import.meta.url), 'utf8'));
const rows = ['| Foreground | Background | Values | Ratio | Need | Result | Used for |', '|---|---|---|---|---|---|---|'];
let fails = 0;
for (const [f, b, use, kind] of pairs) {
  const fv = R(f), bv = R(b); const r = ratio(fv, bv); const need = kind === 'body' ? 4.5 : 3;
  const ok = r >= need; if (!ok) fails++;
  rows.push(`| \`${f}\` | \`${b}\` | ${fv} on ${bv} | ${r.toFixed(2)}:1 | ${need}:1 ${kind} | ${ok ? 'Pass' : 'FAIL'} | ${use} |`);
}
fs.writeFileSync(D + '/contrast.md', '# Contrast table (generated by tools/build-tokens.mjs)\n\n' + rows.join('\n') + `\n\n${pairs.length} pairs, ${fails} failing.\n`);
console.log('tokens', tokens.length, 'pairs', pairs.length, 'fails', fails);
