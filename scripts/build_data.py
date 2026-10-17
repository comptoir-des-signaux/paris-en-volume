"""Préparation des données de la carte : data/raw/ vers public/data/.

Usage : python scripts/build_data.py   (après scripts/fetch_data.py)

Produit, pour un chargement instantané dans le navigateur :
  meta.json        périodes, parts du bâti, emprises, index des sections binaires
  buildings.bin    emprises triangulées (positions quantifiées, indices locaux, attributs)
  dem.bin          relief (MNT) interpolé depuis l'altitude au sol des emprises Apur
  trees.bin        arbres d'alignement et des jardins (position, hauteur, houppier, genre)
  context.json     eau (Seine, canaux), quais, socle, limites et étiquettes d'arrondissements
  ground.webp      texture du sol : jardins, cimetières, courbes de niveau, masque de Paris
  risques.json     zones du PPRI, croisement avec les périodes, rapprochement État / Ville
  risques.bin      par polygone bâti : zone du PPRI (bits 0-2) et secteur de caves 1910 (bit 3)
  risque-ppri.webp, risque-caves.webp   textures posées sur le relief (chargées à la demande)
"""
import csv
import glob
import json
import math
import pathlib
import warnings

import mapbox_earcut as earcut
import numpy as np
import pyproj
import shapefile
import shapely
from PIL import Image, ImageDraw
from scipy.interpolate import griddata
from scipy.ndimage import gaussian_filter, median_filter
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, mapping, shape
from shapely.geometry.polygon import orient
from shapely.ops import transform, unary_union

warnings.filterwarnings("ignore", category=DeprecationWarning)

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "public" / "data"
OUT.mkdir(parents=True, exist_ok=True)

CELL = 10.0            # pas du relief, en mètres
TEX_W = 6144           # largeur de la texture du sol, en pixels
SEINE_LEVEL = 27.0     # cote approximative du plan d'eau de la Seine à Paris (m NGF)
CANAL_DEPTH = 3.0      # hauteur des quais des canaux sous le terrain environnant
PLINTH_BASE = -40.0    # fond du socle de la maquette (m)

# Périodes Apur (c_perconst) : index GPU, libellé, bornes d'existence certaine
PERIODS = [
    (1, "Avant 1800", None, 1800),
    (2, "1801-1850", 1801, 1850),
    (3, "1851-1914", 1851, 1914),
    (5, "1915-1939", 1915, 1939),
    (6, "1940-1967", 1940, 1967),
    (7, "1968-1975", 1968, 1975),
    (8, "1976-1981", 1976, 1981),
    (9, "1982-1989", 1982, 1989),
    (10, "1990-1999", 1990, 1999),
    (11, "2000-2007", 2000, 2007),
    (12, "2008 et après", 2008, None),
    (99, "Non daté", None, None),
]
CODE_TO_IDX = {code: i for i, (code, *_rest) in enumerate(PERIODS)}
YEAR0 = 1800

EIFFEL = (2.294481, 48.858370)

# ---------------------------------------------------------------- projection locale
LAT0 = 48.8566
PHI = math.radians(LAT0)
MX = 111412.84 * math.cos(PHI) - 93.5 * math.cos(3 * PHI)
MY = 111132.954 - 559.822 * math.cos(2 * PHI) + 1.175 * math.cos(4 * PHI)
LNG0 = 2.3488


def to_m(geom):
    return transform(lambda x, y, z=None: ((np.asarray(x) - LNG0) * MX, (np.asarray(y) - LAT0) * MY), geom)


def to_ll(geom):
    return transform(lambda x, y, z=None: (np.asarray(x) / MX + LNG0, np.asarray(y) / MY + LAT0), geom)


def load_geojson(path):
    return [f for f in json.load(open(path, encoding="utf-8"))["features"] if f.get("geometry")]


def polys(geom):
    if geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    return [g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon)]


# ---------------------------------------------------------------- masque de Paris sans les bois
print("Masque de Paris intra-muros, hors bois")
arr_feats = load_geojson(RAW / "arrondissements.geojson")
arr_m = {int(f["properties"]["c_ar"]): to_m(shape(f["geometry"])).buffer(0) for f in arr_feats}
arr_id_to_num = {int(f["properties"]["n_sq_ar"]): int(f["properties"]["c_ar"]) for f in arr_feats}
paris_m = unary_union(list(arr_m.values())).buffer(0.5).buffer(-0.5)

ev_feats = load_geojson(RAW / "espaces_verts.geojson")
bois = [to_m(shape(f["geometry"])).buffer(0) for f in ev_feats if f["properties"].get("type_ev") == "Bois"]
# fermeture morphologique : les routes, lacs et enclaves internes des bois sont retirés avec eux
bois_m = unary_union(bois).buffer(120).buffer(-120)
bois_m = unary_union([Polygon(p.exterior) for p in polys(bois_m)])
mask_m = paris_m.difference(bois_m).buffer(-25).buffer(25)   # ouverture : supprime les liserés
mask_m = max(polys(mask_m), key=lambda p: p.area)
mask_m = Polygon(mask_m.exterior).simplify(1.5)
mask_ll = to_ll(mask_m)
print(f"  surface couverte : {mask_m.area / 1e6:.1f} km²")

