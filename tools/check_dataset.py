"""Validate a dataset: manifest consistency, tile completeness, graph connectivity.

Two layouts are understood:

  python3 tools/check_dataset.py                  # the PUBLISHED layout (SPEC.md section 10.3), default paths
  python3 tools/check_dataset.py --data public/data --server-data server-data [slug ...]
      server-data/<slug>/manifest.json (private, with node keys), public/data/<slug>/world.json,
      public/data/<slug>/map/..., public/data/panos/<key>/..., public/data/worlds.json with "world" entries.
      Also asserts: keys are unique 12-char lowercase base32 across all worlds, world.json matches the private
      manifest, no manifest.json anywhere under public/data, no public/data/<slug>/panos left.

  python3 tools/check_dataset.py out/khorinis     # a raw pipeline output dir (manifest.json + panos/<id>/ + map/)

Exit code 1 on any hard error.
"""
import argparse, collections, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY_RE = re.compile(r'^[a-z2-7]{12}$')
WORLD_FIELDS = ('world', 'name', 'map', 'scoring', 'pano')


def pano_files(pano):
    n = pano['faceSize'] // pano['tileSize']
    return (['base_%s.webp' % f for f in pano['faces']]
            + ['%s_%d_%d.webp' % (f, c, r) for f in pano['faces'] for r in range(n) for c in range(n)])


def count_missing(folder, need):
    try:
        have = set(os.listdir(folder))
    except (FileNotFoundError, NotADirectoryError):
        return len(need)
    return sum(1 for x in need if x not in have)


