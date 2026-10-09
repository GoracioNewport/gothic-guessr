"""Proof-of-concept offline renderer for Gothic II worlds: top-down ortho map + cubemap/equirect panoramas.
Uses zenkit (parsing) + moderngl (headless OpenGL on macOS)."""
import zenkit, numpy as np, moderngl, time, sys, json, collections, math
from PIL import Image, ImageDraw
from g2env import data_path  # archives under $GOTHIC2_DIR/Data
WORLD = sys.argv[1] if len(sys.argv)>1 else 'NEWWORLD.ZEN'
t0=time.time()
def log(*a): print('[%6.1fs]'%(time.time()-t0), *a, flush=True)

vfs=zenkit.Vfs()
for d in ['Worlds.vdf','Worlds_Addon.vdf','Meshes.vdf','Meshes_Addon.vdf','Textures.vdf','Textures_Addon.vdf']:
    vfs.mount_disk(data_path(d))
w=zenkit.World.load(vfs.find(WORLD).open())
m=w.mesh
log('world loaded')

# ---------- world mesh -> per-texture triangle arrays ----------
P=np.array([(p.x,p.y,p.z) for p in m.positions],dtype=np.float32)
feats=m.features
UV=np.array([(f.texture.x,f.texture.y) for f in feats],dtype=np.float32)
NR=np.array([(f.normal.x,f.normal.y,f.normal.z) for f in feats],dtype=np.float32)
bounds=dict(minx=float(P[:,0].min()),maxx=float(P[:,0].max()),minz=float(P[:,2].min()),maxz=float(P[:,2].max()),miny=float(P[:,1].min()),maxy=float(P[:,1].max()))
json.dump(bounds,open('bounds_%s.json'%WORLD.split('.')[0],'w'))
# ZenGin is left-handed (D3D): mirror X so that standard right-handed camera math yields an un-mirrored image
P[:,0]*=-1; NR[:,0]*=-1
mats=m.materials
mat_tex=[mt.texture.upper() for mt in mats]
mat_group=[int(mt.group) for mt in mats]   # 5 == WATER in zenkit? check below
log('arrays', len(P), len(UV))
by_tex=collections.defaultdict(lambda: ([],[]))  # tex -> (pos idx list, feat idx list)
water_tex=set()
for p in m.polygons:
    if p.is_portal or p.is_ghost_occluder: continue
    pi=p.position_indices; fi=p.feature_indices; n=len(pi)
    if n<3: continue
    tex=mat_tex[p.material_index]
    if mat_group[p.material_index]==5: water_tex.add(tex)
    pl,fl=by_tex[tex]
    for k in range(1,n-1):
        pl.extend((pi[0],pi[k],pi[k+1])); fl.extend((fi[0],fi[k],fi[k+1]))
log('world polys grouped into', len(by_tex), 'textures; water textures', water_tex)

# ---------- VOBs with MRM visuals -> instances ----------
inst=collections.defaultdict(list)   # visual name -> list of 4x4 matrices
skipped=collections.Counter()
def rec(v):
    vis=v.visual
    if vis is not None and vis.name and v.show_visual:
        name=vis.name.upper()
        if name.endswith('.3DS'):
            cols=v.rotation.columns
            R=np.array([[c.x,c.y,c.z] for c in cols],dtype=np.float32).T   # columns -> matrix columns
            M=np.eye(4,dtype=np.float32); M[:3,:3]=R; M[:3,3]=(v.position.x,v.position.y,v.position.z)
            M[0,:]*=-1   # mirror X (left-handed -> right-handed)
            inst[name].append(M)
        else:
            skipped[name.rsplit('.',1)[-1]]+=1
    for c in v.children: rec(c)
for r in w.root_objects: rec(r)
log('vob instances', sum(len(x) for x in inst.values()), 'distinct', len(inst), 'skipped visual exts', skipped.most_common(6))

# verify rotation convention against stored world-space bbox of a few vobs
def check_rot():
    good=bad=0
    for name,ms in list(inst.items())[:40]:
        node=vfs.find(name.rsplit('.',1)[0]+'.MRM')
        if node is None: continue
        mrm=zenkit.MultiResolutionMesh.load(node.open())
        pts=np.array([(p.x,p.y,p.z) for p in mrm.positions],dtype=np.float32)
        if len(pts)==0: continue
        M=ms[0]
        a=(pts@M[:3,:3].T)+M[:3,3]; b=(pts@M[:3,:3])+M[:3,3]
        # compare extents to vob bbox is not accessible here (we lost the vob); instead just report tilt of tree-like objects
        return
check_rot()

