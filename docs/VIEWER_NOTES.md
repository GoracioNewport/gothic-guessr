# Viewer notes: Photo Sphere Viewer conventions verified on the Khorinis sample

## 0. Stage 3: nodes come by key from the API

Sections 1–6 were written in stage 1, when the client loaded the full `manifest.json` and addressed nodes by numeric
id (`?node=0`, `goTo(132)`). Since stage 3 (SPEC §10.3, §10.4) the conventions below still hold, but the client never
sees the graph:

- A node is a `PanoNode {key, links: [{key, yaw, pitch}]}` (`shared/api.ts`): an opaque 12-char key, no id, no
  coordinates, no waypoint name. The viewer gets it from `GET /api/games/:id/nodes/:key`, which answers only for the
  round's start node, a node returned before in that round, or a link of such a node (404 otherwise, 10 requests/s per
  game). `PanoramaView` (`src/ui/panorama.ts`) takes an async provider `(key) => Promise<PanoNode>` and feeds the
  virtual-tour plugin in server mode; `goTo` and `getCurrentKey` work with keys.
- Tiles live at `/data/panos/<key>/…` (one flat folder for all worlds, layout from `world.json` `pano`), so a URL tells
  neither the world nor the waypoint. The yaw/pitch of links and the `flipTopBottom` fix are unchanged.
- The plugin's `preload` (section 3) is off now: it would fetch every neighbour through the API, spending the rate
  limit and moving the server's resume position to nodes the player never visited. Instead `PanoramaView` preloads
  the base faces of linked nodes straight from their tile URLs (the link keys are all it needs), so arrow clicks
  still fade in without a loading gap.
- The numeric ids, waypoint names and coordinates quoted in sections 1–5 come from the private manifest
  (`server-data/khorinis/manifest.json`); use them to find a spot there, not in the browser.

**`dev/pano.html` now.** It runs against the real API, so start the whole stack with `npm run dev` (needs the published
dataset, see README) and open http://localhost:5173/dev/pano.html. The harness creates or reuses a player (token in
`localStorage` like the game), starts an untimed solo game and opens round 1 at its start node. Query parameters pick
the settings: `?mode=classic|mixed|hardcore` (default mixed), `&worlds=khorinis,valley` (default all loaded worlds),
`&nomove=1`, `&nolook=1`. Each reload is a new solo game, so a new random start.

- The overlay shows the current key, the camera direction (viewer yaw and the equivalent game yaw, pitch) and the
  links of the current node with their yaw and pitch; the log lists every node fetch and `node-changed`.
- The `key` field with `go` / `go (instant)` calls `goTo(key)`. Only keys the API will serve work: the start key (the
  field is filled with it), the links shown in the overlay and nodes visited in this game; anything else is rejected
  with the API's 404, which is the reach check doing its job.
- `freeze` / `unfreeze` toggle the arrows (`setMovementEnabled`), `no look` / `look` the camera (`setLookEnabled`).
- `window.__pano` holds `{ view, api, game, round }`: e.g. `__pano.view.getViewer().rotate({ yaw, pitch })`
  (radians) or `await __pano.api.getNode(__pano.game.id, key)`.

To look at one particular waypoint, find its key in the private manifest; reaching it in the harness still means
walking there from a start node (the API serves nothing else).

## Stage 1 verification

Everything below was checked in the browser with `dev/pano.html` (Vite, `npx vite --port 5181
--strictPort`, page `http://localhost:5181/dev/pano.html?node=0`) against
`public/data/khorinis` (168 nodes). The harness shows the viewer full-screen, an overlay with the
current node, its links and the camera direction (viewer yaw in degrees and the equivalent manifest
yaw), a log of `node-changed` events, and controls for `goTo` / freeze. `window.__pano.view`
exposes the `PanoramaView` so the camera can be driven from the console
(`__pano.view.getViewer().rotate({ yaw, pitch })`, radians).

Library versions: `@photo-sphere-viewer/core`, `cubemap-tiles-adapter`, `virtual-tour-plugin`
5.15.1.

