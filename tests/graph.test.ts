import { describe, expect, it } from 'vitest';
import { validateManifest } from '../src/data/manifest';
import { readDataset } from './dataset';
import {
  bfsDistance,
  findLink,
  gamePitchToViewerPitch,
  gameYawToViewerYaw,
  getNode,
  hasNode,
  isValidLink,
  manifestNodeId,
  neighbours,
  nodeCoords,
  nodeToViewerLinks,
  reachableNodes,
  viewerNodeId,
} from '../src/game/graph';

const manifestJson: unknown = readDataset('server-data/khorinis/manifest.json');

// The real dataset: the private khorinis manifest in server-data/ (git-ignored, SPEC §10.3). The tests below
// must hold for both the 168-node development crop and the full world, so dataset-specific
// expectations are anchored on waypoint names rather than node ids.
const manifest = validateManifest(manifestJson as unknown, 'khorinis/manifest.json');

/** The harbour node of SPEC section 3 (id 0 in the development crop). */
const harbour = manifest.nodes.find((n) => n.wp === 'NW_CITY_HABOUR_SHIP_01');
if (!harbour) throw new Error('NW_CITY_HABOUR_SHIP_01 missing from the manifest');
/** Its 6.5 m link along the quay to NW_CITY_HABOUR_12 (yaw 71.68°). */
const quay = harbour.links.find((l) => getNode(manifest, l.to).wp === 'NW_CITY_HABOUR_12');
if (!quay) throw new Error('harbour → NW_CITY_HABOUR_12 link missing from the manifest');

describe('manifest sanity (real khorinis dataset)', () => {
  it('has the expected shape', () => {
    expect(manifest.world).toBe('khorinis');
    expect(manifest.nodes.length).toBeGreaterThan(100);
    expect(manifest.starts.length).toBeGreaterThanOrEqual(5);
    expect(quay.dist).toBeCloseTo(6.46, 2);
    expect(quay.yaw).toBeCloseTo(71.68, 2);
  });

  it('links are symmetric and point at existing nodes', () => {
    for (const node of manifest.nodes) {
      for (const link of node.links) {
        expect(hasNode(manifest, link.to)).toBe(true);
        expect(link.to).not.toBe(node.id);
        expect(findLink(manifest, link.to, node.id), `${link.to} → ${node.id} missing`).toBeDefined();
      }
    }
  });

  it('link yaw/pitch/dist agree with node coordinates', () => {
    for (const node of manifest.nodes) {
      for (const link of node.links) {
        const target = getNode(manifest, link.to);
        const dx = target.x - node.x;
        const dz = target.z - node.z;
        const dy = target.y - node.y;
        const horizontal = Math.hypot(dx, dz);
        // yaw: degrees clockwise from north (+Z) towards east (+X)
        const yaw = ((Math.atan2(dx, dz) * 180) / Math.PI + 360) % 360;
        const yawDiff = Math.abs(((yaw - link.yaw + 540) % 360) - 180);
        expect(yawDiff, `yaw of ${node.id}→${link.to}`).toBeLessThan(0.5);
        const pitch = (Math.atan2(dy, horizontal) * 180) / Math.PI;
        expect(Math.abs(pitch - link.pitch), `pitch of ${node.id}→${link.to}`).toBeLessThan(0.5);
        expect(Math.abs(Math.hypot(dx, dy, dz) / 100 - link.dist), `dist of ${node.id}→${link.to}`).toBeLessThan(0.05);
      }
    }
  });

  it('every start is connected (has at least one link) and both indoor and outdoor starts exist', () => {
    // Starts deliberately include indoor nodes (caves, houses, forest canopy); the game mode decides how
    // they are mixed. The pipeline only guarantees a link and a component of at least 10 nodes.
    let outdoor = 0;
    for (const id of manifest.starts) {
      const node = getNode(manifest, id);
      if (node.outdoor) outdoor++;
      expect(node.links.length, `start ${id} (${node.wp}) links`).toBeGreaterThan(0);
      expect(reachableNodes(manifest, id).size).toBeGreaterThan(1);
    }
    expect(outdoor).toBeGreaterThan(0);
    expect(manifest.starts.length - outdoor).toBeGreaterThan(0);
  });
});

describe('getNode / hasNode / nodeCoords', () => {
  it('returns nodes by id and rejects bad ids', () => {
    expect(getNode(manifest, 0).id).toBe(0);
    expect(getNode(manifest, manifest.nodes.length - 1).id).toBe(manifest.nodes.length - 1);
    expect(() => getNode(manifest, -1)).toThrow(/node -1/);
    expect(() => getNode(manifest, manifest.nodes.length)).toThrow(/does not exist/);
    expect(() => getNode(manifest, 1.5)).toThrow();
    expect(hasNode(manifest, 0)).toBe(true);
    expect(hasNode(manifest, 1.5)).toBe(false);
    expect(hasNode(manifest, manifest.nodes.length)).toBe(false);
  });

  it('nodeCoords drops y', () => {
    const n = getNode(manifest, 0);
    expect(nodeCoords(n)).toEqual({ x: n.x, z: n.z });
    expect(nodeCoords(n)).not.toHaveProperty('y');
  });
});

