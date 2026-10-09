"""Gothic II -> GeoGuessr dataset pipeline.

Reads the original game archives (VDF) with zenkit, renders with moderngl (headless OpenGL):
  * filters waynet nodes (inside geometry / under water / isolated),
  * renders 6 cube faces per node and writes WebP tiles + base faces,
  * renders an orthographic top-down map and cuts it into XYZ tiles,
  * writes manifest.json (nodes, links, map frame).
The game install is taken from the GOTHIC2_DIR environment variable (tools/g2env.py).

Coordinate conventions (see SPEC.md):
  * Game units are centimetres, Y up, ZenGin is LEFT-handed. We mirror X at load so that standard
    right-handed camera math gives an un-mirrored image. All coordinates in the manifest are ORIGINAL
    game coordinates (un-mirrored).
  * Cube faces: front = north = +Z(game), right = east = +X(game), back = south, left = west.
  * yaw of a link: degrees clockwise from north (front face centre): north 0, east 90, south 180, west 270.
"""
import argparse, collections, json, math, os, re, sys, time
from concurrent.futures import ThreadPoolExecutor
import numpy as np, moderngl, zenkit
from PIL import Image
from g2env import data_path  # the game archives: $GOTHIC2_DIR/Data
Image.MAX_IMAGE_PIXELS = None

ARCHIVES = ['Worlds.vdf', 'Worlds_Addon.vdf', 'Meshes.vdf', 'Meshes_Addon.vdf', 'Anims.vdf', 'Anims_Addon.vdf', 'Textures.vdf', 'Textures_Addon.vdf']
FACES = ['front', 'right', 'back', 'left', 'top', 'bottom']
# camera forward/up per face, expressed in MIRRORED space (x' = -x_game). Front = north = +Z.
FACE_DIRS = {
    'front': ((0, 0, 1), (0, 1, 0)),
    'right': ((-1, 0, 0), (0, 1, 0)),   # east = +X game = -X mirrored
    'back': ((0, 0, -1), (0, 1, 0)),
    'left': ((1, 0, 0), (0, 1, 0)),
    'top': ((0, 1, 0), (0, 0, -1)),    # looking up while facing north: image-up points south
    'bottom': ((0, -1, 0), (0, 0, 1)),  # looking down while facing north: image-up points north
}
# canonical in-game map frames (Doc_SetLevelCoords): left X, top Z, right X, bottom Z  (game units)
MAP_FRAMES = {
    'NEWWORLD.ZEN': (-28000, 50500, 95500, -42500),
    'OLDWORLD.ZEN': (-78500, 47500, 54000, -53000),
    'ADDONWORLD.ZEN': (-47783, 36300, 43949, -32300),
}
SKY_ZENITH = (0.36, 0.55, 0.85)
SKY_HORIZON = (0.72, 0.80, 0.90)
SEA_COLOR = (0.16, 0.30, 0.45)

T0 = time.time()
def log(*a):
    print('[%7.1fs]' % (time.time() - T0), *a, flush=True)


def look_at(eye, target, up):
    f = np.array(target, float) - np.array(eye, float); f /= np.linalg.norm(f)
    s = np.cross(f, up); s /= np.linalg.norm(s); u = np.cross(s, f)
    V = np.eye(4); V[0, :3] = s; V[1, :3] = u; V[2, :3] = -f
    V[:3, 3] = -V[:3, :3] @ np.array(eye, float); return V

def ortho(l, r, b, t, n, f):
    return np.array([[2 / (r - l), 0, 0, -(r + l) / (r - l)], [0, 2 / (t - b), 0, -(t + b) / (t - b)],
                     [0, 0, -2 / (f - n), -(f + n) / (f - n)], [0, 0, 0, 1]], float)

def persp(fovy, aspect, n, f):
    t = 1 / math.tan(math.radians(fovy) / 2)
    return np.array([[t / aspect, 0, 0, 0], [0, t, 0, 0], [0, 0, (f + n) / (n - f), 2 * f * n / (n - f)], [0, 0, -1, 0]], float)


