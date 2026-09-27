// Reference implementation of CrewAvatar as specified in crew.md (fixed ears, hats).
export function fnv1a(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
export function shapeBits(h) {
  return {
    wide: ((h >>> 4) & 1) === 1,
    ears: (h >>> 6) % 3,          // FIX: unsigned shift, always 0, 1 or 2
    belly: ((h >>> 9) & 1) === 1,
  };
}
export function legacyEars(h) { return (h >> 6) % 3; } // canvas behaviour, for comparison only
export function mix(hex, to, t) {
  const a = parseInt(hex.slice(1), 16), b = parseInt(to.slice(1), 16);
  const c = (s) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return '#' + ((1 << 24) + (c(16) << 16) + (c(8) << 8) + c(0)).toString(16).slice(1);
}
// Returns a 9x9 array of letters: B body, L light, D dark, I ink, H hat, A amber, G grey, R red, '.' empty.
export function paint(seed, pose, hat = 'none') {
  const { wide, ears, belly } = shapeBits(fnv1a(seed));
  const g = Array.from({ length: 9 }, () => Array(9).fill('.'));
  const set = (x, y, c) => { g[y][x] = c; };
  for (let x = 2; x <= 6; x++) set(x, 1, 'B');
  for (let y = 2; y <= 3; y++) for (let x = wide ? 1 : 2; x <= (wide ? 7 : 6); x++) set(x, y, 'B');
  for (let x = 2; x <= 6; x++) { set(x, 4, 'B'); set(x, 5, 'B'); }
  for (let x = 3; x <= 5; x++) set(x, 6, 'B');
  set(3, 7, 'D'); set(5, 7, 'D');
  if (belly) { set(4, 5, 'L'); set(4, 4, 'L'); }
  if (hat === 'cap') { for (let x = 2; x <= 6; x++) set(x, 0, 'H'); set(wide ? 1 : 2, 1, 'H'); set(wide ? 7 : 6, 1, 'H'); }
  else {
    if (ears === 1) set(4, 0, 'L');
    else if (ears === 2) { set(2, 0, 'B'); set(6, 0, 'B'); }
    if (hat === 'bandana') { for (let x = 2; x <= 6; x++) set(x, 1, 'H'); set(7, 1, 'H'); set(8, 2, 'H'); }
  }
  if (pose === 'idle') { set(3, 2, 'D'); set(5, 2, 'D'); set(8, 0, 'G'); set(7, 1, 'G'); }
  else if (pose === 'crashed') { set(3, 2, 'R'); set(5, 2, 'R'); }
  else { set(3, 2, 'I'); set(5, 2, 'I'); }
  if (pose === 'done') { set(3, 3, 'I'); set(4, 3, 'I'); set(5, 3, 'I'); } else set(4, 3, 'D');
  if (pose === 'running') { set(1, 5, 'B'); set(0, 5, 'D'); set(7, 5, 'B'); set(8, 5, 'D'); }
  else if (pose === 'needs') { set(1, 5, 'B'); set(7, 4, 'B'); set(8, 3, 'B'); set(8, 2, 'L'); set(8, 1, 'L'); set(0, 0, 'A'); set(0, 1, 'A'); }
  else if (pose === 'done') { set(1, 4, 'B'); set(0, 3, 'B'); set(0, 2, 'L'); set(7, 4, 'B'); set(8, 3, 'B'); set(8, 2, 'L'); }
  else if (pose === 'crashed') { set(1, 6, 'D'); set(7, 6, 'D'); }
  else { set(1, 5, 'B'); set(7, 5, 'B'); }
  return g;
}
const POSES = ['running', 'needs', 'idle', 'done', 'crashed', 'none'];
export function sheet(seed, hat = 'none') {
  const maps = POSES.map((p) => paint(seed, p, hat));
  const lines = [POSES.map((p) => p.padEnd(12)).join('').trimEnd()];
  for (let y = 0; y < 9; y++) lines.push(maps.map((m) => m[y].join('') + '   ').join('').trimEnd());
  return lines.join('\n');
}

if (process.argv[2] === 'report') {
  const names = ['rustot', 'vault-mcp', 'discord-audit', 'andreymudri.com', 'turbidassist', 'rustot-client', 'axios-like', 'fleetmates'];
  console.log('| seed | h (uint32) | hex | wide | ears (fixed) | ears (canvas) | belly | h % 9 |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const n of names) {
    const h = fnv1a(n); const b = shapeBits(h);
    console.log(`| \`${n}\` | ${h} | 0x${h.toString(16).padStart(8, '0')} | ${b.wide} | ${b.ears} | ${legacyEars(h)} | ${b.belly} | ${h % 9} |`);
  }
  console.log('\nrustot none\n' + sheet('rustot'));
  console.log('\nfleetmates none\n' + sheet('fleetmates'));
  console.log('\ndiscord-audit none\n' + sheet('discord-audit'));
  console.log('\nrustot cap\n' + sheet('rustot', 'cap'));
  console.log('\nfleetmates bandana\n' + sheet('fleetmates', 'bandana'));
  console.log('\nrustot bandana\n' + sheet('rustot', 'bandana'));
  for (const c of ['#ff9e64']) {
    console.log('teammates', [0.25, -0.12, 0.45, -0.24].map((t) => t > 0 ? mix(c, '#ffffff', t) : mix(c, '#000000', -t)));
  }
  const slots = ['#ff9e64', '#f7768e', '#7aa2f7', '#73daca', '#bb9af7', '#7dcfff', '#c3e88d', '#e0c98a', '#f5a3d7', '#c0caf5'];
  for (const s of slots) console.log(s, mix(s, '#ffffff', 0.35), mix(s, '#000000', 0.35));
  // test: ascii render row counts
  console.log('rects rustot running', paint('rustot', 'running').flat().filter((c) => c !== '.').length);
}
