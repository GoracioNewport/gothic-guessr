/**
 * Public world data (SPEC.md section 10.3): `<data base>/worlds.json` (entries with a `world` path) and each
 * world's `world.json` (`{world, name, map, scoring, pano}`, no nodes). The client never sees a manifest: nodes
 * come from the API one at a time, round starts and answers stay on the server.
 *
 * `loadPublicWorlds()` fetches the index, then every `world.json` in parallel, isolating failures per world: a
 * world whose file is missing or broken ends up in `failed` with a readable error and the others still load.
 */
import type {
  LoadedPublicWorld,
  PanoLayout,
  PublicWorld,
  PublicWorldFailure,
  PublicWorlds,
  WorldIndex,
  WorldIndexEntry,
} from '../contracts';
import { dataBase, dataUrl } from './manifest';

export type { LoadedPublicWorld, PublicWorld, PublicWorlds, WorldIndex, WorldIndexEntry } from '../contracts';

/** URL of the worlds index: `<dataBase>/worlds.json`. */
export function worldsIndexUrl(): string {
  return `${dataBase()}/worlds.json`;
}

/** URL of a world's `world.json` from its index entry. */
export function worldFileUrl(info: WorldIndexEntry): string {
  return dataUrl(info.world);
}

/** URL of a world's thumbnail from its index entry. */
export function worldThumbnailUrl(info: WorldIndexEntry): string {
  return dataUrl(info.thumbnail);
}

type Fetch = (url: string) => Promise<Response>;
const defaultFetch: Fetch = (url) => fetch(url);