class Renderer:
    NEAR, FAR = 15.0, 300000.0

    def __init__(self, world_file, tex_level=0):
        self.world_file = world_file
        self.vfs = zenkit.Vfs()
        for d in ARCHIVES:
            self.vfs.mount_disk(data_path(d))
        self.world = zenkit.World.load(self.vfs.find(world_file).open())
        self.ctx = moderngl.create_standalone_context()
        self.tex_level = tex_level
        self._build_programs()
        self._load_world_mesh()
        self._load_vobs()
        self._load_waynet()
        log('renderer ready: %d draw batches, %d textures' % (len(self.draws), len(self.tex_cache)))

    # ---------------- shaders ----------------
    def _build_programs(self):
        self.prog = self.ctx.program(vertex_shader='''
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
uniform sampler2D tex; uniform vec3 sun; uniform int is_water; uniform int flat_water; uniform vec3 fogcol; uniform float fogk; uniform vec3 seacol;
uniform int instanced; uniform int alpha_tex;
in vec2 v_uv; in vec3 v_nrm; in float v_dist; out vec4 f;
void main(){
  vec4 c=texture(tex,v_uv);
  if(c.a<0.5) discard;
  float l=0.55+0.45*max(dot(normalize(v_nrm),sun),0.0);
  vec3 col=c.rgb*l;
  if(is_water==1) col = flat_water==1 ? seacol : mix(col,seacol,0.5);
  float fg=1.0-exp(-v_dist*fogk);
  // alpha encodes what the probe needs (sky dome writes 0): world mesh front 1.0 / back 0.5,
  // VOB (instanced: trees, ferns, rocks, furniture) front 0.75 / back 0.25; alpha-tested textures
  // (foliage, grates) are 0.1 lower than opaque ones so the probe can tell a canopy from a terrain underside
  float fa = instanced==1 ? (gl_FrontFacing ? 0.75 : 0.25) : (gl_FrontFacing ? 1.0 : 0.5);
  if (alpha_tex==1) fa -= 0.1;
  f=vec4(mix(col,fogcol,fg), fa);
}''')
        self.prog['tex'] = 0
        self.sky_prog = self.ctx.program(vertex_shader='''
#version 330
uniform mat4 vp; in vec3 in_pos; out vec3 v_dir;
void main(){ v_dir=in_pos; vec4 p=vp*vec4(in_pos,1.0); gl_Position=p.xyww; }''', fragment_shader='''
#version 330
uniform vec3 zenith; uniform vec3 horizon; in vec3 v_dir; out vec4 f;
void main(){ float h=normalize(v_dir).y; float t=smoothstep(-0.05,0.55,h); f=vec4(mix(horizon,zenith,t),0.0); }''')
        # sky dome: unit sphere (positions relative to camera, handled by vp without translation)
        lat = np.linspace(-np.pi / 2, np.pi / 2, 17); lon = np.linspace(0, 2 * np.pi, 33)
        verts = []
        for i in range(len(lat) - 1):
            for j in range(len(lon) - 1):
                quad = []
                for a, b in ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)):
                    quad.append((math.cos(lat[a]) * math.sin(lon[b]), math.sin(lat[a]), math.cos(lat[a]) * math.cos(lon[b])))
                verts += [quad[0], quad[1], quad[2], quad[0], quad[2], quad[3]]
        self.sky_vao = self.ctx.vertex_array(self.sky_prog, [(self.ctx.buffer(np.array(verts, np.float32).tobytes()), '3f', 'in_pos')])

    # ---------------- assets ----------------
    def _texture(self, name):
        if name in self.tex_cache:
            return self.tex_cache[name]
        node = self.vfs.find(name.rsplit('.', 1)[0] + '-C.TEX') if name else None
        if node is None:
            self.tex_cache[name] = self.white; return self.white
        t = zenkit.Texture.load(node.open())
        lvl = min(self.tex_level, t.mipmap_count - 1)
        tx = self.ctx.texture((t.width_mipmap(lvl), t.height_mipmap(lvl)), 4, t.mipmap_rgba(lvl))
        tx.build_mipmaps(); tx.filter = (moderngl.LINEAR_MIPMAP_LINEAR, moderngl.LINEAR); tx.anisotropy = 8.0
        self.tex_alpha[tx] = t.format.name != 'DXT1'   # DXT1 has no usable alpha; DXT3/DXT5/RGBA may be alpha-tested
        self.tex_cache[name] = tx; return tx

    def _load_world_mesh(self):
        m = self.world.mesh
        P = np.array([(p.x, p.y, p.z) for p in m.positions], dtype=np.float32)
        feats = m.features
        UV = np.array([(f.texture.x, f.texture.y) for f in feats], dtype=np.float32)
        NR = np.array([(f.normal.x, f.normal.y, f.normal.z) for f in feats], dtype=np.float32)
        self.bounds = dict(minx=float(P[:, 0].min()), maxx=float(P[:, 0].max()), minz=float(P[:, 2].min()),
                           maxz=float(P[:, 2].max()), miny=float(P[:, 1].min()), maxy=float(P[:, 1].max()))
        P[:, 0] *= -1; NR[:, 0] *= -1   # left-handed -> right-handed
        mats = m.materials
        mat_tex = [mt.texture.upper() for mt in mats]
        mat_water = [int(mt.group) == 5 for mt in mats]
        by_tex = collections.defaultdict(lambda: ([], []))
        self.water_tex = set()
        for p in m.polygons:
            if p.is_portal or p.is_ghost_occluder:
                continue
            pi = p.position_indices; fi = p.feature_indices; n = len(pi)
            if n < 3:
                continue
            tex = mat_tex[p.material_index]
            if mat_water[p.material_index]:
                self.water_tex.add(tex)
            pl, fl = by_tex[tex]
            for k in range(1, n - 1):
                pl.extend((pi[0], pi[k], pi[k + 1])); fl.extend((fi[0], fi[k], fi[k + 1]))
        self.tex_cache = {}; self.tex_alpha = {}
        self.white = self.ctx.texture((1, 1), 4, bytes([200, 200, 200, 255]))
        self.draws = []
        for tex, (pl, fl) in by_tex.items():
            pl = np.array(pl, dtype=np.int32); fl = np.array(fl, dtype=np.int32)
            data = np.hstack([P[pl], UV[fl], NR[fl]]).astype(np.float32)
            vao = self.ctx.vertex_array(self.prog, [(self.ctx.buffer(data.tobytes()), '3f 2f 3f', 'in_pos', 'in_uv', 'in_nrm')])
            self.draws.append((vao, self._texture(tex), tex in self.water_tex, 0))
        log('world mesh: %d polygons in %d batches' % (len(m.polygons), len(by_tex)))

    def _load_vobs(self):
        inst = collections.defaultdict(list)    # .3DS  -> compiled MRM, one instance matrix per vob
        minst = collections.defaultdict(list)   # .ASC/.MDS -> compiled model (hierarchy + attachments / soft-skin meshes)
        def rec(v):
            vis = v.visual
            if vis is not None and vis.name and v.show_visual:
                name = vis.name.upper(); ext = name.rsplit('.', 1)[-1]
                if ext in ('3DS', 'ASC', 'MDS') and not name.rsplit('.', 1)[0].endswith('_BODY'):   # creature bodies are animated in-game; rest pose would be a T-pose
                    cols = v.rotation.columns
                    R = np.array([[c.x, c.y, c.z] for c in cols], dtype=np.float32).T
                    M = np.eye(4, dtype=np.float32); M[:3, :3] = R; M[:3, 3] = (v.position.x, v.position.y, v.position.z)
                    (inst if ext == '3DS' else minst)[name].append(M)   # game coords; mirrored in _add_mrm
            for c in v.children:
                rec(c)
        for r in self.world.root_objects:
            rec(r)
        n_inst = 0
        for name, ms in inst.items():
            node = self.vfs.find(name.rsplit('.', 1)[0] + '.MRM')
            if node is None:
                continue
            self._add_mrm(zenkit.MultiResolutionMesh.load(node.open()), np.array(ms, dtype=np.float32))
            n_inst += len(ms)
        log('vobs: %d MRM instances of %d visuals' % (n_inst, len(inst)))
        self._load_models(minst)

    def _add_mrm(self, mrm, Mi, pts=None):
        """One instanced VAO per submesh. Mi: (n,4,4) model->world matrices in GAME coords (mirrored here).
        pts: optional override for mrm.positions (same indexing)."""
        if pts is None:
            pts = np.array([(p.x, p.y, p.z) for p in mrm.positions], dtype=np.float32)
        Mi = np.array(Mi, dtype=np.float32); Mi[:, 0, :] *= -1   # mirror X
        ibuf = self.ctx.buffer(np.ascontiguousarray(np.transpose(Mi, (0, 2, 1))).tobytes())
        for sm in mrm.submeshes:
            wd = sm.wedges
            widx = np.array([x.index for x in wd], dtype=np.int32)
            wuv = np.array([(x.texture.x, x.texture.y) for x in wd], dtype=np.float32)
            wn = np.array([(x.normal.x, x.normal.y, x.normal.z) for x in wd], dtype=np.float32)
            tri = np.array([t.wedges for t in sm.triangles], dtype=np.int32).reshape(-1)
            if len(tri) == 0:
                continue
            data = np.hstack([pts[widx[tri]], wuv[tri], wn[tri]]).astype(np.float32)
            vao = self.ctx.vertex_array(self.prog, [(self.ctx.buffer(data.tobytes()), '3f 2f 3f', 'in_pos', 'in_uv', 'in_nrm'),
                                                    (ibuf, '16f/i', 'in_model')])
            self.draws.append((vao, self._texture(sm.material.texture.upper()), False, len(Mi)))

    def _load_models(self, minst):
        """Skeletal models (doors, chests, beds, benches...) in their rest pose. Loaded from <base>.MDL, or from
        <base>.MDM + <base>.MDH when there is no MDL. Rigid attachments are instanced with vob * node matrix, soft-skin
        meshes are skinned once on the CPU with the rest-pose bone matrices (root_translation is NOT applied: the
        hierarchy bbox and the ZS_POS* nodes are relative to the un-translated root)."""
        n_inst = n_vis = 0; failed = []
        for name, ms in minst.items():
            base = name.rsplit('.', 1)[0]
            try:
                node = self.vfs.find(base + '.MDL')
                if node is not None:
                    mdl = zenkit.Model.load(node.open()); hier, mesh = mdl.hierarchy, mdl.mesh
                else:
                    mdh = self.vfs.find(base + '.MDH'); mdm = self.vfs.find(base + '.MDM')
                    if mdh is None or mdm is None:
                        failed.append((name, len(ms), 'no MDL and no MDM+MDH')); continue
                    hier = zenkit.ModelHierarchy.load(mdh.open()); mesh = zenkit.ModelMesh.load(mdm.open())
                # rest pose: node -> model space. transform.columns is column-major (translation in columns[3]),
                # parent == -1 for roots; world(i) = world(parent) * local(i)
                T = []; node_idx = {}
                for i, nd in enumerate(hier.nodes):
                    L = np.array([[c.x, c.y, c.z, c.w] for c in nd.transform.columns], dtype=np.float32).T
                    T.append(L if nd.parent < 0 else T[nd.parent] @ L); node_idx[nd.name] = i
                Mv = np.array(ms, dtype=np.float32)
                parts = 0
                for nname, mrm in mesh.attachments.items():
                    if nname not in node_idx:
                        continue
                    self._add_mrm(mrm, Mv @ T[node_idx[nname]]); parts += 1
                for ssm in mesh.meshes:
                    mrm = ssm.mesh
                    pts = np.zeros((len(mrm.positions), 3), dtype=np.float32)
                    for i, ws in enumerate(ssm.weights):
                        for w in ws:
                            Tb = T[w.index]
                            pts[i] += w.weight * (Tb[:3, :3] @ (w.position.x, w.position.y, w.position.z) + Tb[:3, 3])
                    self._add_mrm(mrm, Mv, pts); parts += 1
                if parts == 0:
                    failed.append((name, len(ms), 'no attachments / meshes')); continue
            except Exception as e:
                failed.append((name, len(ms), '%s: %s' % (type(e).__name__, e))); continue
            n_inst += len(ms); n_vis += 1
        log('models: %d instances of %d visuals (ASC/MDS), %d visuals failed' % (n_inst, n_vis, len(failed)))
        for name, cnt, why in failed:
            log('  model %s (%d vobs) skipped: %s' % (name, cnt, why))

    def _load_waynet(self):
        wn = self.world.way_net
        self.wp = [dict(name=p.name, x=p.position.x, y=p.position.y, z=p.position.z, fp=bool(p.free_point),
                        under_water=bool(p.under_water)) for p in wn.points]
        self.edges = [(e.a, e.b) for e in wn.edges]
        log('waynet: %d points, %d edges' % (len(self.wp), len(self.edges)))

    # ---------------- rendering ----------------
    def render(self, vp, size, fogk=0.0, sky=True, flat_water=False, sky_color=None, want_depth=False):
        ctx = self.ctx
        color = ctx.texture(size, 4); depth = ctx.depth_texture(size)
        fbo = ctx.framebuffer(color_attachments=[color], depth_attachment=depth)
        fbo.use(); ctx.viewport = (0, 0, size[0], size[1])
        ctx.enable(moderngl.DEPTH_TEST); ctx.disable(moderngl.CULL_FACE); ctx.disable(moderngl.BLEND)
        ctx.front_face = 'ccw'  # measured: with the X mirror applied at load, ccw gives front faces for the visible sides
        bg = sky_color or SKY_HORIZON
        fbo.clear(bg[0], bg[1], bg[2], 0.0)
        vp32 = vp.T.astype(np.float32).tobytes()
        if sky:
            vp_nt = vp.copy(); vp_nt[:3, 3] = 0  # no translation: dome centred on camera
            self.sky_prog['vp'].write(vp_nt.T.astype(np.float32).tobytes())
            self.sky_prog['zenith'].value = SKY_ZENITH; self.sky_prog['horizon'].value = SKY_HORIZON
            ctx.depth_func = '<='; self.sky_vao.render(); ctx.depth_func = '<'
        p = self.prog
        p['vp'].write(vp32)
        sun = np.array([0.4, 1.0, 0.3]); sun /= np.linalg.norm(sun)
        p['sun'].value = tuple(sun.tolist()); p['fogcol'].value = SKY_HORIZON; p['fogk'].value = fogk
        p['seacol'].value = SEA_COLOR; p['flat_water'].value = 1 if flat_water else 0
        for vao, tx, water, n in self.draws:
            tx.use(0); p['is_water'].value = 1 if water else 0; p['instanced'].value = 1 if n else 0
            p['alpha_tex'].value = 1 if self.tex_alpha.get(tx, False) else 0
            vao.render(instances=n) if n else vao.render()
        rgba = np.frombuffer(fbo.read(components=4), np.uint8).reshape(size[1], size[0], 4)[::-1]
        out = {'rgba': rgba}
        if want_depth:
            d = np.frombuffer(depth.read(), np.float32).reshape(size[1], size[0])[::-1]
            n_, f_ = self.NEAR, self.FAR
            out['dist'] = 2 * n_ * f_ / (f_ + n_ - (2 * d - 1) * (f_ - n_))
        fbo.release(); color.release(); depth.release()
        return out

    def cube_faces(self, eye_game, size, fogk=1 / 80000.0, want_depth=False):
        """eye_game: (x,y,z) in ORIGINAL game coords. Returns dict face -> render() output."""
        eye = (-eye_game[0], eye_game[1], eye_game[2])
        Pm = persp(90, 1, self.NEAR, self.FAR)
        out = {}
        for face in FACES:
            d, up = FACE_DIRS[face]
            V = look_at(eye, tuple(np.array(eye) + np.array(d, float)), np.array(up, float))
            out[face] = self.render(Pm @ V, (size, size), fogk=fogk, want_depth=want_depth)
        return out

    def topdown(self, frame, width):
        """frame: (left_x, top_z, right_x, bottom_z) in game coords. Returns RGB image (north up, east right)."""
        l, t, r, b = frame
        height = int(round(width * (t - b) / (r - l)))
        cx = (l + r) / 2; cz = (t + b) / 2
        V = look_at((-cx, self.bounds['maxy'] + 1000, cz), (-cx, 0, cz), (0, 0, 1))
        Pm = ortho(-(r - l) / 2, (r - l) / 2, -(t - b) / 2, (t - b) / 2, 10, self.bounds['maxy'] - self.bounds['miny'] + 3000)
        res = self.render(Pm @ V, (width, height), sky=False, flat_water=True, sky_color=SEA_COLOR)
        return Image.fromarray(res['rgba'][..., :3])


