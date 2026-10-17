// Chargement et décodage des données préparées par scripts/build_data.py.

const TYPES = {uint8: Uint8Array, uint16: Uint16Array, int16: Int16Array, uint32: Uint32Array};

function section(buffer, s) {
  return new TYPES[s.type](buffer, s.offset, s.length);
}

// En production, les données sont servies précompressées (.gz) comme des fichiers ordinaires
// et décompressées ici : la jauge compte alors les octets réellement transférés. Un serveur qui
// envoie lui-même les .gz avec Content-Encoding: gzip (sirv, Apache avec AddEncoding) livre des
// octets déjà décompressés par le navigateur : on ne décompresse donc que sur la signature gzip.
const GZ = import.meta.env.PROD;
const TAILLES = __TAILLES_DONNEES__;

async function fetchWithProgress(url, onBytes) {
  const res = await fetch(GZ ? `${url}.gz` : url);
  if (!res.ok) throw new Error(`${url} : ${res.status}`);
  const compte = res.body.pipeThrough(new TransformStream({
    transform(chunk, ctl) {
      onBytes(chunk.length);
      ctl.enqueue(chunk);
    }
  }));
  const buf = new Uint8Array(await new Response(compte).arrayBuffer());
  if (!GZ || buf[0] !== 0x1f || buf[1] !== 0x8b) return buf.buffer;
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

export async function loadData(onProgress) {
  const meta = await (await fetch('data/meta.json')).json();
  // volumes réellement transférés, mesurés au build (vite.config.js)
  const total = ['buildings.bin', 'trees.bin', 'dem.bin', 'arr.bin', 'context.json']
    .reduce((a, f) => a + TAILLES[f], 0);
  let loaded = 0;
  const tick = n => {
    loaded += n;
    onProgress(Math.min(loaded / total, 0.98));
  };
  const [bBuf, tBuf, demBuf, arrBuf, ctxBuf, image] = await Promise.all([
    fetchWithProgress('data/buildings.bin', tick),
    fetchWithProgress('data/trees.bin', tick),
    fetchWithProgress('data/dem.bin', tick),
    fetchWithProgress('data/arr.bin', tick),
    fetchWithProgress('data/context.json', tick),
    fetch('data/ground.webp').then(r => r.blob()).then(b => createImageBitmap(b))
  ]);
  const context = JSON.parse(new TextDecoder().decode(ctxBuf));
  const geo = makeGeo(meta);
  return {
    meta,
    geo,
    context,
    image,
    buildings: decodeBuildings(meta, geo, bBuf),
    trees: decodeTrees(meta, geo, tBuf),
    dem: new Int16Array(demBuf),
    arr: new Uint8Array(arrBuf)
  };
}

// Couches du risque d'inondation : chargées au premier affichage seulement (sobriété)
export async function loadRisques() {
  const noop = () => {};
  const image = url => fetch(url).then(r => r.blob()).then(b => createImageBitmap(b));
  const [stats, flags, ppri, caves] = await Promise.all([
    fetchWithProgress('data/risques.json', noop).then(b => JSON.parse(new TextDecoder().decode(b))),
    fetchWithProgress('data/risques.bin', noop).then(b => new Uint8Array(b)),
    image('data/risque-ppri.webp'),
    image('data/risque-caves.webp')
  ]);
  return {stats, flags, ppri, caves};
}

// Repère : décalages en degrés autour de l'origine (COORDINATE_SYSTEM.LNGLAT_OFFSETS)
function makeGeo(meta) {
  const [W, S, E, N] = meta.bounds;
  const [lng0, lat0] = meta.origin;
  const phi = (lat0 * Math.PI) / 180;
  return {
    W, S, E, N, lng0, lat0,
    qx: 65535 / (E - W),
    qy: 65535 / (N - S),
    mx: 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi),
    my: 111132.954 - 559.822 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi),
    nx: meta.grid.nx,
    ny: meta.grid.ny,
    dlng: (E - W) / (meta.grid.nx - 1),
    dlat: (N - S) / (meta.grid.ny - 1)
  };
}