## 1. Yaw convention

**Finding: Photo Sphere Viewer yaw grows clockwise when seen from above (turning right), yaw 0 is
the centre of the `front` face.** Because the pipeline renders `front` = north and `right` = east,
the manifest's "degrees clockwise from north" map 1:1 onto viewer radians:

```ts
gameYawToViewerYaw(deg) = deg * π / 180   // normalised to [0, 2π)
gamePitchToViewerPitch(deg) = deg * π / 180
```

(`src/ui/panorama.ts`, unit test `tests/panorama-yaw.test.ts`.)

Evidence, all at the harbour node 0 `NW_CITY_HABOUR_SHIP_01` (x = −1385, z = 3172) unless noted:

| camera | what is visible | conclusion |
|---|---|---|
| viewer yaw 0, pitch 0 | the harbour crane base straight ahead, its arm rising towards the camera; sea to the left | `front` face shown at yaw 0 |
| viewer yaw π/2 | the quay plaza with half-timbered houses and the big tree; the only arrow (link to 132, manifest yaw 71.7°) slightly left of centre | `right` face = manifest 90° (east); a link 18° "less" than the camera appears 18° to the left, so positive yaw is to the right |
| viewer yaw π | boats with furled sails moored along the quay, water beyond | `back` face = south; the harbour basin is south of the quay |
| viewer yaw 3π/2 | the quay running away westwards and the rock face | `left` face = west |
| viewer yaw 0, the arrow for link 71.7° | arrow appears right of the screen centre | positive = right (clockwise) |

Geometry cross-check: node 132 `NW_CITY_HABOUR_12` is at (−772, 3375), i.e. Δx = +613 (east), Δz =
+203 (north) from node 0, bearing `atan2(Δx, Δz)` = 71.7°, which is exactly the manifest yaw of the
link 0 → 132. After clicking that arrow the viewer arrives at node 132 with the camera still at
71.7° (direction kept). Rotating the camera to the back-link 132 → 0 (manifest 251.7°, viewer
4.393 rad) shows the crane hook dead ahead and the quay leading to the crane base where node 0 is,
6.5 m away. The second link of node 132 (→ 133, 123.4°, i.e. 128° to the left of the camera)
appears as an arrow on the lower left pointing left. Links roughly 180° apart (0 → 132 at 71.7°,
132 → 0 at 251.7°) point in opposite directions along the quay.

## 2. Top / bottom face orientation

The pipeline emits the classic cross layout (SPEC §3): `top` with image-up = south (its bottom edge
continues the top edge of `front`), `bottom` with image-up = north. Looking at the raw
`panos/0/base_top.webp`, the crane beams enter from the bottom edge of the image and end at the
pulley near the top-left; in `base_front.webp` the beams leave through the top edge at the same
horizontal position. So the data matches the SPEC.

**The adapter expects the opposite orientation for both faces.** Without any option, at node 0:

- pitch +45°, yaw 0 (front/top seam at the screen centre): the beams stop dead at the seam, and the
  pulley shows up in the wrong corner;
- pitch +90°: the beams enter from the *top* of the screen (south) instead of the bottom (north);
- pitch −45°, yaw 0 (front/bottom seam): the quay edge and the wooden mooring block are cut at the
  seam; the cobblestones do not continue.

Fix: `flipTopBottom: true` in the `CubemapTilesPanorama` object (`src/ui/panorama.ts`,
`panoramaFor`). The adapter then rotates the `top` and `bottom` textures by 180° (and mirrors the
tile indices accordingly). Verified afterwards:

- front/top seam (pitch +45°, yaw 0): both crane beams and the rope run continuously across the
  seam up to the pulley block;
- straight up (pitch +90°): the beams come in from the bottom of the screen (north = front side) and
  end at the pulley block on the upper left, matching the raw `base_top` rotated 180°;