def equirect_from_faces(faces, W=4096, H=2048):
    """Debug helper: stitch face images (dict face->HxWx3 uint8) into an equirectangular image. lon 0 = north."""
    u = (np.arange(W) + 0.5) / W; v = (np.arange(H) + 0.5) / H
    lon = (u - 0.5) * 2 * np.pi; lat = (0.5 - v) * np.pi
    LON, LAT = np.meshgrid(lon, lat)
    # direction in mirrored space: north=+Z, east=-X'
    d = np.stack([-np.cos(LAT) * np.sin(LON), np.sin(LAT), np.cos(LAT) * np.cos(LON)], -1)
    out = np.zeros((H, W, 3), np.uint8); done = np.zeros((H, W), bool)
    for face in FACES:
        img = faces[face]; fw = img.shape[1]
        dd, up = FACE_DIRS[face]
        V = look_at((0, 0, 0), dd, np.array(up, float))
        dc = d @ V[:3, :3].T
        z = -dc[..., 2]
        with np.errstate(divide='ignore', invalid='ignore'):
            x = dc[..., 0] / z; y = dc[..., 1] / z
        sel = (z > 0) & (np.abs(x) <= 1.0001) & (np.abs(y) <= 1.0001) & ~done
        px = np.clip(((x + 1) / 2 * fw).astype(int), 0, fw - 1); py = np.clip(((1 - y) / 2 * fw).astype(int), 0, fw - 1)
        out[sel] = img[py[sel], px[sel]]; done |= sel
    return Image.fromarray(out)


