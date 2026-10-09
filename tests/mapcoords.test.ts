import { describe, expect, it } from 'vitest';
import type { ManifestMap } from '../src/contracts';
import {
  gameToLatLng,
  gameToPixel,
  latLngToGame,
  latLngToPixel,
  pixelToGame,
  pixelToLatLng,
  resultPlan,
} from '../src/ui/mapcoords';

// Same frame as the Khorinis dataset, image size of the development tiles (maxZoom 3).
const map: ManifestMap = {
  path: 'map/{z}/{x}/{y}.webp',
  tileSize: 256,
  width: 2048,
  height: 1542,
  maxZoom: 3,
  frame: { x0: -28000, z0: 50500, x1: 95500, z1: -42500 },
};

describe('gameToPixel / pixelToGame', () => {
  it('maps the north-west frame corner to the image origin', () => {
    expect(gameToPixel(map, { x: map.frame.x0, z: map.frame.z0 })).toEqual({ px: 0, py: 0 });
  });

  it('maps the south-east frame corner to (width, height)', () => {
    expect(gameToPixel(map, { x: map.frame.x1, z: map.frame.z1 })).toEqual({ px: 2048, py: 1542 });
  });

  it('maps the frame centre to the image centre', () => {
    const centre = { x: (map.frame.x0 + map.frame.x1) / 2, z: (map.frame.z0 + map.frame.z1) / 2 };
    expect(gameToPixel(map, centre)).toEqual({ px: 1024, py: 771 });
  });

  it('puts north (larger z) at the top', () => {
    const north = gameToPixel(map, { x: 0, z: 10000 });
    const south = gameToPixel(map, { x: 0, z: -10000 });
    expect(north.py).toBeLessThan(south.py);
    expect(north.px).toBe(south.px);
  });

  it('allows points outside the frame', () => {
    expect(gameToPixel(map, { x: map.frame.x0 - 123500, z: map.frame.z0 }).px).toBeCloseTo(-2048);
  });

  it('round-trips through pixelToGame', () => {
    const p = { x: -1385.1, z: 3172.4 }; // NW_CITY_HABOUR_SHIP_01
    const back = pixelToGame(map, gameToPixel(map, p));
    expect(back.x).toBeCloseTo(p.x, 6);
    expect(back.z).toBeCloseTo(p.z, 6);
    expect(pixelToGame(map, { px: 0, py: 0 })).toEqual({ x: map.frame.x0, z: map.frame.z0 });
    expect(pixelToGame(map, { px: 2048, py: 1542 })).toEqual({ x: map.frame.x1, z: map.frame.z1 });
  });
});

describe('pixel <-> latlng (L.CRS.Simple)', () => {
  it('divides by 2^maxZoom and flips the y axis', () => {
    // At zoom 3 the full image is 2048/8 = 256 units wide, 1542/8 = 192.75 tall, lat negative.
    expect(pixelToLatLng(map, { px: 0, py: 0 })).toEqual({ lat: -0, lng: 0 });
    expect(pixelToLatLng(map, { px: 2048, py: 1542 })).toEqual({ lat: -192.75, lng: 256 });
    expect(latLngToPixel(map, { lat: -192.75, lng: 256 })).toEqual({ px: 2048, py: 1542 });
  });

  it('round-trips game <-> latlng', () => {
    const p = { x: 12345.6, z: -7890.1 };
    const back = latLngToGame(map, gameToLatLng(map, p));
    expect(back.x).toBeCloseTo(p.x, 6);
    expect(back.z).toBeCloseTo(p.z, 6);
  });
});

describe('resultPlan (SPEC 9.4 / 9.5)', () => {
  it('same world: that tab, with a line', () => {
    expect(resultPlan({ world: 'khorinis', x: 0, z: 0 }, { world: 'khorinis', x: 100, z: 0 }))
      .toEqual({ activeWorld: 'khorinis', line: true, wrongWorld: false });
  });
  it('different worlds: the answer tab, no line, flagged as wrong world', () => {
    expect(resultPlan({ world: 'khorinis', x: 0, z: 0 }, { world: 'valley', x: 100, z: 0 }))
      .toEqual({ activeWorld: 'valley', line: false, wrongWorld: true });
  });
});