- front/bottom seam (pitch −45°, yaw 0): quay edge, mooring block and cobblestones continue;
- back/bottom seam (yaw π, pitch −45°): quay edge with the boats continues, stone joints line up;
- right/top seam (yaw π/2, pitch +45°): clean sky, no artefacts.

Because two different vertical edges (front/top and back/bottom) and a side edge (right/top) all
line up, the mismatch was a pure 180° rotation, not a mirror; no face remapping is needed.

## 3. Progressive loading

Network log on first load of node 0 (Chrome devtools via the harness): the six `base_*.webp`
(512 px) are requested first, then the 1024 px tiles for the visible faces (`right_*`, `front_*`,
`top_*`, `bottom_*`), the rest when the camera turns. `baseBlur` is off so the low-res faces are
shown sharp-ish until the tiles replace them. No request fails; no console errors or warnings.

With `preload: true` the plugin also fetches the base faces of linked nodes after arrival, which
makes arrow clicks fade in without a visible loading gap.

## 4. Behaviour verified in the harness

- `goTo(0)` (first node): no transition, camera faces the first link; `node-changed` fires once.
- Arrow click 0 → 132: 350 ms fade, camera direction kept, `node-changed → 132`.
- `goTo(50)` (not linked to the current node): fade, direction kept, `node-changed → 50`.
- `goTo(999)`: rejected with `PanoramaView: unknown node id 999`, viewer untouched.
- `goTo(1, { instant: true })` (indoor barracks node): immediate switch, both arrows (149.8°,
  332.4°) visible in the corridor.
- `setMovementEnabled(false)`: the arrows container is hidden (`display: none` on
  `.psv-virtual-tour-arrows`), so arrows are neither visible nor clickable; free look still works.
  `setMovementEnabled(true)` restores them.
- Navbar: zoom slider + fullscreen only; no gallery, compass or link tooltips.
- 1280×720 and the narrow 800×1270 browser pane both show the arrows in the lower third of the
  view (`arrowsPosition.minPitch = 0.2`).

## 5. Integration changes (src/main.ts wiring)

Verified in the full game (`npm run dev`, `http://localhost:5173/?seed=42` on the 168-node crop and
`?seed=7` / `?seed=99` on the full 2795-node dataset): five rounds each with arrow walking, `R`,
guess, result overlay and summary; no console errors.

- **One viewer per game, re-parented per round.** `PanoramaView.init(container)` creates the
  viewer inside its own host element (`div.pano-host`, 100% × 100%) the first time; later calls
  just move that host into the new container the screens module hands over for each round and
  call `viewer.autoSize()`. PSV observes its inner `.psv-container` with a `ResizeObserver` and a
  canvas keeps its WebGL context across DOM moves, so nothing is re-created between rounds (one
  `<canvas>` in the document throughout a game, checked in the browser). `destroy()` removes the
  host; the summary screen destroys the viewer and "Play again" creates a fresh one.
- **`GoToOptions.resetView`** (additive contract extension): rotate the camera to the node's
  first link as happens for the very first node. `main.ts` passes `{ instant: true, resetView:
  true }` for the start node of every round, and `{ instant: true }` for "Return to start" (the
  camera direction is kept there).
- **Stacking.** The plugin's arrow layer uses `z-index: 11`, the PSV navbar 90 and the loader 80,
  all above the HUD (`.g2-hud`, 10) and the result overlay (20). `.g2-pano` now has `z-index: 0`
  so it forms its own stacking context; before that the 3D arrows were drawn on top of the
  expanded guess map (seen in the browser, fixed and re-checked).
- Movement is disabled (`setMovementEnabled(false)`, arrows hidden) while the result overlay is
  shown and enabled again at the start of the next round.

## 6. Open points

- `gameYawToViewerYaw` / `gamePitchToViewerPitch` live in `src/game/graph.ts` only;
  `src/ui/panorama.ts` imports and re-exports them (the empirically verified sign is in one place).
- The 3D arrows ignore the link `pitch` (the plugin draws them on a virtual floor below the
  horizon); it is still passed through in case `renderMode: '2d'` is used later.