# ---------------- dataset building ----------------
# Camera placement checks on the probe cubemap (shares of the face area), tuned on Jharkendar:
FLOATING_BOTTOM_SKY = 0.25    # void below: a spawn point in the air (ADW_SWAMP_RUDEL_12)
UNDER_WATER_BOTTOM = 0.5      # world-mesh back faces below: under a water plane / floor (swamp "sharkstreet" points)
UNDER_TERRAIN_TOP = 0.3       # world-mesh back faces above: under the terrain (BL_MERCHANT_08) ...
UNDER_TERRAIN_TOP_SKY = 0.02  # ... with no sky holes (a jungle canopy in the world mesh has some) ...
UNDER_TERRAIN_SIDES = 0.1     # ... and some back faces around (a vaulted ceiling over beds has none)
INSIDE_MESH_SIDES = 0.5       # opaque world-mesh back faces all around: inside a hill (ADW_SWAMP_HILLS_DOWN_04); foliage excluded
SPAWN_RE = re.compile(r'SPAWN|MONSTER|RUDEL|DANGER|WOLF|SCAVENGER|GOBBO|SNAPPER|LURKER|BLOODFLY|MOLERAT|WARAN|_FP_|^FP_', re.I)   # monster/animal placement points; BANDIT paths are ordinary scenery and stay

