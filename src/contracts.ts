/**
 * Shared contracts for Gothic II Guessr.
 *
 * Every module in src/ implements or consumes the types below. Four modules are developed in
 * parallel (panorama, guess map, screens, game logic), so this file is the only thing they may
 * assume about each other. Extend it additively only (new optional fields, new types); never
 * rename or remove a member without telling every implementer.
 *
 * Conventions used throughout:
 * - "Game coordinates" are the original Gothic II world coordinates in centimetres, Y up.
 *   The guess/answer logic only needs the horizontal plane, hence {@link GameCoords} is {x, z}.
 * - Node ids are array indices into `Manifest.nodes` (`nodes[i].id === i`) and are **per world**:
 *   since stage 2 a place in the game is a {@link Location} `{world, nodeId}` and a guess is a
 *   {@link WorldGuess} `{world, x, z}` (SPEC.md section 9.1).
 * - Yaw in the manifest is degrees clockwise from north (0 = north = +Z, 90 = east = +X).
 *   Conversion to the viewer's own convention lives in `src/game/graph.ts` (`gameYawToViewerYaw`).
 * - Distances between nodes/guesses are expressed in metres (game units / 100).
 */

// ---------------------------------------------------------------------------------------------
// Manifest (mirrors SPEC.md section 2; produced by tools/g2pipeline.py)
// ---------------------------------------------------------------------------------------------

/** A walkable edge of the waypoint graph. Links are symmetric: if A→B exists, B→A exists. */
export interface ManifestLink {
  /** Target node id (index into `Manifest.nodes`). */
  to: number;
  /** Direction to the target, degrees clockwise from north (0 = +Z, 90 = +X), range [0, 360). */
  yaw: number;
  /** Elevation of the target above the horizon in degrees (negative = below). */
  pitch: number;
  /** Straight-line distance to the target in metres. */
  dist: number;
}

/** One panorama node (a Gothic waypoint). */
export interface ManifestNode {
  /** Node id; always equals the index in `Manifest.nodes`. */
  id: number;
  /** Original waypoint name from the ZEN, e.g. `NW_CITY_HABOUR_SHIP_01`. Debug/display only. */
  wp: string;
  /** Camera position in game coordinates (centimetres). `y` is up. */
  x: number;
  y: number;
  z: number;
  /**
   * True for nodes under the open sky. Starts may be indoor too (caves, cellars, houses, dense
   * canopy); the game mode decides which ones a game uses (see {@link GameMode}).
   */
  outdoor: boolean;
  /** Outgoing edges. May be empty for isolated nodes (never for nodes listed in `starts`). */
  links: ManifestLink[];
}

/** Layout of the cube-map tiles for every node (see SPEC.md section 2 for the directory layout). */
export interface ManifestPano {
  /** Full-resolution size of one cube face in pixels (e.g. 2048). */
  faceSize: number;
  /** Size of one tile in pixels (e.g. 1024). */
  tileSize: number;
  /** Tiles per face edge; a face has `nbTiles × nbTiles` tiles (e.g. 2). */
  nbTiles: number;
  /** Size of the low-resolution base face used for instant display (e.g. 512). */
  baseSize: number;
  /** Directory of one node relative to the world directory, with `{id}` placeholder: `panos/{id}`. */
  path: string;
  /** Base face file name with `{face}` placeholder: `base_{face}.webp`. */
  base: string;
  /** Tile file name with `{face}`, `{col}`, `{row}` placeholders: `{face}_{col}_{row}.webp`. */
  tile: string;
  /** Face names in the order the pipeline emits them: front, right, back, left, top, bottom. */
  faces: CubeFace[];
}

/** Cube face names. Front face centre = north (+Z), right = east, back = south, left = west. */
export type CubeFace = 'front' | 'right' | 'back' | 'left' | 'top' | 'bottom';

/**
 * Game-coordinate rectangle covered by the full-resolution map image.
 * `(x0, z0)` is the top-left corner (west, north), `(x1, z1)` the bottom-right (east, south).
 * Note `z0 > z1` because north has the larger z.
 */