function decodeBuildings(meta, geo, buffer) {
  const s = meta.buildings.sections;
  const q = section(buffer, s.positions);
  const valid8 = section(buffer, s.vertexValid);
  const starts = section(buffer, s.startIndices);
  const triStart = section(buffer, s.triStart);
  const local = section(buffer, s.indices);
  const base = section(buffer, s.base);
  const n = starts.length - 1;
  const V = valid8.length;

  const positions = new Float32Array(V * 3);
  const offX = geo.W - geo.lng0;
  const offY = geo.N - geo.lat0;
  for (let p = 0; p < n; p++) {
    const z = base[p] / 10;
    for (let v = starts[p]; v < starts[p + 1]; v++) {
      positions[v * 3] = offX + q[v * 2] / geo.qx;
      positions[v * 3 + 1] = offY - q[v * 2 + 1] / geo.qy;
      positions[v * 3 + 2] = z;
    }
  }
  const indices = new Uint32Array(local.length);
  for (let p = 0; p < n; p++) {
    const o = starts[p];
    for (let k = triStart[p]; k < triStart[p + 1]; k++) indices[k] = local[k] + o;
  }
  const vertexValid = new Uint16Array(valid8);

  // une emprise découpée en plusieurs polygones n'est comptée qu'une fois
  const ids = section(buffer, s.id);
  const first = new Uint8Array(n);
  for (let p = 0; p < n; p++) first[p] = p === 0 || ids[p] === 0 || ids[p] !== ids[p - 1] ? 1 : 0;

  const elevationDm = section(buffer, s.elevation);
  const elevation = new Float32Array(n);
  const top = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    elevation[p] = elevationDm[p] / 10;
    top[p] = base[p] / 10 + elevation[p];
  }
  return {
    count: n,
    data: {
      length: n,
      startIndices: starts,
      attributes: {
        getPolygon: {value: positions, size: 3},
        indices,
        instanceVertexValid: {value: vertexValid, size: 1}
      }
    },
    positions,
    starts,
    elevation,
    top,
    first,
    height: section(buffer, s.height),
    ground: section(buffer, s.ground),
    period: section(buffer, s.period),
    yearStart: section(buffer, s.yearStart),
    yearEnd: section(buffer, s.yearEnd),
    year: section(buffer, s.year),
    arrondissement: section(buffer, s.arrondissement)
  };
}

function decodeTrees(meta, geo, buffer) {
  const s = meta.trees.sections;
  const x = section(buffer, s.x);
  const y = section(buffer, s.y);
  const z = section(buffer, s.z);
  const h = section(buffer, s.height);
  const r = section(buffer, s.radius);
  const genus = section(buffer, s.genus);
  const n = x.length;
  const pos = new Float32Array(n * 3);
  const height = new Float32Array(n);
  const radius = new Float32Array(n);
  const offX = geo.W - geo.lng0;
  const offY = geo.N - geo.lat0;
  for (let i = 0; i < n; i++) {
    pos[i * 3] = offX + x[i] / geo.qx;
    pos[i * 3 + 1] = offY - y[i] / geo.qy;
    pos[i * 3 + 2] = z[i] / 10;
    height[i] = h[i] / 4;
    radius[i] = r[i] / 20;
  }
  return {count: n, pos, height, radius, genus};
}

// Échantillonnage bilinéaire d'une grille (relief, surface des toits) en lng/lat absolus
export function sampleGrid(grid, geo, lng, lat, scale = 0.1) {
  let i = (lng - geo.W) / geo.dlng;
  let j = (geo.N - lat) / geo.dlat;
  if (i < 0 || j < 0 || i > geo.nx - 1.001 || j > geo.ny - 1.001) return null;
  const i0 = Math.floor(i);
  const j0 = Math.floor(j);
  const fi = i - i0;
  const fj = j - j0;
  const k = j0 * geo.nx + i0;
  return (
    (grid[k] * (1 - fi) * (1 - fj) +
      grid[k + 1] * fi * (1 - fj) +
      grid[k + geo.nx] * (1 - fi) * fj +
      grid[k + geo.nx + 1] * fi * fj) *
    scale
  );
}

export function cellValue(grid, geo, lng, lat) {
  const i = Math.round((lng - geo.W) / geo.dlng);
  const j = Math.round((geo.N - lat) / geo.dlat);
  if (i < 0 || j < 0 || i >= geo.nx || j >= geo.ny) return 0;
  return grid[j * geo.nx + i];
}

// Surface des toits (MNS) : altitude maximale bâtie par maille, pour l'alerte d'obstacle
export function buildSurfaceGrid(data) {
  const {geo, dem, buildings} = data;
  const surf = new Float32Array(dem.length);
  for (let k = 0; k < dem.length; k++) surf[k] = dem[k] / 10;
  const {positions, starts, top, count} = buildings;
  for (let p = 0; p < count; p++) {
    let cx = 0;
    let cy = 0;
    const a = starts[p];
    const b = starts[p + 1];
    for (let v = a; v < b; v++) {
      const lng = positions[v * 3] + geo.lng0;
      const lat = positions[v * 3 + 1] + geo.lat0;
      cx += lng;
      cy += lat;
      mark(lng, lat);
    }
    mark(cx / (b - a), cy / (b - a));
    function mark(lng, lat) {
      const i = Math.round((lng - geo.W) / geo.dlng);
      const j = Math.round((geo.N - lat) / geo.dlat);
      if (i < 0 || j < 0 || i >= geo.nx || j >= geo.ny) return;
      const k = j * geo.nx + i;
      if (top[p] > surf[k]) surf[k] = top[p];
    }
  }
  return surf;
}