def classify_nodes(R, eye_h, probe_size=192, only=None):
    """Render a low-res cubemap with depth for every waypoint; decide accepted / outdoor."""
    info = []
    for i, p in enumerate(R.wp):
        rec = dict(idx=i, accepted=True, outdoor=False, near_frac=0.0, sky_frac=0.0, reason='')
        if only is not None and i not in only:
            rec.update(accepted=False, reason='not_in_subset'); info.append(rec); continue
        if p['under_water']:
            rec.update(accepted=False, reason='under_water'); info.append(rec); continue
        faces = R.cube_faces((p['x'], p['y'] + eye_h, p['z']), probe_size, want_depth=True)
        near = np.mean([(f['dist'] < 45).mean() for f in faces.values()])
        alpha = {f: faces[f]['rgba'][..., 3] for f in FACES}
        sky_top = float((alpha['top'] == 0).mean())
        sky_side = float(np.mean([(alpha[f] == 0).mean() for f in ('front', 'right', 'back', 'left')]))
        # Per face: share of sky (alpha 0) and share of geometry seen from behind (alpha ~128 vs 255).
        # Under the terrain the camera sees void or back faces below and the underside of the ground above;
        # two-sided foliage also shows back faces, so only the top/bottom faces are used for the verdict.
        face_sky = {f: float((alpha[f] == 0).mean()) for f in FACES}
        face_back = {}    # any back face (foliage included)
        face_wback = {}   # back faces of the static world mesh (any texture): water from below, inside hills
        face_wback_opaque = {}   # ... with an opaque texture only: terrain underside, not a canopy
        for f in FACES:
            a = alpha[f]; geo = a > 0
            face_back[f] = float(((a < 200) & geo).sum() / max(geo.sum(), 1))
            face_wback[f] = float(((a > 92) & (a < 160)).mean())          # 0.4 (alpha-tested) or 0.5 (opaque)
            face_wback_opaque[f] = float(((a > 118) & (a < 160)).mean())   # 0.5 only
        back_all = np.concatenate([alpha[f].ravel() for f in FACES]); geo_all = back_all > 0
        back = float(((back_all < 200) & geo_all).sum() / max(geo_all.sum(), 1))
        sides_wback = float(np.mean([face_wback[f] for f in ('front', 'right', 'back', 'left')]))
        sides_wback_opaque = float(np.mean([face_wback_opaque[f] for f in ('front', 'right', 'back', 'left')]))
        rec.update(near_frac=float(near), sky_frac=sky_top, sky_side=sky_side, back_frac=back,
                   face_sky=face_sky, face_back=face_back, face_wback=face_wback, face_wback_opaque=face_wback_opaque,
                   sides_wback=sides_wback, sides_wback_opaque=sides_wback_opaque)
        if near > 0.04:
            rec.update(accepted=False, reason='inside_geometry')
        elif face_sky['bottom'] > FLOATING_BOTTOM_SKY:
            rec.update(accepted=False, reason='floating')
        elif (face_wback['bottom'] > UNDER_WATER_BOTTOM or sides_wback_opaque > INSIDE_MESH_SIDES
              or (face_wback_opaque['top'] > UNDER_TERRAIN_TOP and face_sky['top'] < UNDER_TERRAIN_TOP_SKY
                  and sides_wback_opaque > UNDER_TERRAIN_SIDES)):
            rec.update(accepted=False, reason='underground')
        rec['outdoor'] = bool(sky_top > 0.35)
        info.append(rec)
        if i % 200 == 0:
            log('probe %d/%d' % (i, len(R.wp)))
    return info