# ---------- geometry upload ----------
ctx=moderngl.create_standalone_context()
prog=ctx.program(vertex_shader='''
#version 330
uniform mat4 vp; uniform int instanced;
in vec3 in_pos; in vec2 in_uv; in vec3 in_nrm; in mat4 in_model;
out vec2 v_uv; out vec3 v_nrm; out float v_dist;
void main(){
  mat4 M = instanced==1 ? in_model : mat4(1.0);
  vec4 wp = M*vec4(in_pos,1.0);
  v_uv=in_uv; v_nrm=normalize(mat3(M)*in_nrm);
  gl_Position = vp*wp; v_dist=length(gl_Position.xyz);
}''', fragment_shader='''
#version 330
uniform sampler2D tex; uniform vec3 sun; uniform int is_water; uniform vec3 fogcol; uniform float fogk;
in vec2 v_uv; in vec3 v_nrm; in float v_dist; out vec4 f;
void main(){
  vec4 c=texture(tex,v_uv);
  if(c.a<0.5) discard;
  float l=0.55+0.45*max(dot(normalize(v_nrm),sun),0.0);
  vec3 col=c.rgb*l;
  if(is_water==1) col=mix(col,vec3(0.15,0.35,0.5),0.5);
  float fg=1.0-exp(-v_dist*fogk);
  f=vec4(mix(col,fogcol,fg),1.0);
}''')
prog['tex']=0
tex_cache={}
white=ctx.texture((1,1),4,bytes([200,200,200,255]))
def get_tex(name):
    if name in tex_cache: return tex_cache[name]
    node=vfs.find(name.rsplit('.',1)[0]+'-C.TEX') if name else None
    if node is None: tex_cache[name]=white; return white
    t=zenkit.Texture.load(node.open())
    lvl=0
    tx=ctx.texture((t.width_mipmap(lvl),t.height_mipmap(lvl)),4,t.mipmap_rgba(lvl))
    tx.build_mipmaps(); tx.filter=(moderngl.LINEAR_MIPMAP_LINEAR,moderngl.LINEAR); tx.anisotropy=8.0
    tex_cache[name]=tx; return tx

draws=[]  # (vao, tex, is_water, n_instances)
for tex,(pl,fl) in by_tex.items():
    pl=np.array(pl,dtype=np.int32); fl=np.array(fl,dtype=np.int32)
    data=np.hstack([P[pl],UV[fl],NR[fl]]).astype(np.float32)
    vbo=ctx.buffer(data.tobytes())
    vao=ctx.vertex_array(prog,[(vbo,'3f 2f 3f','in_pos','in_uv','in_nrm')])
    draws.append((vao,get_tex(tex),tex in water_tex,0))
log('world vaos', len(draws), 'textures', len(tex_cache))
tri_inst=0
for name,ms in inst.items():
    node=vfs.find(name.rsplit('.',1)[0]+'.MRM')
    if node is None: continue
    mrm=zenkit.MultiResolutionMesh.load(node.open())
    pts=np.array([(p.x,p.y,p.z) for p in mrm.positions],dtype=np.float32)
    Mi=np.array(ms,dtype=np.float32)            # N x 4 x 4
    ibuf=ctx.buffer(np.ascontiguousarray(np.transpose(Mi,(0,2,1))).tobytes())  # column-major per instance
    for sm in mrm.submeshes:
        wd=sm.wedges
        widx=np.array([x.index for x in wd],dtype=np.int32)
        wuv=np.array([(x.texture.x,x.texture.y) for x in wd],dtype=np.float32)
        wn=np.array([(x.normal.x,x.normal.y,x.normal.z) for x in wd],dtype=np.float32)
        tri=np.array([t.wedges for t in sm.triangles],dtype=np.int32).reshape(-1)
        if len(tri)==0: continue
        data=np.hstack([pts[widx[tri]],wuv[tri],wn[tri]]).astype(np.float32)
        vbo=ctx.buffer(data.tobytes())
        vao=ctx.vertex_array(prog,[(vbo,'3f 2f 3f','in_pos','in_uv','in_nrm'),(ibuf,'16f/i','in_model')])
        draws.append((vao,get_tex(sm.material.texture.upper()),False,len(ms)))
        tri_inst+=len(tri)//3*len(ms)
log('all vaos', len(draws), 'textures', len(tex_cache), 'instanced vob tris', tri_inst)

def render(vp, size, fogk=0.0, sky=(0.55,0.7,0.9)):
    fbo=ctx.simple_framebuffer(size, components=4)
    fbo.use(); ctx.enable(moderngl.DEPTH_TEST); ctx.disable(moderngl.CULL_FACE)
    fbo.clear(*sky,1.0)
    prog['vp'].write(vp.T.astype(np.float32).tobytes())
    prog['sun'].value=tuple((np.array([0.4,1.0,0.3])/np.linalg.norm([0.4,1.0,0.3])).tolist())
    prog['fogcol'].value=sky; prog['fogk'].value=fogk
    for vao,tx,water,n in draws:
        tx.use(0); prog['is_water'].value=1 if water else 0; prog['instanced'].value=1 if n else 0
        if n: vao.render(instances=n)
        else: vao.render()
    img=Image.frombytes('RGBA',size,fbo.read(components=4)).transpose(Image.FLIP_TOP_BOTTOM)
    fbo.release(); return img

