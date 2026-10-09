"""Re-number rendered panorama folders after the node set of a world changed (e.g. a stricter probe).

LEGACY: only for raw, id-addressed pipeline output (out/<slug>/panos/<id>/) that has not been published yet.
Published data (SPEC.md section 10.3) stores panoramas under public/data/panos/<key>/ with keys stable per
waypoint name, so a changed node set needs no renumbering there: run tools/publish_dataset.py --from <out dir>
<slug> instead (see its docstring). Never point this script at public/data.

Node ids are positions in manifest.nodes, so dropping a node shifts every id after it. Panoramas are
keyed by waypoint name, which is stable, so the folders can be moved instead of re-rendered.

Usage: python tools/remap_panos.py <old_manifest.json> <new_manifest.json> <panos_dir>
  1. folders of nodes that disappeared are deleted,
  2. every remaining folder is renamed old_id -> new_id (via a temporary name, so swaps are safe),
  3. nodes without a folder are reported (they need rendering with g2pipeline --skip-map).
"""
import json, os, shutil, sys


def main(old_path, new_path, panos):
    old = json.load(open(old_path))['nodes']
    new = json.load(open(new_path))['nodes']
    old_by_wp = {}
    for n in old:
        old_by_wp.setdefault(n['wp'], n['id'])   # waypoint names are unique within a world
    new_wps = {n['wp'] for n in new}
    # 1. delete orphans
    removed = 0
    for n in old:
        if n['wp'] not in new_wps:
            d = os.path.join(panos, str(n['id']))
            if os.path.isdir(d):
                shutil.rmtree(d); removed += 1
    # 2. two-phase rename old -> tmp -> new
    moves = []
    for n in new:
        oid = old_by_wp.get(n['wp'])
        if oid is None:
            continue
        if oid != n['id']:
            moves.append((oid, n['id']))
    for oid, nid in moves:
        src = os.path.join(panos, str(oid))
        if os.path.isdir(src):
            os.rename(src, os.path.join(panos, 'tmp_%d' % nid))
    for oid, nid in moves:
        src = os.path.join(panos, 'tmp_%d' % nid)
        if os.path.isdir(src):
            os.rename(src, os.path.join(panos, str(nid)))
    # 3. report missing
    missing = [n['id'] for n in new if not os.path.isdir(os.path.join(panos, str(n['id'])))]
    stray = [d for d in os.listdir(panos) if d.startswith('tmp_')]
    print('removed %d orphan folders, renamed %d, missing %d, stray tmp %d' % (removed, len(moves), len(missing), len(stray)))
    if missing:
        print('missing ids:', missing[:50])
    return 1 if (missing or stray) else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1], sys.argv[2], sys.argv[3]))