def build_graph(R, info):
    acc = [r['accepted'] for r in info]
    edges = [(a, b) for a, b in R.edges if a != b]   # OLDWORLD has a waypoint linked to itself
    adj = collections.defaultdict(set)
    for a, b in edges:
        adj[a].add(b); adj[b].add(a)
    links = collections.defaultdict(set)
    for a, b in edges:
        if acc[a] and acc[b]:
            links[a].add(b); links[b].add(a)
    # bridge over rejected nodes (one hop) so the graph stays connected
    bridged = 0
    for r in range(len(R.wp)):
        if acc[r]:
            continue
        nb = [n for n in adj[r] if acc[n]]
        for i in range(len(nb)):
            for j in range(i + 1, len(nb)):
                a, b = nb[i], nb[j]
                if b in links[a]:
                    continue
                pa, pb = R.wp[a], R.wp[b]
                if math.dist((pa['x'], pa['y'], pa['z']), (pb['x'], pb['y'], pb['z'])) < 4000:
                    links[a].add(b); links[b].add(a); bridged += 1
    return links, bridged


def link_geom(pa, pb):
    dx = pb['x'] - pa['x']; dy = pb['y'] - pa['y']; dz = pb['z'] - pa['z']
    horiz = math.hypot(dx, dz)
    yaw = (math.degrees(math.atan2(dx, dz)) + 360) % 360      # clockwise from north (+Z), east = 90
    pitch = math.degrees(math.atan2(dy, horiz)) if horiz > 1e-3 else 0.0
    return round(yaw, 2), round(pitch, 2), round(math.sqrt(dx * dx + dy * dy + dz * dz) / 100, 2)