minx, miny, maxx, maxy = mask_m.bounds
PAD = 60
W_LNG, S_LAT = (minx - PAD) / MX + LNG0, (miny - PAD) / MY + LAT0
E_LNG, N_LAT = (maxx + PAD) / MX + LNG0, (maxy + PAD) / MY + LAT0
NX = int(math.ceil((maxx - minx + 2 * PAD) / CELL)) + 1
NY = int(math.ceil((maxy - miny + 2 * PAD) / CELL)) + 1
DLNG = (E_LNG - W_LNG) / (NX - 1)
DLAT = (N_LAT - S_LAT) / (NY - 1)
ORIGIN = [round((W_LNG + E_LNG) / 2, 6), round((S_LAT + N_LAT) / 2, 6)]
print(f"  grille du relief : {NX} x {NY} au pas de {CELL:.0f} m")


def grid_ij(lng, lat):
    return (np.asarray(lng) - W_LNG) / DLNG, (N_LAT - np.asarray(lat)) / DLAT


# ---------------------------------------------------------------- emprises bâties
print("Emprises bâties Apur")
feats, seen = [], set()
for path in sorted(glob.glob(str(RAW / "apur" / "*.geojson"))):
    for f in load_geojson(path):
        k = f["properties"]["n_sq_eb"]
        if k is not None and k in seen:
            continue
        seen.add(k)
        feats.append(f)
print(f"  {len(feats)} emprises distinctes")

geoms_ll = [shape(f["geometry"]) for f in feats]
cent = np.array([[g.representative_point().x, g.representative_point().y] for g in geoms_ll])
cx_m, cy_m = (cent[:, 0] - LNG0) * MX, (cent[:, 1] - LAT0) * MY
inside = shapely.contains_xy(mask_m, cx_m, cy_m)
eif_x, eif_y = (EIFFEL[0] - LNG0) * MX, (EIFFEL[1] - LAT0) * MY
is_eiffel = np.array([
    (f["properties"].get("an_const") == 1889 and f["properties"].get("c_tissu") == "ER"
     and math.hypot(cx_m[i] - eif_x, cy_m[i] - eif_y) < 80)
    for i, f in enumerate(feats)
])
keep = np.where(inside & ~is_eiffel)[0]
print(f"  {inside.sum()} dans le périmètre, {is_eiffel.sum()} pièces de la tour Eiffel remplacées par un modèle")

# ---- relief : altitude médiane du sol (MNT) des emprises, interpolée puis lissée
pts, vals = [], []
for i in np.where(inside | is_eiffel)[0]:
    z = feats[i]["properties"].get("al_med_mnt")
    if z is not None and 10 < z < 140:
        pts.append(cent[i])
        vals.append(z)
pts, vals = np.array(pts), np.array(vals)
gi, gj = grid_ij(pts[:, 0], pts[:, 1])
GX, GY = np.meshgrid(np.arange(NX), np.arange(NY))
dem = griddata(np.c_[gi, gj], vals, (GX, GY), method="linear")
near = griddata(np.c_[gi, gj], vals, (GX, GY), method="nearest")
dem = np.where(np.isnan(dem), near, dem)
dem = gaussian_filter(median_filter(dem, size=5), sigma=1.6)


def dem_at(lng, lat):
    i, j = grid_ij(lng, lat)
    i = np.clip(i, 0, NX - 1.001)
    j = np.clip(j, 0, NY - 1.001)
    i0, j0 = np.floor(i).astype(int), np.floor(j).astype(int)
    fi, fj = i - i0, j - j0
    return (dem[j0, i0] * (1 - fi) * (1 - fj) + dem[j0, i0 + 1] * fi * (1 - fj)
            + dem[j0 + 1, i0] * (1 - fi) * fj + dem[j0 + 1, i0 + 1] * fi * fj)


print(f"  relief : {dem.min():.1f} à {dem.max():.1f} m")

# ---- géométries, triangulation et attributs
QX = 65535 / (E_LNG - W_LNG)
QY = 65535 / (N_LAT - S_LAT)
pos_q, valid, idx_local, start_idx, tri_start = [], [], [], [0], [0]
a_base, a_elev, a_period, a_ys, a_ye, a_year, a_arr, a_id, a_h, a_ground, a_feat = ([] for _ in range(11))
stats_count = np.zeros(len(PERIODS))
stats_area = np.zeros(len(PERIODS))
year_max = 0
for i in keep:
    an = feats[i]["properties"].get("an_const")
    if an and an <= 2026:
        year_max = max(year_max, an)
YEAR_MAX = year_max
print(f"  dernière année de construction renseignée : {YEAR_MAX}")