export interface MapFrame {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** Raster map tiles for the guess map (XYZ layout, 256 px tiles, y grows downward). */
export interface ManifestMap {
  /** Tile path relative to the world directory, Leaflet-style placeholders: `map/{z}/{x}/{y}.webp`. */
  path: string;
  /** Tile size in pixels (256). */
  tileSize: number;
  /** Full-resolution image width in pixels (at `maxZoom`). */
  width: number;
  /** Full-resolution image height in pixels (at `maxZoom`). */
  height: number;
  /** Highest zoom level that has tiles. Zoom 0 is the whole image in one tile. */
  maxZoom: number;
  /** Game-coordinate extent of the image; pixel formulas in SPEC.md section 2. */
  frame: MapFrame;
}

/** Scoring constants (SPEC.md section 5). */
export interface ManifestScoring {
  /** Score for a perfect guess (5000). */
  maxScore: number;
  /** Guesses within this many metres of the answer get `maxScore` (15). */
  perfectRadiusM: number;
  /** Diagonal of the playable area in metres; scale of the exponential falloff (~1546). */
  diagonalM: number;
}

/** `manifest.json` of one world. */
export interface Manifest {
  /** World slug; also the directory name under the data base: `khorinis`. */
  world: string;
  /** Human-readable world name: `Khorinis`. */
  name: string;
  /** Unit of `x, y, z` in nodes; always `cm` for Gothic. */
  units: string;
  /** Camera height above the waypoint in centimetres. Informational. */
  eyeHeight: number;
  pano: ManifestPano;
  map: ManifestMap;
  scoring: ManifestScoring;
  /** All nodes; `nodes[i].id === i`. */
  nodes: ManifestNode[];
  /** Node ids eligible as round starts (connected, not a monster spawn; indoor and outdoor). */
  starts: number[];
}

// ---------------------------------------------------------------------------------------------
// Worlds (SPEC.md section 9.1; `public/data/worlds.json`). Added in stage 2.
// ---------------------------------------------------------------------------------------------

/** One entry of `worlds.json`. Paths are relative to the data base (`dataBase()`). */
export interface WorldInfo {
  /** Stable id used everywhere a world is referenced: `khorinis`, `valley`, `jharkendar`. */
  slug: string;
  /** Display name: `Valley of Mines`. */
  name: string;
  /** One-line blurb for the start screen. */
  description: string;
  /** Manifest path relative to the data base: `valley/manifest.json`. */
  manifest: string;
  /** Thumbnail path relative to the data base: `valley/map/2/0/0.webp`. */
  thumbnail: string;
}

/** `worlds.json`: the worlds in display order (start-screen checkboxes, map tabs). */
export interface WorldsIndex {
  worlds: WorldInfo[];
}

/** A world whose manifest loaded. */
export interface LoadedWorld {
  info: WorldInfo;
  manifest: Manifest;
}

/** A world whose manifest did not load; shown greyed out on the start screen, never played. */
export interface WorldLoadFailure {
  slug: string;
  /** The index entry, when the slug was known to `worlds.json`. */
  info: WorldInfo | null;
  /** Readable error message (HTTP status, network error, validation failure). */
  error: string;
}

/** Result of `loadWorlds()` (src/data/worlds.ts): loaded worlds keyed by slug, in index order. */
export interface LoadWorldsResult {
  worlds: Map<string, LoadedWorld>;
  failed: WorldLoadFailure[];
}


// ---------------------------------------------------------------------------------------------
// Public world data (stage 3, SPEC.md section 10.3): what the client may load. The full manifests
// above now live only on the server (`server-data/<slug>/manifest.json`); the client gets
// `worlds.json` with `world` entries and each world's `world.json` (no nodes, no starts).
// ---------------------------------------------------------------------------------------------

/** One entry of the stage-3 `worlds.json`. Paths are relative to the data base. */
export interface WorldIndexEntry {
  slug: string;
  /** English display name; the client prefers its localized name (src/i18n `worldName`). */
  name: string;
  description: string;
  /** Public world file relative to the data base: `valley/world.json`. */
  world: string;
  /** Thumbnail path relative to the data base. */
  thumbnail: string;
}

/** The stage-3 `worlds.json`. */
export interface WorldIndex {
  worlds: WorldIndexEntry[];
}

/**
 * Tile layout of every panorama, from `world.json` `pano`. Same fields as {@link ManifestPano}, but
 * `path` is `panos/{key}` relative to the **data base** (the URL does not reveal the world).
 */
export type PanoLayout = ManifestPano;

/** `<slug>/world.json`: everything public about a world. */
export interface PublicWorld {
  world: string;
  name: string;
  map: ManifestMap;
  scoring: ManifestScoring;
  pano: PanoLayout;
}

/** A world whose index entry and `world.json` loaded. */
export interface LoadedPublicWorld {
  info: WorldIndexEntry;
  data: PublicWorld;
}

/** A world whose `world.json` failed to load; never offered for play. */
export interface PublicWorldFailure {
  slug: string;
  info: WorldIndexEntry | null;
  error: string;
}

/** Result of `loadPublicWorlds()` (src/data/worlds.ts): loaded worlds keyed by slug, in index order. */
export interface PublicWorlds {
  index: WorldIndex;
  worlds: Map<string, LoadedPublicWorld>;
  failed: PublicWorldFailure[];
}
/** A node in a world: where a round starts, where the player stands. Node ids are per world. */
export interface Location {
  /** World slug. */
  world: string;
  /** Node id inside that world's manifest. */
  nodeId: number;
}

/** A guess: a point on one world's map. */
export interface WorldGuess extends GameCoords {
  /** Slug of the world whose map tab the marker was placed on. */
  world: string;
}

/**
 * Everything that defines a game apart from the player's actions (SPEC.md section 9.2). Carried
 * in the URL (`settingsToSearch` / `settingsFromUrl` in src/game/state.ts) so a link replays the
 * same game.
 */
export interface GameSettings {
  /** PRNG seed, 32-bit unsigned. */
  seed: number;
  mode: GameMode;
  /** Enabled world slugs in `worlds.json` order; never empty once resolved. */
  worlds: string[];
  /** Movement disabled: no arrows, no "Return to start". */
  noMove: boolean;
  /** Camera frozen at the initial direction and zoom. Implies `noMove`. */
  noLook: boolean;
}

// ---------------------------------------------------------------------------------------------
// Game values
// ---------------------------------------------------------------------------------------------

/** A point in the horizontal game plane, centimetres. Used for guesses and answers. */
export interface GameCoords {
  x: number;
  z: number;
}

/**
 * Which starts a game draws from (SPEC.md section 6): `classic` = outdoor starts only, `mixed` =
 * mostly outdoor with roughly a third of the rounds indoors, `hardcore` = any start at all.
 */
export type GameMode = 'classic' | 'mixed' | 'hardcore';

/** Outcome of one finished round. */
export interface RoundResult {
  /** 1-based round number. */
  round: number;
  /** Where the player clicked on the map, game coordinates in `guessWorld` (the `world` field repeats `guessWorld`). */
  guess: WorldGuess;
  /** Position of the round's start node, game coordinates in `answerWorld`. */
  answer: GameCoords;
  /** Slug of the world the marker was placed on (stage 2). */
  guessWorld: string;
  /** Slug of the world the round was played in (stage 2). */
  answerWorld: string;
  /** Start node of the round (stage 2); `answerNodeId` is an id in `answerWorld`. */
  answerNodeId: number;
  /**
   * Horizontal distance between guess and answer in metres, or `null` when `guessWorld !==
   * answerWorld` (SPEC.md section 9.5: "Wrong world — it was <World name>").
   */
  distanceM: number | null;
  /** Round score, 0..`scoring.maxScore`; 0 for a wrong-world guess. */
  score: number;
}

/** Everything the summary screen shows after the last round. */
export interface GameSummary {
  /** PRNG seed of this game; shown as "Game #<seed>" and replayable via `?seed=<seed>&mode=<mode>`. */
  seed: number;
  /** Game mode the starts were drawn with; shown next to the seed on the summary screen. */
  mode: GameMode;
  /**
   * Full session settings (stage 2): worlds, toggles, and the same `seed`/`mode` as above. The
   * replay link is `settingsToSearch(summary.settings)`.
   */
  settings: GameSettings;
  /** One entry per played round, in order. */
  rounds: RoundResult[];
  /** Sum of `rounds[].score`. */
  total: number;
}

// ---------------------------------------------------------------------------------------------
// Panorama view (src/ui/panorama.ts) — Photo Sphere Viewer wrapper, stage 3: nodes by key
// ---------------------------------------------------------------------------------------------

/** Options for {@link PanoramaViewApi.goTo}. */
export interface GoToOptions {
  /** Skip the fade transition (used for "Return to start" and the first node of a round). */
  instant?: boolean;
  /**
   * Rotate the camera to face the node's first link instead of keeping the current direction,
   * as happens automatically for the very first node shown. Used for the first node of every
   * round so the player starts with a way forward in view.
   */
  resetView?: boolean;
}

/** One panorama node as the API hands it out (`shared/api.ts` `PanoNode`), re-declared for the UI layer. */
export interface PanoNodeData {
  key: string;
  links: { key: string; yaw: number; pitch: number }[];
}

/**
 * Where the panorama gets its nodes from: `GET /api/games/:id/nodes/:key` in the game (the reach
 * check of SPEC §10.4 applies), a fixture in tests and harnesses. Rejects when the node is refused.
 */
export type PanoNodeProvider = (key: string) => Promise<PanoNodeData>;

/**
 * The 360° panorama with Street-View style movement along the waypoint graph (stage 3: the graph
 * is only known one node at a time, through a {@link PanoNodeProvider}).
 *
 * Lifecycle: construct with the tile layout (`world.json` `pano`, identical for every world) and a
 * provider, `init(container)` once per screen (the viewer is moved into later containers), `goTo`
 * per round, `setProvider` when a new game starts, `destroy()` when leaving the game.
 */
export interface PanoramaViewApi {
  /** Create the viewer inside `container`, or move the existing one there. Loads no node. */
  init(container: HTMLElement): Promise<void>;
  /**
   * Show node `key`. Resolves when the base (low-res) faces are displayed; high-res tiles keep
   * loading. Keeps the current camera direction unless it is the first node or `resetView`.
   */
  goTo(key: string, opts?: GoToOptions): Promise<void>;
  /** Key of the node currently displayed, or null before the first `goTo`. */
  getCurrentKey(): string | null;
  /** Subscribe to arrivals (arrow clicks and programmatic `goTo`); returns an unsubscribe function. */
  onNodeChanged(cb: (key: string) => void): () => void;
  /** Replace the node source (a new game) and forget every cached node. */
  setProvider(provider: PanoNodeProvider): void;
  /** Enable or disable walking (arrow clicks). Free look stays enabled. */
  setMovementEnabled(enabled: boolean): void;
  /** Enable or disable free look (SPEC §9.2 "No look"); call before the first `goTo` of a round. */
  setLookEnabled(enabled: boolean): void;
  /** Tear down the viewer and release WebGL resources. Safe to call twice. */
  destroy(): void;
}

// ---------------------------------------------------------------------------------------------
// Guess map (src/ui/guessmap.ts) — Leaflet wrapper
// ---------------------------------------------------------------------------------------------

/** One world shown on the guess map (a tab). Stage 3: only the public map description is needed. */
export interface GuessMapWorld {
  slug: string;
  /** Tab label fallback; the map shows the localized name when the slug is known. */
  name: string;
  /** `world.json` `map`: tiles (relative to the world directory) and the game-coordinate frame. */
  map: ManifestMap;
}

/**
 * Another player's marker on the result map (rooms, SPEC §10.7: colour per player, nickname
 * tooltip). The player's own guess is passed separately and keeps the standard guess colour.
 */
export interface PlayerMarker {
  id: string;
  name: string;
  /** CSS colour of the pin. */
  color: string;
  /** null = no guess (timed out, gave up): no marker. */
  guess: WorldGuess | null;
}

/**
 * The collapsible guess map. Coordinates crossing this API are always game coordinates; the map
 * converts to/from tile pixels internally using `map.frame` of the world in question.
 *
 * One tab per enabled world, in worlds.json order (never depending on the round, SPEC §9.4). A
 * marker belongs to the world it was placed on; the guess is the last marker placed.
 */
export interface GuessMapApi {
  /** Create the Leaflet map inside `container`; `worlds` replaces the tab list and selects its first tab. */
  init(container: HTMLElement, worlds?: GuessMapWorld[]): void;
  /** Subscribe to marker placement (every click in guessing mode). */
  onGuess(cb: (p: WorldGuess) => void): void;
  /** The last marker placed, or null. */
  getGuess(): WorldGuess | null;
  /** Remove every marker and line and return to guessing mode. */
  clearGuess(): void;
  /**
   * Switch to result mode: the answer's tab with the answer marker; the player's guess (if any) on
   * its own tab, joined to the answer by a dashed line when on the same world; `others` adds every
   * other player's marker (rooms). Clicks no longer move markers.
   */
  showResult(guess: WorldGuess | null, answer: WorldGuess, others?: PlayerMarker[]): void;
  setActiveWorld(slug: string): void;
  getActiveWorld(): string;
  getWorlds(): string[];
  onWorldChanged(cb: (slug: string) => void): void;
  fitWorld(): void;
  setExpanded(expanded: boolean): void;
  invalidateSize(): void;
  destroy(): void;
}
