#!/usr/bin/env python3
"""Publish rendered worlds: split them into public files and private server manifests (SPEC.md section 10.3).

Result, per world <slug>:
  server-data/<slug>/manifest.json     PRIVATE full manifest (SPEC section 2) + nodes[i].key; pano.path = 'panos/{key}'
  server-data/<slug>/pano_moves.json   undo log for --rollback (one batch per publish that changed something)
  server-data/<slug>/backup/<stamp>/   whatever a publish displaced: replaced/pruned pano folders, old map, old manifest
  public/data/<slug>/world.json        { world, name, map, scoring, pano } (no nodes, no starts)
  public/data/<slug>/map/...           map tiles (unchanged)
  public/data/panos/<key>/...          pano folders of all worlds in one flat directory, moved with os.rename
  public/data/worlds.json              entries carry "world": "<slug>/world.json" instead of "manifest"
No manifest.json is left anywhere under public/data. Every file in a published pano folder gets one constant
modification time (PUBLISHED_MTIME): render-time mtimes differ per world and follow the render order, so a server's
Last-Modified/ETag would tell where a round starts. Every publish run (including a no-op one) re-applies it to all
nodes of the worlds it processes.

A node key is 12 random lowercase base32 characters (secrets module). Keys are stable per waypoint name: when a
private manifest already exists, a node keeps the key of the same 'wp' (new waypoints get new keys, keys are unique
across all worlds). Node ids may change between renders; the published folders do not care.

Usage (python3, stdlib only; paths default to the repository's public/data and server-data):

  python3 tools/publish_dataset.py --dry-run          # plan only: counts per world, nothing is touched
  python3 tools/publish_dataset.py                    # publish in place: public/data/<slug>/{manifest.json,panos/<id>}
                                                      #   (the stage-2 layout) -> the layout above
  python3 tools/publish_dataset.py --from out valley  # publish a pipeline output dir: out/<slug>/manifest.json,
                                                      #   out/<slug>/panos/<id>/, optional out/<slug>/map/
  python3 tools/publish_dataset.py --rollback [slug]  # undo the last publish batch of each world (repeatable)

Re-rendering a world later (replaces tools/remap_panos.py for published data):
  1. python tools/g2pipeline.py --world OLDWORLD.ZEN --slug valley --name "Valley of Mines" --out out [--skip-map]
     The output dir only needs the panoramas you want to (re)render; render a subset with --near/--limit, or none
     with --skip-panos when only the graph changed.
  2. python3 tools/publish_dataset.py --from out valley --dry-run, then without --dry-run.
     For every node: a folder out/valley/panos/<id> is moved to public/data/panos/<key> (an existing published
     folder for that key is moved to the backup first); a node without a fresh folder keeps its published one;
     a node with neither aborts the publish before anything is changed. out/valley/map, if present, replaces the
     published map. Waypoints that disappeared keep their public folder unless --prune moves it to the backup.
  3. python3 tools/check_dataset.py   (validates the whole published layout)
  Backups are never deleted automatically; remove server-data/<slug>/backup/<stamp> once the new data is fine.

The script is idempotent: a second run with the same input changes nothing and says so. It is also restartable: if
it stops halfway, run it again with the same arguments (the private manifest and the undo log are written before
anything is moved).
"""
import argparse
import datetime
import json
import os
import re
import secrets
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
KEY_RE = re.compile(r'^[a-z2-7]{12}$')
PUBLIC_PANO_PATH = 'panos/{key}'
STAGE2_PANO_PATH = 'panos/{id}'
WORLD_FIELDS = ('world', 'name', 'map', 'scoring', 'pano')
# 2026-01-01T00:00:00Z: the mtime (atime too) of every published pano file, see the module docstring.
PUBLISHED_MTIME = 1767225600


class Fail(Exception):
    pass


# ---------------------------------------------------------------------------------------------------------------
# helpers


