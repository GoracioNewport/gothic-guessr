import zenkit, time, json, sys, collections
from g2env import data_path  # archives under $GOTHIC2_DIR/Data
vfs=zenkit.Vfs()
for d in ['Worlds.vdf','Worlds_Addon.vdf','Meshes.vdf','Meshes_Addon.vdf','Textures.vdf','Textures_Addon.vdf']:
    vfs.mount_disk(data_path(d))
# list worlds
def walk(node, depth=0, out=None):
    out = out if out is not None else []
    for c in node.children:
        if c.is_file(): out.append((c.name, len(c.data)) if c.name.upper().endswith('.ZEN') else (c.name, None))
        else: walk(c, depth+1, out)
    return out
worlds=vfs.resolve('/_WORK/DATA/WORLDS') or vfs.resolve('/_work/Data/Worlds') or vfs.root
zens=[(n,s) for n,s in walk(worlds) if n.upper().endswith('.ZEN')]
print('ZEN files:', len(zens))
for n,s in sorted(zens, key=lambda x:-x[1]): print(f'  {n:40s} {s/1e6:8.1f} MB')
# count meshes/textures
meshes=[n for n,_ in walk(vfs.root) if n.upper().endswith(('.MRM','.MSH','.MDM','.MDL'))]
texs=[n for n,_ in walk(vfs.root) if n.upper().endswith('.TEX')]
print('mesh files:', len(meshes), 'tex files:', len(texs))
t=time.time()
node=vfs.find('NEWWORLD.ZEN')
w=zenkit.World.load(node.open())
print('load world: %.1fs'%(time.time()-t))
m=w.mesh
bb=m.bounding_box
print('mesh name', m.name, 'bbox', bb.min, bb.max)
pos=m.positions; polys=m.polygons
print('positions', len(pos), 'polygons', len(polys), 'materials', len(m.materials), 'lightmaps', len(m.light_maps))
tri=0; big=collections.Counter()
for p in polys:
    k=len(p.position_indices); big[k]+=1; tri+=max(0,k-2)
print('triangles after fan', tri, 'poly vertex-count histogram', dict(sorted(big.items())))
wn=w.way_net
pts=wn.points; edges=wn.edges
fp=sum(1 for p in pts if p.free_point)
print('waypoints', len(pts), 'freepoints among them', fp, 'edges', len(edges))
xs=[p.position.x for p in pts]; ys=[p.position.y for p in pts]; zs=[p.position.z for p in pts]
print('waynet extents x', min(xs), max(xs), ' y', min(ys), max(ys), ' z', min(zs), max(zs))
# vobs
cnt=collections.Counter(); vis=collections.Counter(); total=0
def rec(v):
    global total
    total+=1
    cnt[v.type.name]+=1
    if v.visual is not None and v.visual.name: vis[v.visual.name.upper()]+=1
    for c in v.children: rec(c)
for r in w.root_objects: rec(r)
print('vobs total', total)
print('by type', cnt.most_common(25))
print('distinct visuals', len(vis), 'top', vis.most_common(15))
json.dump({'points':[{'n':p.name,'x':p.position.x,'y':p.position.y,'z':p.position.z,'fp':p.free_point} for p in pts],'edges':[[e.a,e.b] for e in edges]}, open('waynet_newworld.json','w'))
print('names sample', [p.name for p in pts[:15]])