for i in keep:
    p = feats[i]["properties"]
    code = p.get("c_perconst")
    pi = CODE_TO_IDX.get(code, CODE_TO_IDX[99])
    _, _, ps, pe = PERIODS[pi]
    ps = YEAR0 if ps is None else ps
    pe = YEAR_MAX if pe is None else pe
    an = p.get("an_const") or 0
    if pi == 0:
        ys = ye = YEAR0
    elif pi == len(PERIODS) - 1:
        ys, ye = YEAR0, YEAR_MAX
    elif an and ps <= an <= pe:
        ys = ye = an
    else:
        ys, ye = ps, pe

    h = next((v for v in (p.get("h_med"), p.get("h_moy"), p.get("h_max")) if v), 0) or 0
    h = max(float(h), 2.5)
    g = geoms_ll[i]
    pieces = polys(g.buffer(0) if not g.is_valid else g)
    area_m = to_m(g).area
    stats_count[pi] += 1
    stats_area[pi] += area_m
    ground = p.get("al_med_mnt")
    for poly in pieces:
        if poly.area <= 0:
            continue
        poly = orient(poly, 1.0)          # extérieur anti-horaire, cours intérieures horaires
        rings = [np.asarray(poly.exterior.coords)] + [np.asarray(r.coords) for r in poly.interiors]
        rings = [r for r in rings if len(r) >= 4]
        if not rings:
            continue
        allpts = np.vstack(rings)
        zs = dem_at(allpts[:, 0], allpts[:, 1])
        base = float(zs.min()) - 1.0
        g0 = float(ground) if ground is not None else float(dem_at(*poly.representative_point().coords[0]))
        top = max(g0 + h, float(zs.max()) + 2.0, base + 3.0)
        # triangulation en mètres locaux sur anneaux ouverts, réindexée sur anneaux fermés
        open_m, ends, remap, off_closed = [], [], [], 0
        for r in rings:
            ro = r[:-1]
            open_m.append(np.c_[(ro[:, 0] - LNG0) * MX, (ro[:, 1] - LAT0) * MY])
            remap.extend(range(off_closed, off_closed + len(ro)))
            off_closed += len(r)
            ends.append(sum(len(x) for x in open_m))
        tri = earcut.triangulate_float64(np.vstack(open_m), np.array(ends, dtype=np.uint32))
        if len(tri) == 0:
            continue
        remap = np.array(remap)
        idx_local.append(remap[tri].astype(np.uint16))
        tri_start.append(tri_start[-1] + len(tri))
        for r in rings:
            q = np.c_[np.round((r[:, 0] - W_LNG) * QX), np.round((N_LAT - r[:, 1]) * QY)]
            pos_q.append(np.clip(q, 0, 65535).astype(np.uint16))
            v = np.ones(len(r), dtype=np.uint8)
            v[-1] = 0
            valid.append(v)
        start_idx.append(start_idx[-1] + off_closed)
        a_base.append(base)
        a_elev.append(top - base)
        a_period.append(pi)
        a_ys.append(ys)
        a_ye.append(ye)
        a_year.append(an if an and an <= 2026 else 0)
        a_arr.append(arr_id_to_num.get(p.get("n_sq_ar") or 0, 0))
        a_id.append(int(p["n_sq_eb"] or 0))
        a_h.append(h)
        a_ground.append(g0)
        a_feat.append(i)

for i in np.where(is_eiffel)[0]:
    stats_count[CODE_TO_IDX[3]] += 1
    stats_area[CODE_TO_IDX[3]] += to_m(geoms_ll[i]).area
N = len(a_base)
V = start_idx[-1]
T = tri_start[-1]
print(f"  {N} polygones, {V} sommets, {T // 3} triangles")

sections = {}
blob = bytearray()


def add(name, arr):
    global blob
    arr = np.ascontiguousarray(arr)
    while len(blob) % 8:
        blob += b"\0"
    sections[name] = {"offset": len(blob), "length": int(arr.size), "type": arr.dtype.name}
    blob += arr.tobytes()


add("positions", np.vstack(pos_q).reshape(-1))
add("vertexValid", np.concatenate(valid))
add("startIndices", np.array(start_idx, dtype=np.uint32))
add("triStart", np.array(tri_start, dtype=np.uint32))
add("indices", np.concatenate(idx_local))
add("base", np.round(np.array(a_base) * 10).astype(np.int16))
add("elevation", np.round(np.array(a_elev) * 10).astype(np.uint16))
add("height", np.round(np.array(a_h) * 10).astype(np.uint16))
add("ground", np.round(np.array(a_ground) * 10).astype(np.int16))
add("period", np.array(a_period, dtype=np.uint8))
add("yearStart", np.array(a_ys, dtype=np.uint16))
add("yearEnd", np.array(a_ye, dtype=np.uint16))
add("year", np.array(a_year, dtype=np.uint16))
add("arrondissement", np.array(a_arr, dtype=np.uint8))
add("id", np.array(a_id, dtype=np.uint32))
(OUT / "buildings.bin").write_bytes(bytes(blob))
building_sections = sections
print(f"  buildings.bin : {len(blob) / 1e6:.1f} Mo")

# ---------------------------------------------------------------- eau, quais et socle
print("Eau, quais et socle")
water_feats = load_geojson(RAW / "plan-de-voirie-voies-deau.geojson")


def water_kind(g):
    c = g.centroid
    if 2.366 < c.x < 2.373 and 48.851 < c.y < 48.8665:
        return None                      # canal Saint-Martin couvert (voûte Richard-Lenoir) : souterrain
    if c.x > 2.36 and c.y > 48.866:
        return "canal"                   # canal Saint-Martin à ciel ouvert, bassin de la Villette, Ourcq, Saint-Denis
    return "seine"                       # Seine, bras et bassin de l'Arsenal


