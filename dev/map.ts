/**
 * Manual harness for src/ui/guessmap.ts: full-screen map with world tabs, click to place a guess,
 * buttons that show a same-world result (fake answer 300 m east of the guess), a wrong-world result
 * (answer on another tab) and a room-style result with other players' markers. Open /dev/map.html.
 *
 * Worlds: every world of public/data/worlds.json whose world.json loads (SPEC §10.3; no nodes needed).
 */
import L from 'leaflet';
import { loadPublicWorlds } from '../src/data/worlds';
import { GuessMap } from '../src/ui/guessmap';
import type { GuessMapWorld } from '../src/ui/guessmap';
import { gameToLatLng, gameToPixel } from '../src/ui/mapcoords';

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
};
const log = $('log');
const print = (s: string): void => {
  log.textContent = s;
  console.log(s);
};

async function loadWorlds(): Promise<GuessMapWorld[]> {
  const loaded = await loadPublicWorlds();
  for (const f of loaded.failed) console.warn(`world ${f.slug} unavailable: ${f.error}`);
  return [...loaded.worlds.values()].map((w) => ({ slug: w.info.slug, name: w.info.name, map: w.data.map }));
}

const params = new URLSearchParams(location.search);
const all = await loadWorlds();
const worlds = params.get('single') ? all.slice(0, 1) : all;
const container = $('map');
const gm = new GuessMap(worlds);
gm.init(container);
(window as unknown as { __map: GuessMap }).__map = gm;

// Sanity check: the pure latlng maths must agree with Leaflet's own unproject under CRS.Simple.
const first = worlds[0]!;
const probe = { x: -1385.1, z: 3172.4 }; // NW_CITY_HABOUR_SHIP_01
const pure = gameToLatLng(first.map, probe);
const px = gameToPixel(first.map, probe);
const viaLeaflet = L.CRS.Simple.pointToLatLng(L.point(px.px, px.py), first.map.maxZoom);
const agree = Math.abs(pure.lat - viaLeaflet.lat) < 1e-9 && Math.abs(pure.lng - viaLeaflet.lng) < 1e-9;
print(`worlds: ${worlds.map((w) => `${w.slug} (${w.map.width}x${w.map.height}, z${w.map.maxZoom})`).join(', ')}\n` +
  `latlng check vs L.CRS.Simple: ${agree ? 'OK' : 'MISMATCH'}\nClick the map to place a guess.`);

gm.onGuess((p) => {
  const w = worlds.find((x) => x.slug === p.world)!;
  const pix = gameToPixel(w.map, p);
  const ll = gameToLatLng(w.map, p);
  print(`guess on ${p.world}: x=${p.x.toFixed(1)} z=${p.z.toFixed(1)}\n` +
    `pixel ${pix.px.toFixed(1)}, ${pix.py.toFixed(1)}\nlatlng ${ll.lat.toFixed(3)}, ${ll.lng.toFixed(3)}`);
});
gm.onWorldChanged((slug) => console.log(`[map] world → ${slug}`));

$('result').onclick = () => {
  const guess = gm.getGuess();
  if (!guess) return print('Place a guess first.');
  const answer = { world: guess.world, x: guess.x + 30000, z: guess.z }; // 300 m east (game units are cm)
  gm.showResult(guess, answer);
  print(`result on ${guess.world}: guess (${guess.x.toFixed(0)}, ${guess.z.toFixed(0)}) answer (${answer.x.toFixed(0)}, ${answer.z.toFixed(0)}), 300 m`);
};
$('wrong').onclick = () => {
  const guess = gm.getGuess();
  if (!guess) return print('Place a guess first.');
  const other = worlds.find((w) => w.slug !== guess.world);
  if (!other) return print('Only one world: no wrong-world result possible.');
  const f = other.map.frame;
  const answer = { world: other.slug, x: (f.x0 + f.x1) / 2, z: (f.z0 + f.z1) / 2 };
  gm.showResult(guess, answer);
  print(`wrong-world result: guess on ${guess.world}, answer on ${other.slug} at the frame centre; active tab ${gm.getActiveWorld()}`);
};
$('others').onclick = () => {
  const guess = gm.getGuess();
  if (!guess) return print('Place a guess first.');
  const answer = { world: guess.world, x: guess.x + 30000, z: guess.z };
  gm.showResult(guess, answer, [
    { id: 'a', name: 'Diego', color: '#e0745a', guess: { world: guess.world, x: guess.x + 20000, z: guess.z + 15000 } },
    { id: 'b', name: 'Lester', color: '#7cc36e', guess: { world: guess.world, x: guess.x - 10000, z: guess.z - 20000 } },
    { id: 'c', name: 'Milten', color: '#9b7be0', guess: null },
  ]);
  print('result with three other players (one without a guess)');
};
$('clear').onclick = () => { gm.clearGuess(); print('cleared'); };
$('fit').onclick = () => gm.fitWorld();
$('size').onclick = () => {
  const small = container.classList.toggle('small');
  gm.setExpanded(!small);
  print(small ? 'collapsed (320x220)' : 'expanded (full screen)');
};
$('reinit').onclick = () => {
  gm.destroy();
  gm.init(container);
  print(`re-initialised; guess kept: ${JSON.stringify(gm.getGuess())}; active ${gm.getActiveWorld()}`);
};
