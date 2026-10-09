import zenkit, collections, time
from g2env import data_path  # archives under $GOTHIC2_DIR/Data
vfs=zenkit.Vfs()
for d in ['Worlds.vdf','Worlds_Addon.vdf','Meshes.vdf','Meshes_Addon.vdf','Textures.vdf','Textures_Addon.vdf']:
    vfs.mount_disk(data_path(d))
w=zenkit.World.load(vfs.find('NEWWORLD.ZEN').open())
m=w.mesh
pos=m.positions
xs=[p.x for p in pos]; ys=[p.y for p in pos]; zs=[p.z for p in pos]
print('MESH extents x %.0f..%.0f  y %.0f..%.0f  z %.0f..%.0f (cm)'%(min(xs),max(xs),min(ys),max(ys),min(zs),max(zs)))
print('=> world ~ %.0f m x %.0f m'%((max(xs)-min(xs))/100,(max(zs)-min(zs))/100))
mats=m.materials
print('material sample:', [(mt.name, mt.texture, mt.group.name if hasattr(mt.group,'name') else mt.group) for mt in mats[:5]])
texnames=collections.Counter()
for p in m.polygons: texnames[mats[p.material_index].texture.upper()]+=1
print('distinct world textures', len(texnames))
# texture sizes
def texfile(n):
    base=n.rsplit('.',1)[0]
    return vfs.find(base+'-C.TEX')
found=0; miss=[]; raw=0; fmts=collections.Counter(); dims=collections.Counter()
for n in texnames:
    if not n: continue
    node=texfile(n)
    if node is None: miss.append(n); continue
    found+=1
    t=zenkit.Texture.load(node.open())
    fmts[t.format.name]+=1; dims[(t.width,t.height)]+=1; raw+=len(node.data)
print('world textures found', found, 'missing', len(miss), miss[:10])
print('formats', fmts.most_common(6)); print('dims', dims.most_common(8)); print('world tex bytes on disk (DXT) %.1f MB'%(raw/1e6))
# VOB visuals -> MRM meshes
vis=collections.Counter()
def rec(v):
    if v.visual is not None and v.visual.name and v.visual.type.name in ('MULTI_RESOLUTION_MESH','MESH','MODEL','MORPH_MESH'):
        vis[v.visual.name.upper()]+=1
    for c in v.children: rec(c)
for r in w.root_objects: rec(r)
print('visual types used:', collections.Counter())
tri_total=0; inst_total=0; miss=0; vtex=set(); vbytes=0; loaded=0; t0=time.time()
for name,count in vis.items():
    base=name.rsplit('.',1)[0]
    node=vfs.find(base+'.MRM')
    if node is None:
        node=vfs.find(base+'.MDM') or vfs.find(base+'.MDL')
        if node is None: miss+=count; continue
        continue  # skip model types in this estimate
    try:
        mrm=zenkit.MultiResolutionMesh.load(node.open())
    except Exception as e:
        miss+=count; continue
    loaded+=1
    tris=sum(len(sm.triangles) for sm in mrm.submeshes)
    for sm in mrm.submeshes:
        if sm.material.texture: vtex.add(sm.material.texture.upper())
    tri_total+=tris*count; inst_total+=count
print('MRM visuals loaded %d (%.1fs), instances %d, instanced triangles %d, instances missing/skipped %d'%(loaded,time.time()-t0,inst_total,tri_total,miss))
print('distinct vob textures', len(vtex), 'union with world', len(vtex|set(texnames)))
for n in vtex:
    node=texfile(n)
    if node: vbytes+=len(node.data)
print('vob tex bytes on disk %.1f MB'%(vbytes/1e6))
# in-game map textures
maps=[n.name for n in vfs.root.children] 
def walk(node,out):
    for c in node.children:
        if c.is_file(): out.append(c)
        else: walk(c,out)
allf=[]; walk(vfs.root,allf)
mapfiles=[f for f in allf if 'MAP' in f.name.upper() and f.name.upper().endswith('.TEX')]
print('map textures:', [(f.name,len(f.data)) for f in mapfiles][:30])
from PIL import Image
for f in mapfiles:
    if 'NEWWORLD' in f.name.upper() or 'KHORINIS' in f.name.upper() or 'ADDON' in f.name.upper():
        t=zenkit.Texture.load(f.open())
        img=Image.frombytes('RGBA',(t.width,t.height),t.mipmap_rgba(0))
        img.save('map_'+f.name.split('.')[0]+'.png'); print('saved', f.name, t.width, t.height, t.format.name)
