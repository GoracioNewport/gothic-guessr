// Print the rounds a seed produces: npx vite-node tools/debug_rounds.ts <seed> [mode] [worlds,comma]
import { readFileSync } from 'node:fs';
import { pickRounds, resolveSettings } from '../src/game/state';
import type { Manifest } from '../src/contracts';

const seed = Number(process.argv[2]);
const mode = (process.argv[3] ?? 'mixed') as 'classic' | 'mixed' | 'hardcore';
const slugs = (process.argv[4] ?? 'khorinis,valley,jharkendar').split(',');
const worlds = new Map(slugs.map((s) => [s, { manifest: JSON.parse(readFileSync(`public/data/${s}/manifest.json`, 'utf8')) as Manifest }]));
const settings = resolveSettings({ seed, mode, worlds: slugs }, slugs);
const rounds = pickRounds(worlds, settings);
for (const [i, r] of rounds.entries()) {
  const n = worlds.get(r.world)!.manifest.nodes[r.nodeId]!;
  console.log(`round ${i + 1}: ${r.world} #${r.nodeId} ${n.wp} outdoor=${n.outdoor} links=${n.links.length} y=${n.y}`);
}