def read_json(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def write_text(path, text):
    """Atomic write (tmp + rename)."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(text)
    os.replace(tmp, path)


def read_text(path):
    if not os.path.exists(path):
        return None
    with open(path, encoding='utf-8') as f:
        return f.read()


def manifest_text(m):
    return json.dumps(m, ensure_ascii=False)


def pretty(obj):
    return json.dumps(obj, ensure_ascii=False, indent=2) + '\n'


def worlds_text(doc):
    """worlds.json in its hand-written style: one entry per line."""
    lines = ['  { ' + json.dumps(e, ensure_ascii=False)[1:-1] + ' }' for e in doc['worlds']]
    rest = {k: v for k, v in doc.items() if k != 'worlds'}
    head = ''.join('  %s: %s,\n' % (json.dumps(k), json.dumps(v, ensure_ascii=False)) for k, v in rest.items())
    return '{\n' + head + '  "worlds": [\n  ' + ',\n  '.join(lines) + '\n  ]\n}\n'


def rel(path):
    """Repository-relative path when inside the repository (keeps the undo log portable), else absolute."""
    path = os.path.abspath(path)
    r = os.path.relpath(path, ROOT)
    return path if r.startswith('..') else r


def unrel(path):
    return path if os.path.isabs(path) else os.path.join(ROOT, path)


def pano_files(pano):
    """File names every pano folder must contain (6 base faces + nbTiles^2 tiles per face)."""
    n = pano['faceSize'] // pano['tileSize']
    return ([pano['base'].format(face=f) for f in pano['faces']]
            + [pano['tile'].format(face=f, col=c, row=r) for f in pano['faces'] for r in range(n) for c in range(n)])


def pano_complete(d, files):
    try:
        have = set(os.listdir(d))
    except (FileNotFoundError, NotADirectoryError):
        return False
    return all(f in have for f in files)


def new_key(taken):
    while True:
        k = ''.join(secrets.choice(ALPHABET) for _ in range(12))
        if k not in taken:
            taken.add(k)
            return k


def private_manifest(src, keys):
    """Full manifest + node keys; pano.path points at the flat key-addressed folders."""
    m = {k: v for k, v in src.items()}
    m['pano'] = dict(src['pano'], path=PUBLIC_PANO_PATH)
    nodes = []
    for n in src['nodes']:
        rest = {k: v for k, v in n.items() if k not in ('id', 'key')}
        nodes.append(dict(id=n['id'], key=keys[n['wp']], **rest))
    m['nodes'] = nodes
    return m


def stage2_manifest(m):
    """Inverse of private_manifest (for --rollback of an in-place publish)."""
    out = dict(m)
    out['pano'] = dict(m['pano'], path=STAGE2_PANO_PATH)
    out['nodes'] = [{k: v for k, v in n.items() if k != 'key'} for n in m['nodes']]
    return out


def world_json(m):
    return {f: m[f] for f in WORLD_FIELDS}


def entry_to_world(e, slug):
    out = {}
    for k, v in e.items():
        if k == 'manifest':
            out['world'] = '%s/world.json' % slug
        else:
            out[k] = v
    out.setdefault('world', '%s/world.json' % slug)
    return out


def entry_to_manifest(e, slug):
    return {('manifest' if k == 'world' else k): ('%s/manifest.json' % slug if k == 'world' else v) for k, v in e.items()}


def find_manifests_under(path):
    found = []
    for dirpath, _, filenames in os.walk(path):
        if 'manifest.json' in filenames:
            found.append(os.path.join(dirpath, 'manifest.json'))
    return found


class Ctx:
    def __init__(self, args):
        self.data = os.path.abspath(args.data)
        self.server = os.path.abspath(args.server_data)
        self.source = os.path.abspath(args.source or args.data)
        self.inplace = os.path.realpath(self.source) == os.path.realpath(self.data)
        self.dry = args.dry_run
        self.prune = args.prune
        self.panos = os.path.join(self.data, 'panos')
        self.worlds_path = os.path.join(self.data, 'worlds.json')

    def private_path(self, slug):
        return os.path.join(self.server, slug, 'manifest.json')

    def log_path(self, slug):
        return os.path.join(self.server, slug, 'pano_moves.json')


def all_taken_keys(ctx):
    taken = set()
    if os.path.isdir(ctx.server):
        for slug in os.listdir(ctx.server):
            p = ctx.private_path(slug)
            if os.path.isfile(p):
                taken.update(n['key'] for n in read_json(p)['nodes'] if 'key' in n)
    if os.path.isdir(ctx.panos):
        taken.update(os.listdir(ctx.panos))
    return taken


def default_slugs(ctx):
    slugs = []
    if os.path.isfile(ctx.worlds_path):
        slugs += [e['slug'] for e in read_json(ctx.worlds_path)['worlds']]
    if os.path.isdir(ctx.source):
        for d in sorted(os.listdir(ctx.source)):
            if os.path.isfile(os.path.join(ctx.source, d, 'manifest.json')) and d not in slugs:
                slugs.append(d)
    return slugs


# ---------------------------------------------------------------------------------------------------------------
# publish


def plan_world(ctx, slug, taken, worlds_doc):
    priv_path = ctx.private_path(slug)
    prev = read_json(priv_path) if os.path.isfile(priv_path) else None
    src_dir = os.path.join(ctx.source, slug)
    src_path = os.path.join(src_dir, 'manifest.json')
    if os.path.isfile(src_path):
        src = read_json(src_path)
    elif prev is not None and ctx.inplace:
        src = prev                                        # already published: re-derive everything from it
    else:
        raise Fail('%s: no manifest at %s' % (slug, src_path))
    if src.get('world') != slug:
        raise Fail('%s: manifest says world=%r' % (slug, src.get('world')))
    for i, n in enumerate(src['nodes']):
        if n['id'] != i:
            raise Fail('%s: node %d has id %s' % (slug, i, n['id']))
    wps = [n['wp'] for n in src['nodes']]
    if len(set(wps)) != len(wps):
        raise Fail('%s: duplicate waypoint names, keys would not be stable' % slug)

    prev_keys = {n['wp']: n['key'] for n in prev['nodes']} if prev else {}
    for k in prev_keys.values():
        if not KEY_RE.match(k):
            raise Fail('%s: malformed key %r in %s' % (slug, k, priv_path))
    keys, reused = {}, 0
    for wp in wps:
        if wp in prev_keys:
            keys[wp] = prev_keys[wp]; reused += 1
        else:
            keys[wp] = new_key(taken)
    m = private_manifest(src, keys)
    text = manifest_text(m)
    files = pano_files(m['pano'])

    src_panos = os.path.join(src_dir, 'panos')
    if not ctx.inplace and os.path.isdir(os.path.join(ctx.data, slug, 'panos')):
        raise Fail('%s: %s still has the stage-2 layout; publish it in place first (without --from)'
                   % (slug, os.path.join(ctx.data, slug)))
    moves, replaced, kept, missing, broken = [], [], 0, [], []
    for n in m['nodes']:
        s = os.path.join(src_panos, str(n['id']))
        d = os.path.join(ctx.panos, n['key'])
        if os.path.isdir(s):
            if not pano_complete(s, files):
                broken.append(n['id'])
                continue
            moves.append((n['id'], n['key']))
            if os.path.exists(d):
                replaced.append(n['key'])
        elif pano_complete(d, files):
            kept += 1
        else:
            missing.append(n['id'])
    ids = {str(n['id']) for n in m['nodes']}
    stray = sorted(x for x in os.listdir(src_panos) if x not in ids) if os.path.isdir(src_panos) else []
    new_wps = set(wps)
    orphans = sorted(k for wp, k in prev_keys.items() if wp not in new_wps and os.path.isdir(os.path.join(ctx.panos, k)))

    map_src = os.path.join(src_dir, 'map')
    map_dst = os.path.join(ctx.data, slug, 'map')
    map_move = not ctx.inplace and os.path.isdir(map_src)
    errors = []
    if missing:
        errors.append('%d nodes have no complete pano folder (ids %s)' % (len(missing), missing[:20]))
    if broken:
        errors.append('%d source pano folders are incomplete (ids %s)' % (len(broken), broken[:20]))
    if stray:
        errors.append('%d source pano folders match no node (%s); delete or re-render them' % (len(stray), stray[:20]))
    if not map_move and not os.path.isdir(map_dst):
        errors.append('no map at %s' % map_dst)

    entry = next((e for e in worlds_doc['worlds'] if e['slug'] == slug), None)
    return dict(slug=slug, prev=prev, manifest=m, text=text, files=files, src_dir=src_dir, src_panos=src_panos,
                moves=moves, replaced=replaced, kept=kept, reused=reused, new=len(wps) - reused,
                orphans=orphans if ctx.prune else [], orphans_kept=[] if ctx.prune else orphans,
                map_move=map_move, map_src=map_src, map_dst=map_dst,
                manifest_changed=read_text(priv_path) != text, added_entry=entry is None,
                public_manifest=os.path.join(ctx.data, slug, 'manifest.json'), errors=errors)


def report(p):
    m = p['manifest']
    print('%s: %d nodes, %d starts; keys reused %d, new %d' % (p['slug'], len(m['nodes']), len(m['starts']), p['reused'], p['new']))
    print('  panos: move %d (replacing %d), already published %d%s' % (
        len(p['moves']), len(p['replaced']), p['kept'],
        ', prune %d' % len(p['orphans']) if p['orphans'] else ''))
    if p['orphans_kept']:
        print('  %d published folders belong to waypoints that disappeared (kept; --prune moves them to the backup)' % len(p['orphans_kept']))
    changes = []
    if p['manifest_changed']:
        changes.append('private manifest ' + ('updated' if p['prev'] else 'created'))
    if p['map_move']:
        changes.append('map %s from %s' % ('replaced' if os.path.isdir(p['map_dst']) else 'moved in', rel(p['map_src'])))
    if os.path.exists(p['public_manifest']):
        changes.append('public manifest.json removed')
    if p['added_entry']:
        changes.append('worlds.json entry added')
    if changes:
        print('  ' + ', '.join(changes))
    for e in p['errors']:
        print('  ERROR', e)


def apply_world(ctx, p, stamp):
    slug = p['slug']
    sdir = os.path.join(ctx.server, slug)
    backup = os.path.join(sdir, 'backup', stamp)
    displaces = p['replaced'] or p['orphans'] or (p['map_move'] and os.path.isdir(p['map_dst'])) or \
        (p['prev'] is not None and p['manifest_changed'])
    need_batch = bool(p['moves'] or p['orphans'] or p['map_move'] or p['manifest_changed'])
    os.makedirs(sdir, exist_ok=True)
    if displaces:
        os.makedirs(backup, exist_ok=True)
    # 1. undo log + private manifest first: a crash below leaves a state that a re-run (or --rollback) completes
    if need_batch:
        batch = dict(at=stamp, source=rel(ctx.source), inplace=ctx.inplace,
                     moves={str(i): k for i, k in p['moves']},
                     backup=('backup/' + stamp) if displaces else None,
                     prevManifest=p['prev'] is not None and p['manifest_changed'],
                     mapMoved=p['map_move'], addedEntry=p['added_entry'])
        log_path = ctx.log_path(slug)
        log = read_json(log_path) if os.path.isfile(log_path) else dict(slug=slug, batches=[])
        log['batches'].append(batch)
        if batch['prevManifest']:
            shutil.copy2(ctx.private_path(slug), os.path.join(backup, 'manifest.json'))
        write_text(log_path, pretty(log))
    if p['manifest_changed']:
        write_text(ctx.private_path(slug), p['text'])
    # 2. panoramas
    os.makedirs(ctx.panos, exist_ok=True)
    for key in p['replaced'] + p['orphans']:
        os.makedirs(os.path.join(backup, 'panos'), exist_ok=True)
        d = os.path.join(ctx.panos, key)
        if os.path.exists(d):
            os.rename(d, os.path.join(backup, 'panos', key))
    for i, key in p['moves']:
        os.rename(os.path.join(p['src_panos'], str(i)), os.path.join(ctx.panos, key))
    # 3. map
    if p['map_move']:
        if os.path.isdir(p['map_dst']):
            os.rename(p['map_dst'], os.path.join(backup, 'map'))
        os.makedirs(os.path.dirname(p['map_dst']), exist_ok=True)
        os.rename(p['map_src'], p['map_dst'])
    # 4. public world descriptor
    write_if_changed(os.path.join(ctx.data, slug, 'world.json'), pretty(world_json(p['manifest'])))


def write_if_changed(path, text):
    if read_text(path) == text:
        return False
    write_text(path, text)
    return True


def update_worlds(ctx, plans):
    doc = read_json(ctx.worlds_path) if os.path.isfile(ctx.worlds_path) else {'worlds': []}
    by_slug = {p['slug']: p for p in plans}
    out = []
    for e in doc['worlds']:
        out.append(entry_to_world(e, e['slug']) if e['slug'] in by_slug else e)
    for p in plans:
        if p['added_entry']:
            out.append(dict(slug=p['slug'], name=p['manifest']['name'], description='',
                            world='%s/world.json' % p['slug'], thumbnail='%s/map/0/0/0.webp' % p['slug']))
    doc = dict(doc, worlds=out)
    return doc


def verify_world(ctx, p):
    """The private copy must be exactly what was planned and every node must resolve to a complete public folder."""
    errors = []
    if read_text(ctx.private_path(p['slug'])) != p['text']:
        errors.append('private manifest differs from the plan')
    m = read_json(ctx.private_path(p['slug']))
    if len(m['nodes']) != len(p['manifest']['nodes']) or m['starts'] != p['manifest']['starts']:
        errors.append('private manifest nodes/starts mismatch')
    bad = [n['id'] for n in m['nodes'] if not KEY_RE.match(n.get('key', '')) or not pano_complete(os.path.join(ctx.panos, n['key']), p['files'])]
    if bad:
        errors.append('%d nodes without a complete public folder (ids %s)' % (len(bad), bad[:20]))
    w = read_json(os.path.join(ctx.data, p['slug'], 'world.json'))
    if w != world_json(m):
        errors.append('world.json does not match the private manifest')
    return errors


def stale_mtimes(ctx, p):
    """Published pano files of the world whose mtime is not PUBLISHED_MTIME."""
    out = []
    for n in p['manifest']['nodes']:
        d = os.path.join(ctx.panos, n['key']) if n.get('key') else None
        if not d or not os.path.isdir(d):
            continue
        for name in os.listdir(d):
            f = os.path.join(d, name)
            if os.path.isfile(f) and int(os.stat(f).st_mtime) != PUBLISHED_MTIME:
                out.append(f)
    return out


def normalise_mtimes(ctx, p):
    files = stale_mtimes(ctx, p)
    for f in files:
        os.utime(f, (PUBLISHED_MTIME, PUBLISHED_MTIME))
    return len(files)


def publish(ctx, slugs):
    taken = all_taken_keys(ctx)
    worlds_doc = read_json(ctx.worlds_path) if os.path.isfile(ctx.worlds_path) else {'worlds': []}
    plans = [plan_world(ctx, s, taken, worlds_doc) for s in slugs]
    for p in plans:
        report(p)
    new_worlds = update_worlds(ctx, plans)
    worlds_changed = read_text(ctx.worlds_path) != worlds_text(new_worlds)
    if worlds_changed:
        print('worlds.json: updated (entries point at <slug>/world.json)')
    if any(p['errors'] for p in plans):
        print('nothing changed: fix the errors above first')
        return 1
    if ctx.dry:
        for p in plans:
            if not p['moves']:
                stale = len(stale_mtimes(ctx, p))
                if stale:
                    print('%s: %d published pano files would get the constant mtime' % (p['slug'], stale))
        print('dry run: nothing changed')
        return 0
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    for p in plans:
        apply_world(ctx, p, stamp)
    if worlds_changed:
        write_text(ctx.worlds_path, worlds_text(new_worlds))
    rc = 0
    removed = 0
    retimed = 0
    for p in plans:
        errs = verify_world(ctx, p)
        for e in errs:
            print('VERIFY %s: %s' % (p['slug'], e))
        if errs:
            rc = 1
            continue
        touched = normalise_mtimes(ctx, p)
        if touched:
            print('%s: set the constant mtime on %d pano files' % (p['slug'], touched))
            retimed += touched
        if os.path.exists(p['public_manifest']):
            os.remove(p['public_manifest']); removed += 1
        if os.path.isdir(p['src_panos']):
            try:
                os.rmdir(p['src_panos'])
            except OSError:
                print('WARN %s is not empty' % p['src_panos']); rc = 1
    left = find_manifests_under(ctx.data)
    for f in left:
        print('ERROR full manifest left under public: %s' % f); rc = 1
    changed = any(p['moves'] or p['orphans'] or p['map_move'] or p['manifest_changed'] for p in plans) or worlds_changed or removed or retimed
    print('verified %d worlds%s' % (len(plans), '' if changed else ' (nothing to do, already published)') if rc == 0 else 'verification FAILED')
    return rc


# ---------------------------------------------------------------------------------------------------------------
# rollback


def rollback(ctx, slugs):
    rc = 0
    worlds_doc = read_json(ctx.worlds_path) if os.path.isfile(ctx.worlds_path) else {'worlds': []}
    worlds_dirty = False
    for slug in slugs:
        log_path = ctx.log_path(slug)
        if not os.path.isfile(log_path):
            print('%s: no undo log, skipped' % slug); continue
        log = read_json(log_path)
        if not log['batches']:
            print('%s: undo log empty, skipped' % slug); continue
        b = log['batches'][-1]
        source = unrel(b['source'])
        backup = os.path.join(ctx.server, slug, b['backup']) if b['backup'] else None
        moves = b['moves']
        print('%s: undo publish %s from %s: %d pano folders back%s' % (
            slug, b['at'], b['source'], len(moves), ', restore backup' if backup else ''))
        if ctx.dry:
            continue
        # panoramas back to the source, then displaced folders back to public
        missing = 0
        for i, key in moves.items():
            s = os.path.join(ctx.panos, key)
            d = os.path.join(source, slug, 'panos', i)
            if os.path.isdir(s) and not os.path.exists(d):
                os.makedirs(os.path.dirname(d), exist_ok=True)
                os.rename(s, d)
            elif not os.path.isdir(d):
                missing += 1
        if missing:
            print('  WARN %d moved folders were not found' % missing); rc = 1
        if backup and os.path.isdir(os.path.join(backup, 'panos')):
            for key in os.listdir(os.path.join(backup, 'panos')):
                os.rename(os.path.join(backup, 'panos', key), os.path.join(ctx.panos, key))
        if b['mapMoved']:
            map_dst = os.path.join(ctx.data, slug, 'map')
            if os.path.isdir(map_dst):
                os.rename(map_dst, os.path.join(source, slug, 'map'))
            if backup and os.path.isdir(os.path.join(backup, 'map')):
                os.rename(os.path.join(backup, 'map'), map_dst)
        if b['prevManifest'] and backup:
            os.replace(os.path.join(backup, 'manifest.json'), ctx.private_path(slug))
        m = read_json(ctx.private_path(slug))
        world_path = os.path.join(ctx.data, slug, 'world.json')
        if b['inplace']:
            # back to the stage-2 layout: public manifest, worlds.json "manifest", no world.json
            write_text(os.path.join(ctx.data, slug, 'manifest.json'), manifest_text(stage2_manifest(m)))
            if os.path.exists(world_path):
                os.remove(world_path)
            worlds_doc['worlds'] = [entry_to_manifest(e, slug) if e['slug'] == slug else e for e in worlds_doc['worlds']]
            worlds_dirty = True
        elif b['addedEntry'] and not b['prevManifest']:
            if os.path.exists(world_path):
                os.remove(world_path)
            worlds_doc['worlds'] = [e for e in worlds_doc['worlds'] if e['slug'] != slug]
            worlds_dirty = True
        else:
            write_if_changed(world_path, pretty(world_json(m)))
        if backup and os.path.isdir(backup):
            if _only_empty_dirs(backup):
                shutil.rmtree(backup)
                try:
                    os.rmdir(os.path.dirname(backup))
                except OSError:
                    pass
            else:
                print('  WARN backup not empty: %s' % backup); rc = 1
        log['batches'].pop()
        if log['batches']:
            write_text(log_path, pretty(log))
        else:
            os.remove(log_path)
    if worlds_dirty and not ctx.dry:
        write_text(ctx.worlds_path, worlds_text(worlds_doc))
    if os.path.isdir(ctx.panos) and not os.listdir(ctx.panos) and not ctx.dry:
        os.rmdir(ctx.panos)
    print('rollback done' if rc == 0 else 'rollback finished with warnings')
    return rc


def _only_empty_dirs(path):
    for _, _, files in os.walk(path):
        if files:
            return False
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('slugs', nargs='*', help='worlds to process (default: worlds.json + worlds found in the source)')
    ap.add_argument('--from', dest='source', help='pipeline output dir with <slug>/manifest.json (default: --data, in place)')
    ap.add_argument('--data', default=os.path.join(ROOT, 'public', 'data'), help='public data dir')
    ap.add_argument('--server-data', default=os.path.join(ROOT, 'server-data'), help='private data dir')
    ap.add_argument('--dry-run', action='store_true', help='print the plan, change nothing')
    ap.add_argument('--prune', action='store_true', help='move public folders of vanished waypoints to the backup')
    ap.add_argument('--rollback', action='store_true', help='undo the last publish batch of each world')
    args = ap.parse_args()
    ctx = Ctx(args)
    try:
        if args.rollback:
            slugs = args.slugs
            if not slugs and os.path.isdir(ctx.server):
                slugs = sorted(s for s in os.listdir(ctx.server) if os.path.isfile(ctx.log_path(s)))
            return rollback(ctx, slugs)
        slugs = args.slugs or default_slugs(ctx)
        if not slugs:
            raise Fail('no worlds found in %s' % ctx.source)
        return publish(ctx, slugs)
    except Fail as e:
        print('ERROR', e)
        return 1


if __name__ == '__main__':
    sys.exit(main())