async function fetchJson(url: string, what: string, fetchImpl: Fetch): Promise<unknown> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} for ${url}`);
  return res.json();
}

/** Fetch and validate `worlds.json`. Throws with a readable message; without the index nothing can be played. */
export async function loadWorldIndex(url = worldsIndexUrl(), fetchImpl: Fetch = defaultFetch): Promise<WorldIndex> {
  return validateWorldIndex(await fetchJson(url, 'worlds', fetchImpl), url);
}

/** Validate a parsed stage-3 `worlds.json`: non-empty list, the five strings per entry, unique slugs. Exported for tests. */
export function validateWorldIndex(data: unknown, source = 'worlds.json'): WorldIndex {
  const fail = (msg: string): never => {
    throw new Error(`${source}: ${msg}`);
  };
  if (!isRecord(data)) return fail('not an object');
  const worlds = data.worlds;
  if (!Array.isArray(worlds) || worlds.length === 0) return fail('"worlds" must be a non-empty array');
  const seen = new Set<string>();
  return {
    worlds: worlds.map((w: unknown, i): WorldIndexEntry => {
      if (!isRecord(w)) return fail(`worlds[${i}] is not an object`);
      for (const key of ['slug', 'name', 'world', 'thumbnail'] as const) {
        if (typeof w[key] !== 'string' || w[key] === '') fail(`worlds[${i}].${key} must be a non-empty string`);
      }
      const slug = w.slug as string;
      if (!/^[a-z0-9_-]+$/.test(slug)) fail(`worlds[${i}].slug "${slug}" must be lowercase letters, digits, - or _`);
      if (seen.has(slug)) fail(`duplicate slug "${slug}"`);
      seen.add(slug);
      return {
        slug,
        name: w.name as string,
        description: typeof w.description === 'string' ? w.description : '',
        world: w.world as string,
        thumbnail: w.thumbnail as string,
      };
    }),
  };
}

/**
 * Validate a parsed `world.json`. Checks every field the client reads (map tiles and frame, pano layout with a
 * `{key}` path) and refuses anything that looks like a private manifest (`nodes`/`starts`), so a publishing
 * mistake is caught instead of shipped. Exported for tests.
 */
export function validatePublicWorld(data: unknown, source = 'world.json'): PublicWorld {
  const fail = (msg: string): never => {
    throw new Error(`${source}: ${msg}`);
  };
  if (!isRecord(data)) return fail('not an object');
  if (typeof data.world !== 'string' || typeof data.name !== 'string') fail('missing "world" or "name"');
  if ('nodes' in data || 'starts' in data) fail('contains nodes/starts (a private manifest must not be public)');

  const map = record(data.map, 'map', fail);
  str(map, 'map.path', 'path', fail);
  num(map, 'map', ['tileSize', 'width', 'height'], fail, (v) => v > 0);
  num(map, 'map', ['maxZoom'], fail, (v) => Number.isInteger(v) && v >= 0);
  const frame = record(map.frame, 'map.frame', fail);
  num(frame, 'map.frame', ['x0', 'z0', 'x1', 'z1'], fail);
  if (!((frame.x1 as number) > (frame.x0 as number)) || !((frame.z0 as number) > (frame.z1 as number))) {
    fail('map.frame must have x1 > x0 and z0 > z1');
  }

  const scoring = record(data.scoring, 'scoring', fail);
  num(scoring, 'scoring', ['maxScore', 'diagonalM'], fail, (v) => v > 0);
  num(scoring, 'scoring', ['perfectRadiusM'], fail, (v) => v >= 0);

  const pano = record(data.pano, 'pano', fail);
  for (const key of ['path', 'base', 'tile'] as const) str(pano, `pano.${key}`, key, fail);
  num(pano, 'pano', ['faceSize', 'tileSize', 'nbTiles', 'baseSize'], fail, (v) => v > 0);
  if (!(pano.path as string).includes('{key}')) fail('pano.path must contain {key}');
  return data as unknown as PublicWorld;
}

/** Fetch and validate one `world.json`. */
export async function loadPublicWorld(info: WorldIndexEntry, fetchImpl: Fetch = defaultFetch): Promise<PublicWorld> {
  const url = worldFileUrl(info);
  const world = validatePublicWorld(await fetchJson(url, 'world', fetchImpl), url);
  if (world.world !== info.slug) throw new Error(`${url}: "world" is "${world.world}", expected "${info.slug}"`);
  return world;
}

/**
 * Load the index and every world in it (in parallel). Rejects only when the index itself fails; each world
 * failure (HTTP error, network error, invalid file) becomes an entry of `failed`.
 */
export async function loadPublicWorlds(fetchImpl: Fetch = defaultFetch): Promise<PublicWorlds> {
  const index = await loadWorldIndex(worldsIndexUrl(), fetchImpl);
  const settled = await Promise.all(
    index.worlds.map(async (info): Promise<LoadedPublicWorld | PublicWorldFailure> => {
      try {
        return { info, data: await loadPublicWorld(info, fetchImpl) };
      } catch (err) {
        return { slug: info.slug, info, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  const worlds = new Map<string, LoadedPublicWorld>();
  const failed: PublicWorldFailure[] = [];
  for (const item of settled) {
    if ('data' in item) worlds.set(item.info.slug, item);
    else failed.push(item);
  }
  return { index, worlds, failed };
}

/** The pano tile layout shared by every world (all worlds are rendered alike); null when nothing loaded. */
export function panoLayout(worlds: PublicWorlds): PanoLayout | null {
  for (const w of worlds.worlds.values()) return w.data.pano;
  return null;
}

/** Slugs of the loaded worlds, in index order. */
export function loadedSlugs(worlds: PublicWorlds): string[] {
  return [...worlds.worlds.keys()];
}

// --- validation helpers ------------------------------------------------------------------------

type Fail = (msg: string) => never;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function record(v: unknown, name: string, fail: Fail): Record<string, unknown> {
  return isRecord(v) ? v : fail(`missing object "${name}"`);
}

function str(obj: Record<string, unknown>, name: string, key: string, fail: Fail): void {
  if (typeof obj[key] !== 'string' || obj[key] === '') fail(`${name} must be a non-empty string`);
}

function num(obj: Record<string, unknown>, name: string, keys: string[], fail: Fail, ok: (v: number) => boolean = () => true): void {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || !ok(v)) fail(`${name}.${key} = ${String(v)} is not a valid number`);
  }
}