def write_pano(out_dir, faces, face_size, tile, base, quality, pool):
    """faces: dict face -> HxWx3 uint8. Writes base_<face>.webp and <face>_<col>_<row>.webp."""
    os.makedirs(out_dir, exist_ok=True)
    jobs = []
    n = face_size // tile
    for face in FACES:
        img = Image.fromarray(faces[face])
        jobs.append(pool.submit(lambda im=img, pth=os.path.join(out_dir, 'base_%s.webp' % face): im.resize((base, base), Image.LANCZOS).save(pth, 'WEBP', quality=max(quality - 8, 50), method=4)))
        for row in range(n):
            for col in range(n):
                box = (col * tile, row * tile, (col + 1) * tile, (row + 1) * tile)
                jobs.append(pool.submit(lambda im=img, bx=box, pth=os.path.join(out_dir, '%s_%d_%d.webp' % (face, col, row)): im.crop(bx).save(pth, 'WEBP', quality=quality, method=4)))
    return jobs


def pano_complete(out_dir, face_size, tile):
    n = face_size // tile
    need = ['base_%s.webp' % f for f in FACES] + ['%s_%d_%d.webp' % (f, c, r) for f in FACES for r in range(n) for c in range(n)]
    return all(os.path.exists(os.path.join(out_dir, x)) for x in need)


