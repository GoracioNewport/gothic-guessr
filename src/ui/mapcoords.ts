/**
 * Pure coordinate conversions for the guess map (SPEC.md section 2, "map.frame").
 *
 * Three spaces:
 * - game: Gothic world coordinates in centimetres, horizontal plane {x, z}, north = +z;
 * - pixel: position on the full-resolution map image, {px, py}, origin top-left, y grows down;
 * - latlng: Leaflet coordinates under `L.CRS.Simple`, which is what markers and polylines take.
 *
 * None of this touches Leaflet so it runs in vitest under node. The latlng formulas replicate
 * `L.CRS.Simple` exactly: its transformation is (1, 0, -1, 0) and its scale is 2^zoom, so
 * `map.unproject([px, py], zoom)` is `{lat: -py / 2^zoom, lng: px / 2^zoom}`.
 */
import type { GameCoords, ManifestMap, WorldGuess } from '../contracts';

export type { WorldGuess } from '../contracts';

/** Position on the full-resolution map image (at `ManifestMap.maxZoom`). */
export interface MapPixel {
  px: number;
  py: number;
}

/** Leaflet latitude/longitude pair (plain object so callers can pass it to `L.latLng`). */
export interface MapLatLng {
  lat: number;
  lng: number;
}

/** Game coordinates to full-resolution pixel. Points outside the frame are allowed. */
export function gameToPixel(map: ManifestMap, p: GameCoords): MapPixel {
  const { x0, z0, x1, z1 } = map.frame;
  return {
    px: ((p.x - x0) / (x1 - x0)) * map.width,
    py: ((z0 - p.z) / (z0 - z1)) * map.height,
  };
}

/** Full-resolution pixel to game coordinates. Inverse of {@link gameToPixel}. */
export function pixelToGame(map: ManifestMap, p: MapPixel): GameCoords {
  const { x0, z0, x1, z1 } = map.frame;
  return {
    x: x0 + (p.px / map.width) * (x1 - x0),
    z: z0 - (p.py / map.height) * (z0 - z1),
  };
}

/** Full-resolution pixel to `L.CRS.Simple` latlng, same as `map.unproject([px, py], maxZoom)`. */
export function pixelToLatLng(map: ManifestMap, p: MapPixel): MapLatLng {
  const scale = 2 ** map.maxZoom;
  return { lat: -p.py / scale, lng: p.px / scale };
}

/** `L.CRS.Simple` latlng to full-resolution pixel, same as `map.project(latlng, maxZoom)`. */
export function latLngToPixel(map: ManifestMap, ll: MapLatLng): MapPixel {
  const scale = 2 ** map.maxZoom;
  return { px: ll.lng * scale, py: -ll.lat * scale };
}

/** Game coordinates straight to Leaflet latlng. */
export function gameToLatLng(map: ManifestMap, p: GameCoords): MapLatLng {
  return pixelToLatLng(map, gameToPixel(map, p));
}

/** Leaflet latlng straight to game coordinates. */
export function latLngToGame(map: ManifestMap, ll: MapLatLng): GameCoords {
  return pixelToGame(map, latLngToPixel(map, ll));
}

// ---------------------------------------------------------------------------------------------
// Several worlds (SPEC.md section 9.4 / 9.5)
// ---------------------------------------------------------------------------------------------

/** How the result view lays out a guess/answer pair (see {@link resultPlan}). */
export interface ResultPlan {
  /** Tab to show: the answer's world (same as the guess's world when both agree). */
  activeWorld: string;
  /** True when guess and answer are on the same world, i.e. a dashed line joins them. */
  line: boolean;
  /** True when the guess was placed on another world (score 0, "Wrong world" in the overlay). */
  wrongWorld: boolean;
}

/**
 * Pure decision for the result view: same world → that world's tab, markers joined by a line;
 * different worlds → the answer's tab with only the answer marker (the guess marker stays on its own
 * tab, no line).
 */
export function resultPlan(guess: WorldGuess, answer: WorldGuess): ResultPlan {
  const same = guess.world === answer.world;
  return { activeWorld: answer.world, line: same, wrongWorld: !same };
}