def check_graph(m, errors, warn):
    nodes = m['nodes']
    for i, nd in enumerate(nodes):
        if nd['id'] != i:
            errors.append('node %d has id %s' % (i, nd['id']))
    # links symmetric and in range
    for nd in nodes:
        for l in nd['links']:
            if not (0 <= l['to'] < len(nodes)):
                errors.append('node %d link out of range %s' % (nd['id'], l['to'])); continue
            if l['to'] == nd['id']:
                errors.append('node %d self link' % nd['id'])
            if not any(b['to'] == nd['id'] for b in nodes[l['to']]['links']):
                errors.append('asymmetric link %d -> %d' % (nd['id'], l['to']))
    # starts
    for s in m['starts']:
        if not (0 <= s < len(nodes)):
            errors.append('start out of range %d' % s)
        elif not nodes[s]['links']:
            errors.append('start %d has no links' % s)
    # connectivity
    par = list(range(len(nodes)))
    def f(x):
        while par[x] != x:
            par[x] = par[par[x]]; x = par[x]
        return x
    for nd in nodes:
        for l in nd['links']:
            if 0 <= l['to'] < len(nodes):
                par[f(nd['id'])] = f(l['to'])
    comp = collections.Counter(f(i) for i in range(len(nodes)))
    big = comp.most_common(1)[0][1] if comp else 0
    isolated = sum(1 for nd in nodes if not nd['links'])
    deg = collections.Counter(len(nd['links']) for nd in nodes)
    print('  nodes %d, starts %d, links %d, components %d (largest %d), isolated %d' % (
        len(nodes), len(m['starts']), sum(len(nd['links']) for nd in nodes) // 2, len(comp), big, isolated))
    print('  degree histogram', sorted(deg.items()))
    print('  outdoor nodes', sum(nd['outdoor'] for nd in nodes))
    if nodes and big < 0.9 * len(nodes):
        warn.append('largest component covers only %.0f%% of nodes' % (100 * big / len(nodes)))


def check_map(m, map_dir, errors):
    mp = m['map']; z = mp['maxZoom']
    nx = -(-mp['width'] // mp['tileSize']); ny = -(-mp['height'] // mp['tileSize'])
    for zz in range(z + 1):
        cx = -(-nx // 2 ** (z - zz)); cy = -(-ny // 2 ** (z - zz))
        for x in range(cx):
            for y in range(cy):
                if not os.path.exists(os.path.join(map_dir, str(zz), str(x), '%d.webp' % y)):
                    errors.append('missing map tile %d/%d/%d' % (zz, x, y)); break


def finish(errors, warn):
    for w in warn:
        print('WARN', w)
    for e in errors[:30]:
        print('ERROR', e)
    if errors:
        print('%d errors' % len(errors)); sys.exit(1)
    print('OK')


def check_raw(path):
    """Pipeline output dir: manifest.json, panos/<id>/, map/."""
    m = json.load(open(os.path.join(path, 'manifest.json')))
    errors, warn = [], []
    check_graph(m, errors, warn)
    need = pano_files(m['pano'])
    missing = sum(count_missing(os.path.join(path, 'panos', str(nd['id'])), need) for nd in m['nodes'])
    if missing:
        errors.append('%d missing pano files' % missing)
    check_map(m, os.path.join(path, 'map'), errors)
    finish(errors, warn)


def check_published(data, server, slugs):
    errors, warn = [], []
    worlds_path = os.path.join(data, 'worlds.json')
    entries = json.load(open(worlds_path))['worlds']
    by_slug = {e['slug']: e for e in entries}
    for e in entries:
        if 'manifest' in e:
            errors.append('worlds.json entry %s still has "manifest"' % e['slug'])
        if e.get('world') != '%s/world.json' % e['slug']:
            errors.append('worlds.json entry %s: world=%r' % (e['slug'], e.get('world')))
    slugs = slugs or [e['slug'] for e in entries]
    key_owner = {}
    referenced = set()
    for slug in slugs:
        print(slug)
        priv = os.path.join(server, slug, 'manifest.json')
        if not os.path.isfile(priv):
            errors.append('%s: no private manifest %s' % (slug, priv)); continue
        if slug not in by_slug:
            errors.append('%s: not listed in worlds.json' % slug)
        m = json.load(open(priv))
        if m.get('world') != slug:
            errors.append('%s: private manifest says world=%r' % (slug, m.get('world')))
        check_graph(m, errors, warn)
        # keys
        for nd in m['nodes']:
            k = nd.get('key', '')
            if not KEY_RE.match(k):
                errors.append('%s: node %d has malformed key %r' % (slug, nd['id'], k)); continue
            if k in key_owner:
                errors.append('%s: node %d key %s already used by %s' % (slug, nd['id'], k, key_owner[k]))
            key_owner[k] = '%s/%d' % (slug, nd['id'])
            referenced.add(k)
        wps = [nd['wp'] for nd in m['nodes']]
        if len(set(wps)) != len(wps):
            errors.append('%s: duplicate waypoint names' % slug)
        # world.json
        wpath = os.path.join(data, slug, 'world.json')
        if not os.path.isfile(wpath):
            errors.append('%s: no %s' % (slug, wpath))
        else:
            w = json.load(open(wpath))
            if sorted(w) != sorted(WORLD_FIELDS):
                errors.append('%s: world.json fields %s' % (slug, sorted(w)))
            if w.get('pano', {}).get('path') != 'panos/{key}':
                errors.append('%s: world.json pano.path=%r' % (slug, w.get('pano', {}).get('path')))
            for f in WORLD_FIELDS:
                if f in w and w[f] != m.get(f):
                    errors.append('%s: world.json %s differs from the private manifest' % (slug, f))
        # panos
        need = pano_files(m['pano'])
        bad = [nd['id'] for nd in m['nodes'] if count_missing(os.path.join(data, 'panos', nd.get('key', '-')), need)]
        if bad:
            errors.append('%s: %d nodes with an incomplete pano folder (ids %s)' % (slug, len(bad), bad[:20]))
        print('  pano folders complete: %d / %d (%d files each)' % (len(m['nodes']) - len(bad), len(m['nodes']), len(need)))
        if os.path.exists(os.path.join(data, slug, 'panos')):
            errors.append('%s: stage-2 folder %s left' % (slug, os.path.join(data, slug, 'panos')))
        check_map(m, os.path.join(data, slug, 'map'), errors)
    # nothing private under public
    for dirpath, _, filenames in os.walk(data):
        if 'manifest.json' in filenames:
            errors.append('full manifest under public: %s' % os.path.join(dirpath, 'manifest.json'))
    panos = os.path.join(data, 'panos')
    if os.path.isdir(panos) and not slugs_given_subset(slugs, entries):
        extra = [d for d in os.listdir(panos) if d not in referenced and not d.startswith('.')]
        if extra:
            warn.append('%d pano folders referenced by no manifest (vanished waypoints; publish_dataset.py --prune)' % len(extra))
    finish(errors, warn)


def slugs_given_subset(slugs, entries):
    return set(slugs) != {e['slug'] for e in entries}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('target', nargs='*', help='a raw pipeline dir (has manifest.json), or world slugs to check')
    ap.add_argument('--data', default=os.path.join(ROOT, 'public', 'data'))
    ap.add_argument('--server-data', default=os.path.join(ROOT, 'server-data'))
    args = ap.parse_args()
    if len(args.target) == 1 and os.path.isfile(os.path.join(args.target[0], 'manifest.json')):
        check_raw(args.target[0])
    else:
        check_published(args.data, args.server_data, args.target)


if __name__ == '__main__':
    main()