def look_at(eye,target,up):
    f=np.array(target,float)-np.array(eye,float); f/=np.linalg.norm(f)
    s=np.cross(f,up); s/=np.linalg.norm(s); u=np.cross(s,f)
    V=np.eye(4); V[0,:3]=s; V[1,:3]=u; V[2,:3]=-f
    V[:3,3]=-V[:3,:3]@np.array(eye,float); return V
def ortho(l,r,b,t,n,f):
    return np.array([[2/(r-l),0,0,-(r+l)/(r-l)],[0,2/(t-b),0,-(t+b)/(t-b)],[0,0,-2/(f-n),-(f+n)/(f-n)],[0,0,0,1]],float)
def persp(fovy,aspect,n,f):
    t=1/math.tan(math.radians(fovy)/2)
    return np.array([[t/aspect,0,0,0],[0,t,0,0],[0,0,(f+n)/(n-f),2*f*n/(n-f)],[0,0,-1,0]],float)

def topdown(size=8192):
    cx=(bounds['minx']+bounds['maxx'])/2; cz=(bounds['minz']+bounds['maxz'])/2
    half=max(bounds['maxx']-bounds['minx'],bounds['maxz']-bounds['minz'])/2
    V=look_at((-cx,bounds['maxy']+1000,cz),(-cx,0,cz),(0,0,1))   # mirrored X; image up = +Z (north, as in the in-game map)
    Pm=ortho(-half,half,-half,half,10,bounds['maxy']-bounds['miny']+3000)
    img=render(Pm@V,(size,size),sky=(0.12,0.25,0.4))
    # geo: original-coordinate frame of the image: left x, bottom z, span; pixel = ((x-left)/span*S, (bottom+span-z)/span*S)
    return img, (cx-half,cz-half,2*half)
def cubemap(eye, face=1024):
    dirs=[((1,0,0),(0,1,0)),((-1,0,0),(0,1,0)),((0,1,0),(0,0,1)),((0,-1,0),(0,0,-1)),((0,0,1),(0,1,0)),((0,0,-1),(0,1,0))]
    Pm=persp(90,1,15,300000)
    faces=[]; Vs=[]
    for d,up in dirs:
        V=look_at(eye,tuple(np.array(eye)+np.array(d)),up)
        faces.append(np.asarray(render(Pm@V,(face,face),fogk=1/60000.0).convert('RGB'))); Vs.append(V)
    return faces,Vs
def equirect(faces,Vs,W=4096,H=2048):
    u=(np.arange(W)+0.5)/W; v=(np.arange(H)+0.5)/H
    lon=(u-0.5)*2*np.pi; lat=(0.5-v)*np.pi
    LON,LAT=np.meshgrid(lon,lat)
    d=np.stack([np.cos(LAT)*np.sin(LON),np.sin(LAT),-np.cos(LAT)*np.cos(LON)],-1)  # lon 0 -> -Z
    out=np.zeros((H,W,3),np.uint8); done=np.zeros((H,W),bool)
    for img,V in zip(faces,Vs):
        dc=d@V[:3,:3].T
        z=-dc[...,2]
        with np.errstate(divide='ignore',invalid='ignore'):
            x=dc[...,0]/z; y=dc[...,1]/z
        sel=(z>0)&(np.abs(x)<=1.0001)&(np.abs(y)<=1.0001)&~done
        fw=img.shape[1]; px=np.clip(((x+1)/2*fw).astype(int),0,fw-1); py=np.clip(((1-y)/2*fw).astype(int),0,fw-1)
        out[sel]=img[py[sel],px[sel]]; done|=sel
    return Image.fromarray(out)

if __name__=='__main__':
    img,geo=topdown(8192)
    img.convert('RGB').save('topdown_%s.png'%WORLD.split('.')[0]); json.dump(geo,open('topdown_geo.json','w'))
    log('topdown saved', geo)
    pts=w.way_net.points
    want=[s for s in sys.argv[2:]] or ['NW_CITY_MARKET_01','NW_FARM1_PATH_03','NW_XARDAS_TOWER_01']
    names={p.name:p for p in pts}
    for wn in want:
        p=names.get(wn)
        if p is None:
            cand=[n for n in names if wn in n]; log('no wp', wn, 'candidates', cand[:8]);
            if not cand: continue
            p=names[cand[0]]
        eye=(-p.position.x,p.position.y+180,p.position.z)   # mirrored X
        faces,Vs=cubemap(eye,1024)
        eq=equirect(faces,Vs); eq.save('pano_%s.jpg'%p.name,quality=90)
        log('pano saved', p.name, eye)
