/**
 * Load the world registry from disk (SPEC §10.3): order and names from `<DATA_DIR>/worlds.json`, the private manifests
 * from `<SERVER_DATA_DIR>/<slug>/manifest.json` (validated with the client's `validateManifest` plus the node keys).
 * A world whose private manifest is missing or invalid is skipped with a warning; without worlds.json the slugs are
 * discovered from SERVER_DATA_DIR in alphabetical order.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validateManifest } from '../src/data/manifest';
import { buildRegistry, buildWorld } from './core/worlds';
import type { ServerWorld, WorldRegistry } from './core/worlds';

export interface WorldLoadReport {
  worlds: WorldRegistry;
  skipped: { slug: string; error: string }[];
}

interface IndexEntry {
  slug: string;
  name: string;
}

function readIndex(dataDir: string, serverDataDir: string): IndexEntry[] {
  const indexPath = join(dataDir, 'worlds.json');
  if (existsSync(indexPath)) {
    const data = JSON.parse(readFileSync(indexPath, 'utf8')) as { worlds?: unknown };
    if (!Array.isArray(data.worlds)) throw new Error(`${indexPath}: "worlds" must be an array`);
    return data.worlds.map((w: unknown, i) => {
      const e = w as { slug?: unknown; name?: unknown };
      if (typeof e.slug !== 'string' || !/^[a-z0-9-]+$/.test(e.slug)) throw new Error(`${indexPath}: worlds[${i}].slug`);
      return { slug: e.slug, name: typeof e.name === 'string' ? e.name : e.slug };
    });
  }
  if (!existsSync(serverDataDir)) return [];
  return readdirSync(serverDataDir)
    .filter((d) => statSync(join(serverDataDir, d)).isDirectory() && existsSync(join(serverDataDir, d, 'manifest.json')))
    .sort()
    .map((slug) => ({ slug, name: slug }));
}

export function loadWorldRegistry(dataDir: string, serverDataDir: string): WorldLoadReport {
  const loaded: ServerWorld[] = [];
  const skipped: { slug: string; error: string }[] = [];
  for (const { slug, name } of readIndex(dataDir, serverDataDir)) {
    const path = join(serverDataDir, slug, 'manifest.json');
    try {
      if (!existsSync(path)) throw new Error(`${path} not found`);
      const manifest = validateManifest(JSON.parse(readFileSync(path, 'utf8')) as unknown, path);
      loaded.push(buildWorld(slug, name, manifest));
    } catch (err) {
      skipped.push({ slug, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { worlds: buildRegistry(loaded), skipped };
}
