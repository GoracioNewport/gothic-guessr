import { describe, expect, it } from 'vitest';
import { loadPublicWorlds, loadedSlugs, panoLayout, validatePublicWorld, validateWorldIndex, worldFileUrl, worldThumbnailUrl, worldsIndexUrl } from '../src/data/worlds';
import { readDataset } from './dataset';

const indexJson = readDataset('public/data/worlds.json');
const khorinisJson = readDataset('public/data/khorinis/world.json');

const index = validateWorldIndex(indexJson as unknown, 'public/data/worlds.json');

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('worlds.json (stage 3)', () => {
  it('lists khorinis, valley and jharkendar with a world.json path each', () => {
    expect(index.worlds.map((w) => w.slug)).toEqual(['khorinis', 'valley', 'jharkendar']);
    for (const w of index.worlds) expect(w.world).toBe(`${w.slug}/world.json`);
  });

  it('rejects broken indexes with readable messages', () => {
    expect(() => validateWorldIndex({}, 'x')).toThrow(/x: "worlds" must be a non-empty array/);
    expect(() => validateWorldIndex({ worlds: [{ slug: 'a', name: 'A', thumbnail: 't' }] })).toThrow(/worlds\[0\]\.world/);
    const dup = { slug: 'a', name: 'A', description: '', world: 'a/world.json', thumbnail: 't' };
    expect(() => validateWorldIndex({ worlds: [dup, dup] })).toThrow(/duplicate slug "a"/);
  });

  it('builds URLs under the data base', () => {
    expect(worldsIndexUrl()).toBe('/data/worlds.json');
    expect(worldFileUrl(index.worlds[1]!)).toBe('/data/valley/world.json');
    expect(worldThumbnailUrl(index.worlds[0]!)).toBe(`/data/${index.worlds[0]!.thumbnail}`);
  });
});

describe('world.json', () => {
  it('the real khorinis file validates and has no nodes', () => {
    const w = validatePublicWorld(khorinisJson as unknown);
    expect(w.world).toBe('khorinis');
    expect(w.pano.path).toBe('panos/{key}');
    expect(Object.keys(khorinisJson).sort()).toEqual(['map', 'name', 'pano', 'scoring', 'world']);
  });

  it('refuses a private manifest and broken fields', () => {
    expect(() => validatePublicWorld({ ...khorinisJson, nodes: [] })).toThrow(/private manifest/);
    expect(() => validatePublicWorld({ ...khorinisJson, pano: { ...khorinisJson.pano, path: 'panos/{id}' } })).toThrow(/\{key\}/);
    expect(() => validatePublicWorld({ ...khorinisJson, map: { ...khorinisJson.map, frame: { x0: 1, x1: 0, z0: 1, z1: 0 } } })).toThrow(/x1 > x0/);
  });
});

describe('loadPublicWorlds', () => {
  it('loads every world in parallel and isolates failures', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      calls.push(url);
      if (url === '/data/worlds.json') return response(indexJson);
      if (url === '/data/khorinis/world.json') return response(khorinisJson);
      if (url === '/data/valley/world.json') return response({ ...khorinisJson, world: 'valley' });
      return response({ error: 'not_found' }, 404);
    };
    const result = await loadPublicWorlds(fetchImpl);
    expect(loadedSlugs(result)).toEqual(['khorinis', 'valley']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.slug).toBe('jharkendar');
    expect(result.failed[0]!.error).toMatch(/HTTP 404/);
    expect(panoLayout(result)?.path).toBe('panos/{key}');
    expect(calls[0]).toBe('/data/worlds.json');
  });

  it('a world.json naming another world is a failure', async () => {
    const fetchImpl = async (url: string): Promise<Response> =>
      url.endsWith('worlds.json') ? response({ worlds: [index.worlds[1]] }) : response(khorinisJson);
    const result = await loadPublicWorlds(fetchImpl);
    expect(result.worlds.size).toBe(0);
    expect(result.failed[0]!.error).toMatch(/expected "valley"/);
  });

  it('rejects when the index itself fails', async () => {
    await expect(loadPublicWorlds(async () => response({}, 500))).rejects.toThrow(/HTTP 500/);
  });
});