def build_map_tiles(img, out_dir, tile=256):
    W, H = img.size
    max_zoom = math.ceil(math.log2(max(W, H) / tile))
    log('map tiles: %dx%d, max zoom %d' % (W, H, max_zoom))
    cur = img.convert('RGB')
    for z in range(max_zoom, -1, -1):
        w, h = cur.size
        nx = math.ceil(w / tile); ny = math.ceil(h / tile)
        for x in range(nx):
            d = os.path.join(out_dir, str(z), str(x)); os.makedirs(d, exist_ok=True)
            for y in range(ny):
                t = Image.new('RGB', (tile, tile), tuple(int(c * 255) for c in SEA_COLOR))
                t.paste(cur.crop((x * tile, y * tile, min((x + 1) * tile, w), min((y + 1) * tile, h))), (0, 0))
                t.save(os.path.join(d, '%d.webp' % y), 'WEBP', quality=82, method=4)
        if z > 0:
            cur = cur.resize((max(1, w // 2), max(1, h // 2)), Image.LANCZOS)
    return max_zoom


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--world', default='NEWWORLD.ZEN')
    ap.add_argument('--slug', default='khorinis')
    ap.add_argument('--name', default='Khorinis')
    ap.add_argument('--out', default='public/data')
    ap.add_argument('--face', type=int, default=2048)
    ap.add_argument('--tile', type=int, default=1024)
    ap.add_argument('--base', type=int, default=512)
    ap.add_argument('--quality', type=int, default=78)
    ap.add_argument('--eye', type=float, default=180.0, help='camera height above waypoint, cm')
    ap.add_argument('--map-width', type=int, default=16384)
    ap.add_argument('--limit', type=int, default=0, help='render only the first N accepted nodes (debug)')
    ap.add_argument('--near', default='', help='debug: only nodes within RADIUS m of waypoint NAME, format NAME:RADIUS')
    ap.add_argument('--skip-map', action='store_true')
    ap.add_argument('--skip-panos', action='store_true')
    ap.add_argument('--workers', type=int, default=6)
    args = ap.parse_args()

    out_root = os.path.join(args.out, args.slug); os.makedirs(out_root, exist_ok=True)
    R = Renderer(args.world)
    frame = MAP_FRAMES.get(args.world) or (R.bounds['minx'], R.bounds['maxz'], R.bounds['maxx'], R.bounds['minz'])

    # 1. classify (debug subsets are probed on the fly and never cached)
    subset = None
    if args.near:
        name, rad = args.near.split(':'); rad = float(rad) * 100
        c = next(p for p in R.wp if p['name'] == name)
        subset = {i for i, p in enumerate(R.wp) if math.dist((p['x'], p['z']), (c['x'], c['z'])) <= rad}
        log('debug subset: %d waypoints within %.0f m of %s' % (len(subset), rad / 100, name))
    probe_path = os.path.join(out_root, 'probe.json')
    if subset is not None:
        info = classify_nodes(R, args.eye, only=subset)
    elif os.path.exists(probe_path):
        info = json.load(open(probe_path)); log('probe cache loaded (%d)' % len(info))
    else:
        info = classify_nodes(R, args.eye); json.dump(info, open(probe_path, 'w'))
    reasons = collections.Counter(r['reason'] for r in info if not r['accepted'])
    log('accepted %d / %d, rejected: %s, outdoor %d' % (sum(r['accepted'] for r in info), len(info), dict(reasons), sum(r['outdoor'] for r in info if r['accepted'])))

    # 2. graph
    links, bridged = build_graph(R, info)
    log('links: %d edges (+%d bridged)' % (sum(len(v) for v in links.values()) // 2, bridged))

    # optional subset
    selected = [r['idx'] for r in info if r['accepted']]
    if args.limit:
        selected = selected[:args.limit]
    sel_set = set(selected)
    id_of = {wp_idx: n for n, wp_idx in enumerate(selected)}

    # 3. manifest
    nodes = []
    for n, i in enumerate(selected):
        p = R.wp[i]; r = info[i]
        ls = []
        for j in sorted(links[i]):
            if j in sel_set:
                yaw, pitch, dist = link_geom(p, R.wp[j])
                ls.append(dict(to=id_of[j], yaw=yaw, pitch=pitch, dist=dist))
        nodes.append(dict(id=n, wp=p['name'], x=round(p['x'], 1), y=round(p['y'], 1), z=round(p['z'], 1),
                          outdoor=bool(r['outdoor']), links=ls))
    # starts: any node (outdoor or indoor; the frontend mixes them by game mode) that is not a monster spawn,
    # lies inside the map frame and belongs to a connected component of at least MIN_START_COMPONENT nodes
    par = list(range(len(nodes)))
    def find(x):
        while par[x] != x:
            par[x] = par[par[x]]; x = par[x]
        return x
    for nd in nodes:
        for l in nd['links']:
            par[find(nd['id'])] = find(l['to'])
    comp = collections.Counter(find(nd['id']) for nd in nodes)
    main_root = comp.most_common(1)[0][0] if comp else -1
    log('graph components: %d, largest %d of %d nodes' % (len(comp), comp[main_root], len(nodes)))
    fl, ft, fr, fb = frame
    def in_frame(nd):
        return fl <= nd['x'] <= fr and fb <= nd['z'] <= ft
    MIN_START_COMPONENT = 10
    starts = [nd['id'] for nd in nodes if nd['links'] and comp[find(nd['id'])] >= MIN_START_COMPONENT
              and in_frame(nd) and not SPAWN_RE.search(nd['wp'])]
    log('starts: %d (outdoor %d, indoor %d)' % (len(starts), sum(nodes[i]['outdoor'] for i in starts), sum(not nodes[i]['outdoor'] for i in starts)))
    l, t, rr, b = frame
    map_w = args.map_width; map_h = int(round(map_w * (t - b) / (rr - l)))
    manifest = dict(world=args.slug, name=args.name, units='cm', eyeHeight=args.eye,
                    pano=dict(faceSize=args.face, tileSize=args.tile, nbTiles=args.face // args.tile, baseSize=args.base,
                              path='panos/{id}', base='base_{face}.webp', tile='{face}_{col}_{row}.webp', faces=FACES),
                    map=dict(path='map/{z}/{x}/{y}.webp', tileSize=256, width=map_w, height=map_h,
                             maxZoom=math.ceil(math.log2(max(map_w, map_h) / 256)),
                             frame=dict(x0=l, z0=t, x1=rr, z1=b)),
                    scoring=dict(maxScore=5000, perfectRadiusM=15, diagonalM=round(math.hypot(rr - l, t - b) / 100, 1)),
                    nodes=nodes, starts=starts)
    json.dump(manifest, open(os.path.join(out_root, 'manifest.json'), 'w'))
    log('manifest: %d nodes, %d starts, %d links' % (len(nodes), len(starts), sum(len(nd['links']) for nd in nodes)))

    # 4. map
    if not args.skip_map:
        img = R.topdown(frame, args.map_width)
        img.save(os.path.join(out_root, 'map_full.jpg'), quality=85)
        build_map_tiles(img, os.path.join(out_root, 'map'))
        log('map done')

    # 5. panoramas
    if not args.skip_panos:
        pool = ThreadPoolExecutor(args.workers); pending = []
        t_start = time.time(); done = 0
        for nd in nodes:
            d = os.path.join(out_root, 'panos', str(nd['id']))
            if pano_complete(d, args.face, args.tile):
                continue
            faces = R.cube_faces((nd['x'], nd['y'] + args.eye, nd['z']), args.face)
            pending += write_pano(d, {f: faces[f]['rgba'][..., :3] for f in FACES}, args.face, args.tile, args.base, args.quality, pool)
            done += 1
            if len(pending) > 400:
                for j in pending: j.result()
                pending = []
            if done % 25 == 0:
                el = time.time() - t_start
                log('panos %d/%d  (%.2f s/node, ETA %.0f min)' % (done, len(nodes), el / done, el / done * (len(nodes) - done) / 60))
        for j in pending: j.result()
        log('panos done: %d rendered' % done)


if __name__ == '__main__':
    main()