groups = {"seine": [], "canal": []}
for f in water_feats:
    g = shape(f["geometry"]).buffer(0)
    k = water_kind(g)
    if k:
        groups[k].append(to_m(g))
water_polys = []
for k, gs in groups.items():
    u = unary_union(gs).buffer(0.3).buffer(-0.3).intersection(mask_m)
    water_polys += [(k, p) for p in polys(u) if p.area > 200]
mask_line = mask_m.exterior


def densify(coords, step):
    out = []
    for a, b in zip(coords[:-1], coords[1:]):
        d = math.hypot(b[0] - a[0], b[1] - a[1])
        n = max(1, int(d // step))
        for k in range(n):
            t = k / n
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    out.append(tuple(coords[-1]))
    return out


def ll_arr(xy):
    xy = np.asarray(xy)
    return np.c_[xy[:, 0] / MX + LNG0, xy[:, 1] / MY + LAT0]


water_out, walls = [], []
for kind, poly in water_polys:
    poly = orient(poly.simplify(0.4), 1.0)
    is_seine = kind == "seine"
    rings_out = []
    for ring in [poly.exterior] + list(poly.interiors):
        pts_m = densify(list(ring.coords), 12)
        ll = ll_arr(pts_m)
        terrain = dem_at(ll[:, 0], ll[:, 1])
        level = np.full(len(ll), SEINE_LEVEL) if is_seine else terrain - CANAL_DEPTH
        if not is_seine:
            level = np.convolve(np.pad(level, 6, mode="edge"), np.ones(13) / 13, mode="valid")
        rings_out.append([[round(a, 7), round(b, 7), round(float(z), 2)] for (a, b), z in zip(ll, level)])
        # quais : du plan d'eau au terrain, sauf là où l'eau franchit la limite du périmètre
        chain = []
        for k, (xy, (a, b), zl, zt) in enumerate(zip(pts_m, ll, level, terrain)):
            on_edge = mask_line.distance(Point(xy)) < 2.0
            if on_edge:
                if len(chain) > 1:
                    walls.append({"side": "L", "pts": chain})
                chain = []
                continue
            chain.append([round(a, 7), round(b, 7), round(float(max(zt + 0.3, zl + 0.8)), 2), round(float(zl) - 0.5, 2)])
        if len(chain) > 1:
            walls.append({"side": "L", "pts": chain})
    water_out.append({"seine": bool(is_seine), "rings": rings_out})

water_union = unary_union([p for _, p in water_polys]).buffer(1.0)
pts_m = densify(list(orient(mask_m, 1.0).exterior.coords), 10)
ll = ll_arr(pts_m)
terrain = dem_at(ll[:, 0], ll[:, 1])
in_water = shapely.contains_xy(water_union, np.array([p[0] for p in pts_m]), np.array([p[1] for p in pts_m]))
plinth = []
for (a, b), zt, w in zip(ll, terrain, in_water):
    ztop = SEINE_LEVEL if w else zt + 0.2
    plinth.append([round(a, 7), round(b, 7), round(float(ztop), 2), PLINTH_BASE])
walls.append({"side": "R", "pts": plinth, "plinth": True})
print(f"  {len(water_out)} plans d'eau, {len(walls)} linéaires de quais et de socle")

# ---------------------------------------------------------------- arrondissements
ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII",
         "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX"]
arr_paths, arr_labels = [], []
for num, g in sorted(arr_m.items()):
    clipped = g.intersection(mask_m)
    for poly in polys(clipped):
        line = poly.exterior
        pts = densify(list(line.coords), 15)
        keep_pts = [p for p in pts if mask_line.distance(Point(p)) > 6]
        # on ne trace que les limites intérieures (la limite extérieure est portée par le socle)
        seg = []
        for p in pts:
            if mask_line.distance(Point(p)) > 6:
                seg.append(p)
            else:
                if len(seg) > 1:
                    arr_paths.append(seg)
                seg = []
        if len(seg) > 1:
            arr_paths.append(seg)
    big = max(polys(clipped), key=lambda p: p.area)
    rp = big.representative_point() if num not in (1, 4) else big.centroid
    lng, lat = rp.x / MX + LNG0, rp.y / MY + LAT0
    arr_labels.append({"num": num, "roman": ROMAN[num], "lng": round(lng, 6), "lat": round(lat, 6),
                       "z": round(float(dem_at(lng, lat)), 1),
                       "name": next(f["properties"]["l_aroff"] for f in arr_feats if int(f["properties"]["c_ar"]) == num)})
paths_out = []
for seg in arr_paths:
    ll = ll_arr(seg)
    z = dem_at(ll[:, 0], ll[:, 1]) + 1.2
    paths_out.append([[round(a, 7), round(b, 7), round(float(c), 1)] for (a, b), c in zip(ll, z)])

# ---------------------------------------------------------------- arbres
print("Arbres")
CLASSES = {
    "Platanus": 0, "Aesculus": 1, "Tilia": 2, "Acer": 3, "Styphnolobium": 4, "Sophora": 4,
    "Prunus": 5, "Malus": 5, "Pyrus": 5, "Cercis": 5, "Magnolia": 5,
    "Pinus": 6, "Cedrus": 6, "Taxus": 6, "Picea": 6, "Abies": 6, "Chamaecyparis": 6, "Thuja": 6,
    "Cupressus": 6, "Sequoia": 6, "Sequoiadendron": 6, "Metasequoia": 6, "Larix": 6, "Pseudotsuga": 6,
    "Cupressocyparis": 6, "Taxodium": 6, "Juniperus": 6, "Ginkgo": 7, "Fraxinus": 8, "Celtis": 8,
    "Ulmus": 8, "Quercus": 9, "Robinia": 4, "Gleditsia": 4, "Betula": 2, "Carpinus": 3, "Fagus": 9,
}
tx, ty, th, tr, tc = [], [], [], [], []
with open(RAW / "les-arbres.csv", encoding="utf-8-sig") as fh:
    for row in csv.DictReader(fh, delimiter=";"):
        gp = row.get("geo_point_2d") or ""
        if "," not in gp:
            continue
        lat, lng = (float(v) for v in gp.split(","))
        try:
            h = int(row.get("hauteurenm") or 0)
            c = int(row.get("circonferenceencm") or 0)
        except ValueError:
            h, c = 0, 0
        if not 1 <= h <= 45:
            h = min(max(c / 7.0, 3), 25) if c > 0 else 7
        if c <= 0 or c > 800:
            c = h * 7
        r = min(max(0.26 * h + 0.003 * c, 1.0), 9.0)
        tx.append(lng)
        ty.append(lat)
        th.append(h)
        tr.append(r)
        tc.append(CLASSES.get(row.get("genre") or "", 10))
tx, ty = np.array(tx), np.array(ty)
tin = shapely.contains_xy(mask_m, (tx - LNG0) * MX, (ty - LAT0) * MY)
tin &= ~shapely.contains_xy(water_union, (tx - LNG0) * MX, (ty - LAT0) * MY)
tx, ty = tx[tin], ty[tin]
th, tr, tc = np.array(th)[tin], np.array(tr)[tin], np.array(tc)[tin]
tz = dem_at(tx, ty)
sections = {}
blob = bytearray()
add("x", np.clip(np.round((tx - W_LNG) * QX), 0, 65535).astype(np.uint16))
add("y", np.clip(np.round((N_LAT - ty) * QY), 0, 65535).astype(np.uint16))
add("z", np.round(tz * 10).astype(np.int16))
add("height", np.round(np.array(th) * 4).astype(np.uint8))
add("radius", np.round(np.array(tr) * 20).astype(np.uint8))
add("genus", np.array(tc, dtype=np.uint8))
(OUT / "trees.bin").write_bytes(bytes(blob))
tree_sections = sections
print(f"  {len(tx)} arbres dans le périmètre, trees.bin : {len(blob) / 1e6:.1f} Mo")

# ---------------------------------------------------------------- relief et arrondissements
(OUT / "dem.bin").write_bytes(np.round(dem * 10).astype(np.int16).tobytes())
arr_img = Image.new("L", (NX, NY), 0)
da = ImageDraw.Draw(arr_img)
for num, g in arr_m.items():
    for poly in polys(g.intersection(mask_m)):
        pl = to_ll(poly)
        da.polygon([((x - W_LNG) / DLNG, (N_LAT - y) / DLAT) for x, y in pl.exterior.coords], fill=num)
(OUT / "arr.bin").write_bytes(np.array(arr_img, dtype=np.uint8).tobytes())

# ---------------------------------------------------------------- texture du sol
print("Texture du sol")
TEX_H = int(round(TEX_W * (N_LAT - S_LAT) * MY / ((E_LNG - W_LNG) * MX)))
sx, sy = TEX_W / (E_LNG - W_LNG), TEX_H / (N_LAT - S_LAT)


def px(coords):
    return [((x - W_LNG) * sx, (N_LAT - y) * sy) for x, y in coords]


GROUND = (46, 52, 62)
img = Image.new("RGBA", (TEX_W, TEX_H), (0, 0, 0, 0))
dr = ImageDraw.Draw(img)
dr.polygon(px(mask_ll.exterior.coords), fill=GROUND + (255,))

# courbes de niveau tous les 5 m, maîtresses tous les 25 m
yy, xx = np.mgrid[0:TEX_H, 0:TEX_W]
gi_t = xx / (TEX_W - 1) * (NX - 1)
gj_t = yy / (TEX_H - 1) * (NY - 1)
del xx, yy
i0 = np.clip(np.floor(gi_t).astype(np.int32), 0, NX - 2)
j0 = np.clip(np.floor(gj_t).astype(np.int32), 0, NY - 2)
fi = (gi_t - i0).astype(np.float32)
fj = (gj_t - j0).astype(np.float32)
del gi_t, gj_t
dz = dem.astype(np.float32)
H = (dz[j0, i0] * (1 - fi) * (1 - fj) + dz[j0, i0 + 1] * fi * (1 - fj)
     + dz[j0 + 1, i0] * (1 - fi) * fj + dz[j0 + 1, i0 + 1] * fi * fj)
del i0, j0, fi, fj
band = np.floor(H / 5.0)
edge = np.zeros(H.shape, dtype=bool)
edge[:, 1:] |= band[:, 1:] != band[:, :-1]
edge[1:, :] |= band[1:, :] != band[:-1, :]
major = np.zeros(H.shape, dtype=bool)
bandM = np.floor(H / 25.0)
major[:, 1:] |= bandM[:, 1:] != bandM[:, :-1]
major[1:, :] |= bandM[1:, :] != bandM[:-1, :]
del band, bandM, H

rgba = np.array(img)
# jardins et cimetières
green = Image.new("L", (TEX_W, TEX_H), 0)
cemetery = Image.new("L", (TEX_W, TEX_H), 0)
dg, dc = ImageDraw.Draw(green), ImageDraw.Draw(cemetery)
SKIP = {"Jardiniere", "jardiniere", "Murs vegetalises", "Decoration", "Plate-bande", "Bois"}
n_parks = 0
for f in ev_feats:
    pr = f["properties"]
    if pr.get("categorie") in SKIP or pr.get("type_ev") in ("Bois", "Murs végétalisés"):
        continue
    target = dc if pr.get("categorie") == "Cimetière" else dg
    g = shape(f["geometry"])
    for poly in polys(g):
        target.polygon(px(poly.exterior.coords), fill=255)
        for hole in poly.interiors:
            target.polygon(px(hole.coords), fill=0)
    n_parks += 1
green_a = np.array(green) > 0
cem_a = np.array(cemetery) > 0
inside_a = rgba[:, :, 3] > 0
rgba[green_a & inside_a, :3] = (42, 84, 56)
rgba[cem_a & inside_a, :3] = (52, 68, 60)
lift = np.zeros(rgba.shape[:2], dtype=np.int16)
lift[edge] = 9
lift[major] = 20
rgb = rgba[:, :, :3].astype(np.int16)
rgb[:, :, 0] += lift
rgb[:, :, 1] += lift
rgb[:, :, 2] += (lift * 0.8).astype(np.int16)
rgba[:, :, :3] = np.clip(rgb, 0, 255).astype(np.uint8)
del rgb, lift
# l'eau est un trou dans le sol : le plan d'eau est dessiné plus bas, entre ses quais
water_img = Image.new("L", (TEX_W, TEX_H), 0)
dw = ImageDraw.Draw(water_img)
for _, poly in water_polys:
    pl = to_ll(poly)
    dw.polygon(px(pl.exterior.coords), fill=255)
    for hole in pl.interiors:
        dw.polygon(px(hole.coords), fill=0)
rgba[np.array(water_img) > 0, 3] = 0
Image.fromarray(rgba).save(OUT / "ground.webp", quality=88, method=6)
Image.fromarray(rgba).resize((TEX_W // 6, TEX_H // 6)).save(ROOT / "data" / "apercu_sol.png")
print(f"  {TEX_W} x {TEX_H} px, {n_parks} espaces verts, ground.webp : {(OUT / 'ground.webp').stat().st_size / 1e6:.1f} Mo")

# ---------------------------------------------------------------- risque d'inondation
# Zonage réglementaire du PPRI publié par l'État (fait foi), rapproché du report qu'en fait le
# PLU de Paris ; secteurs de caves inondées dans l'hypothèse d'une crue type 1910 (Ville).
print("Risque d'inondation")
L93 = pyproj.Transformer.from_crs(2154, 4326, always_xy=True)
# ordre de priorité, d'affichage et de légende ; libellés de la notice du PLU (plub_pprizone)
ZONES = [
    ("R", "Zone rouge", (206, 62, 62), False),
    ("V", "Zone verte", (88, 168, 106), False),
    ("BS", "Zone bleu sombre", (40, 92, 204), False),
    ("BSH", "Zone bleu sombre hachurée", (40, 92, 204), True),
    ("BC", "Zone bleu clair", (104, 176, 236), False),
    ("BCH", "Zone bleu clair hachurée", (104, 176, 236), True),
]
CAVES_COLOR = (236, 170, 64)


def code_etat(nom):
    n = nom.lower()
    for mot, code in (("rouge", "R"), ("verte", "V")):
        if mot in n:
            return code
    teinte = "BS" if "sombre" in n else "BC" if "clair" in n else None
    if teinte is None:
        raise ValueError(f"zone du PPRI inconnue : {nom}")
    return teinte + ("H" if "hachur" in n else "")


def ll_to_m(g):
    return transform(lambda x, y, z=None: ((np.asarray(x) - LNG0) * MX, (np.asarray(y) - LAT0) * MY), g)


etat = {}
shp = shapefile.Reader(str(next((RAW / "ppri_etat").rglob("*.shp")).with_suffix("")), encoding="utf-8")
for sr in shp.iterShapeRecords():
    g = transform(L93.transform, shape(sr.shape.__geo_interface__)).buffer(0)
    etat.setdefault(code_etat(sr.record["codezone"]), []).append(ll_to_m(g))
etat = {k: unary_union(v) for k, v in etat.items()}
ville = {}
for f in load_geojson(RAW / "plub_pprizone.geojson"):
    ville.setdefault(f["properties"]["zonage"], []).append(to_m(shape(f["geometry"]).buffer(0)))
ville = {k: unary_union(v) for k, v in ville.items()}
caves = unary_union([to_m(shape(f["geometry"]).buffer(0)) for f in load_geojson(RAW / "zones-de-caves-inondees-1910.geojson")])
for g in [*etat.values(), *ville.values(), caves]:
    shapely.prepare(g)

# appartenance de chaque bâtiment (point représentatif de l'emprise) ; les pièces de la tour
# Eiffel restent comptées dans la période 1851-1914, comme dans la légende
counted = np.concatenate([keep, np.where(is_eiffel)[0]])
per_idx = np.array([CODE_TO_IDX.get(feats[i]["properties"].get("c_perconst"), CODE_TO_IDX[99]) for i in keep]
                   + [CODE_TO_IDX[3]] * int(is_eiffel.sum()))


def zone_of(zones):
    z = np.zeros(len(feats), dtype=np.uint8)
    for k, (code, *_r) in enumerate(ZONES):
        if code in zones:
            hit = shapely.contains_xy(zones[code], cx_m, cy_m) & (z == 0)
            z[hit] = k + 1
    return z


zone_etat, zone_ville = zone_of(etat), zone_of(ville)
cave = shapely.contains_xy(caves, cx_m, cy_m)
P = len(PERIODS)


def by_period(sel):
    return np.bincount(per_idx[sel[counted]], minlength=P).tolist()


zones_out = []
for k, (code, label, color, hatch) in enumerate(ZONES):
    a, b = etat.get(code), ville.get(code)
    inter = a.intersection(b).area if a is not None and b is not None else 0.0
    zones_out.append({
        "code": code, "label": label, "color": list(color), "hatch": hatch,
        "areaKm2": round(a.intersection(mask_m).area / 1e6, 3) if a is not None else 0,
        "buildings": int((zone_etat[counted] == k + 1).sum()),
        "byPeriod": by_period(zone_etat == k + 1),
        "check": {
            "areaEtatKm2": round(a.area / 1e6, 3) if a is not None else 0,
            "areaVilleKm2": round(b.area / 1e6, 3) if b is not None else 0,
            "iou": round(inter / a.union(b).area, 3) if a is not None and b is not None else None,
            "buildingsVille": int((zone_ville[counted] == k + 1).sum()),
        },
    })
in_ppri, in_ville = zone_etat > 0, zone_ville > 0
ue, uv = unary_union(list(etat.values())), unary_union(list(ville.values()))
agree = int((zone_etat[counted] == zone_ville[counted]).sum())
risques = {
    "zones": zones_out,
    "cavesColor": list(CAVES_COLOR),
    "total": int(len(counted)),
    "sets": {
        "ppri": {"count": int(in_ppri[counted].sum()), "byPeriod": by_period(in_ppri)},
        "caves": {"count": int(cave[counted].sum()), "byPeriod": by_period(cave)},
        "both": {"count": int((in_ppri | cave)[counted].sum()), "byPeriod": by_period(in_ppri | cave)},
    },
    "cavesAreaKm2": round(caves.intersection(mask_m).area / 1e6, 3),
    "check": {
        "iouTotal": round(ue.intersection(uv).area / ue.union(uv).area, 4),
        "sameZoneBuildings": agree,
        "sameZoneShare": round(agree / len(counted), 5),
    },
    "sources": [
        {"name": "DRIEAT Île-de-France, Plan de prévention des risques d'inondation à Paris, zonage réglementaire",
         "licence": "Licence Ouverte 2.0",
         "url": "https://www.data.gouv.fr/datasets/plan-de-prevention-des-risques-dinondation-a-paris"},
        {"name": "Ville de Paris, PLU bioclimatique : secteurs de risque, inondations (rapprochement)",
         "licence": "ODbL", "url": "https://opendata.paris.fr/explore/dataset/plub_pprizone"},
        {"name": "Ville de Paris, Zones des caves inondées : crue type 1910",
         "licence": "ODbL", "url": "https://opendata.paris.fr/explore/dataset/zones-de-caves-inondees-1910"},
    ],
}
print(f"  PPRI : {risques['sets']['ppri']['count']} bâtiments en zone, rapprochement État / Ville : "
      f"IoU {risques['check']['iouTotal']}, même zone pour {100 * risques['check']['sameZoneShare']:.2f} % des bâtiments")
print(f"  caves (crue type 1910) : {risques['sets']['caves']['count']} bâtiments")
for z in zones_out:
    print(f"    {z['label']:28} {z['areaKm2']:6.3f} km² dans le périmètre, {z['buildings']:6d} bâtiments "
          f"(Ville : {z['check']['buildingsVille']}, IoU {z['check']['iou']})")

# par polygone bâti, dans l'ordre de buildings.bin
feat_idx = np.array(a_feat)
(OUT / "risques.bin").write_bytes((zone_etat[feat_idx] | (cave[feat_idx].astype(np.uint8) << 3)).astype(np.uint8).tobytes())

# textures posées sur le relief, dans l'emprise de ground.webp ; l'eau et l'extérieur restent vides
RW = TEX_W                            # même résolution que le sol
RH = int(round(RW * TEX_H / TEX_W))
rx, ry = RW / (E_LNG - W_LNG), RH / (N_LAT - S_LAT)


def rpx(coords):
    return [((x - W_LNG) * rx, (N_LAT - y) * ry) for x, y in coords]


def raster(geom_m):
    im = Image.new("L", (RW, RH), 0)
    d = ImageDraw.Draw(im)
    for poly in polys(geom_m.intersection(mask_m)):
        pl = to_ll(poly)
        d.polygon(rpx(pl.exterior.coords), fill=255)
        for hole in pl.interiors:
            d.polygon(rpx(hole.coords), fill=0)
    return np.array(im) > 0


hole = np.array(water_img.resize((RW, RH), Image.NEAREST)) > 0
yy, xx = np.mgrid[0:RH, 0:RW]
stripes = (xx + yy) % 9 < 3           # hachures du PPRI, à 45°, une ligne tous les 8 m environ
cross = (xx - yy) % 8 < 2             # hachures des caves, dans l'autre sens
ppri_rgba = np.zeros((RH, RW, 4), dtype=np.uint8)
for code, label, color, hatch in reversed(ZONES):   # la zone prioritaire est peinte en dernier
    if code not in etat:
        continue
    m = raster(etat[code])
    ppri_rgba[m, :3] = color
    ppri_rgba[m, 3] = 165
    if hatch:
        ppri_rgba[m & stripes, :3] = np.minimum(np.array(color) + 70, 255)
        ppri_rgba[m & stripes, 3] = 230
ppri_rgba[hole] = 0
caves_rgba = np.zeros((RH, RW, 4), dtype=np.uint8)
m = raster(caves) & cross
caves_rgba[m, :3] = CAVES_COLOR
caves_rgba[m, 3] = 210
caves_rgba[hole] = 0
del yy, xx, stripes, cross
Image.fromarray(ppri_rgba).save(OUT / "risque-ppri.webp", lossless=True, quality=100, method=6)
Image.fromarray(caves_rgba).save(OUT / "risque-caves.webp", lossless=True, quality=100, method=6)
json.dump(risques, open(OUT / "risques.json", "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print(f"  textures {RW} x {RH} px : risque-ppri.webp {(OUT / 'risque-ppri.webp').stat().st_size / 1e3:.0f} ko, "
      f"risque-caves.webp {(OUT / 'risque-caves.webp').stat().st_size / 1e3:.0f} ko")

# ---------------------------------------------------------------- contexte et métadonnées
json.dump({
    "water": water_out, "walls": walls, "arrPaths": paths_out, "arrLabels": arr_labels,
    "mask": [[round(x, 7), round(y, 7)] for x, y in mask_ll.exterior.coords],
}, open(OUT / "context.json", "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))

eiffel_z = float(dem_at(*EIFFEL))
total_n, total_a = stats_count.sum(), stats_area.sum()
meta = {
    "origin": ORIGIN,
    "bounds": [W_LNG, S_LAT, E_LNG, N_LAT],
    "grid": {"nx": NX, "ny": NY, "cell": CELL},
    "texture": {"width": TEX_W, "height": TEX_H},
    "yearMin": YEAR0, "yearMax": YEAR_MAX,
    "seineLevel": SEINE_LEVEL, "plinthBase": PLINTH_BASE,
    "periods": [
        {"code": code, "label": label, "count": int(stats_count[i]),
         "share": round(float(stats_count[i] / total_n), 5),
         "areaShare": round(float(stats_area[i] / total_a), 5),
         "start": s, "end": e}
        for i, (code, label, s, e) in enumerate(PERIODS)
    ],
    "buildings": {"count": N, "features": int(total_n), "vertices": V, "indices": T, "sections": building_sections},
    "trees": {"count": int(len(tx)), "sections": tree_sections},
    "eiffel": {"lng": EIFFEL[0], "lat": EIFFEL[1], "z": round(eiffel_z, 1), "year": 1889, "period": 2},
    "sources": [
        {"name": "Apur, Emprise bâtie Paris", "licence": "ODbL", "url": "https://carto2.apur.org/apur/rest/services/OPENDATA/EMPRISE_BATIE_PARIS/MapServer/0"},
        {"name": "Ville de Paris, Arrondissements", "licence": "ODbL", "url": "https://opendata.paris.fr/explore/dataset/arrondissements"},
        {"name": "Ville de Paris, Plan de voirie : voies d'eau", "licence": "ODbL", "url": "https://opendata.paris.fr/explore/dataset/plan-de-voirie-voies-deau"},
        {"name": "Ville de Paris, Espaces verts et assimilés", "licence": "ODbL", "url": "https://opendata.paris.fr/explore/dataset/espaces_verts"},
        {"name": "Ville de Paris, Les arbres", "licence": "ODbL", "url": "https://opendata.paris.fr/explore/dataset/les-arbres"},
        *risques["sources"],
    ],
    "risques": {"ppri": risques["sets"]["ppri"]["count"], "caves": risques["sets"]["caves"]["count"],
                "sameZoneShare": risques["check"]["sameZoneShare"], "iouTotal": risques["check"]["iouTotal"]},
}
json.dump(meta, open(OUT / "meta.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("Terminé :", ", ".join(sorted(p.name for p in OUT.iterdir())))