describe('neighbours / isValidLink', () => {
  it('lists outgoing targets in manifest order', () => {
    const n = getNode(manifest, 2);
    expect(neighbours(manifest, 2)).toEqual(n.links.map((l) => l.to));
    expect(neighbours(manifest, harbour.id)).toEqual(harbour.links.map((l) => l.to));
    expect(neighbours(manifest, harbour.id)).toContain(quay.to);
  });

  it('validates edges', () => {
    const linked = new Set(neighbours(manifest, harbour.id));
    const stranger = manifest.nodes.find((n) => n.id !== harbour.id && !linked.has(n.id))!;
    expect(isValidLink(manifest, harbour.id, quay.to)).toBe(true);
    expect(isValidLink(manifest, quay.to, harbour.id)).toBe(true);
    expect(isValidLink(manifest, harbour.id, stranger.id)).toBe(false);
    expect(isValidLink(manifest, harbour.id, harbour.id)).toBe(false);
    expect(isValidLink(manifest, harbour.id, 99_999)).toBe(false);
    expect(isValidLink(manifest, -1, harbour.id)).toBe(false);
  });
});

describe('bfsDistance', () => {
  it('measures hops', () => {
    expect(bfsDistance(manifest, harbour.id, harbour.id)).toBe(0);
    expect(bfsDistance(manifest, harbour.id, quay.to)).toBe(1);
    // A node two steps away: a neighbour of the quay node that is not adjacent to the harbour.
    const near = new Set([harbour.id, ...neighbours(manifest, harbour.id)]);
    const twoAway = neighbours(manifest, quay.to).find((id) => !near.has(id));
    expect(twoAway).toBeDefined();
    expect(bfsDistance(manifest, harbour.id, twoAway!)).toBe(2);
    expect(bfsDistance(manifest, twoAway!, harbour.id)).toBe(2);
  });

  it('returns -1 for unreachable nodes and throws for unknown ids', () => {
    const isolated = manifest.nodes.find((n) => n.links.length === 0);
    if (isolated) expect(bfsDistance(manifest, harbour.id, isolated.id)).toBe(-1);
    expect(() => bfsDistance(manifest, harbour.id, 99_999)).toThrow();
  });

  it('is consistent with reachableNodes', () => {
    const reach = reachableNodes(manifest, harbour.id);
    for (const id of [harbour.id, 0, 1, 50, 100, manifest.nodes.length - 1]) {
      expect(bfsDistance(manifest, harbour.id, id) >= 0).toBe(reach.has(id));
    }
  });
});

describe('viewer ids', () => {
  it('round-trips', () => {
    expect(viewerNodeId(42)).toBe('42');
    expect(manifestNodeId('42')).toBe(42);
    expect(manifestNodeId(viewerNodeId(0))).toBe(0);
    expect(() => manifestNodeId('abc')).toThrow();
    expect(() => manifestNodeId('-1')).toThrow();
  });
});

describe('angle conversion', () => {
  it('yaw: degrees clockwise from north → radians in [0, 2π), same sign', () => {
    expect(gameYawToViewerYaw(0)).toBe(0);
    expect(gameYawToViewerYaw(90)).toBeCloseTo(Math.PI / 2, 10);
    expect(gameYawToViewerYaw(180)).toBeCloseTo(Math.PI, 10);
    expect(gameYawToViewerYaw(270)).toBeCloseTo((3 * Math.PI) / 2, 10);
    expect(gameYawToViewerYaw(360)).toBeCloseTo(0, 10);
    expect(gameYawToViewerYaw(-90)).toBeCloseTo((3 * Math.PI) / 2, 10);
    expect(gameYawToViewerYaw(450)).toBeCloseTo(Math.PI / 2, 10);
  });

  it('pitch: degrees → radians', () => {
    expect(gamePitchToViewerPitch(0)).toBe(0);
    expect(gamePitchToViewerPitch(45)).toBeCloseTo(Math.PI / 4, 10);
    expect(gamePitchToViewerPitch(-1.2)).toBeCloseTo((-1.2 * Math.PI) / 180, 10);
  });
});

describe('nodeToViewerLinks', () => {
  it('uses the injected yaw converter and defaults pitch to deg→rad', () => {
    const links = nodeToViewerLinks(manifest, harbour, { yaw: (deg) => -deg });
    expect(links).toHaveLength(harbour.links.length);
    expect(links).toEqual(
      harbour.links.map((l) => ({
        nodeId: String(l.to),
        position: { yaw: -l.yaw, pitch: gamePitchToViewerPitch(l.pitch) },
        dist: l.dist,
      })),
    );
    const quayLink = links.find((l) => l.nodeId === String(quay.to));
    expect(quayLink?.position.yaw).toBeCloseTo(-71.68, 2);
  });

  it('with the default converters produces one link per manifest link', () => {
    const node = getNode(manifest, 2);
    const links = nodeToViewerLinks(manifest, node, { yaw: gameYawToViewerYaw, pitch: gamePitchToViewerPitch });
    expect(links.map((l) => l.nodeId)).toEqual(node.links.map((l) => String(l.to)));
    for (const l of links) {
      expect(l.position.yaw).toBeGreaterThanOrEqual(0);
      expect(l.position.yaw).toBeLessThan(2 * Math.PI);
    }
  });

  it('drops links to nodes that are not in the manifest', () => {
    const node = { ...harbour, links: [{ to: 99_999, yaw: 0, pitch: 0, dist: 1 }, { to: quay.to, yaw: 0, pitch: 0, dist: 1 }] };
    expect(nodeToViewerLinks(manifest, node, { yaw: gameYawToViewerYaw }).map((l) => l.nodeId)).toEqual([String(quay.to)]);
  });
});
