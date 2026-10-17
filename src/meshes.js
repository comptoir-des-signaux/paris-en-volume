// Géométries construites dans le navigateur : sol en relief, quais et socle,
// houppiers, troncs et tour Eiffel.

function meshFrom(positions, {normals = null, colors = null, texCoords = null, indices = null} = {}) {
  const n = positions.length / 3;
  const attributes = {
    positions: {value: positions, size: 3},
    colors: {value: colors || new Float32Array(n * 3).fill(1), size: 3},
    texCoords: {value: texCoords || new Float32Array(n * 2), size: 2}
  };
  if (normals) attributes.normals = {value: normals, size: 3};
  const mesh = {attributes};
  if (indices) mesh.indices = {value: indices, size: 1};
  return mesh;
}

// Sol : grille du relief (pas doublé, 20 m), positions en décalages de degrés
export function terrainMesh(dem, geo, step = 2) {
  const nx = Math.floor((geo.nx - 1) / step) + 1;
  const ny = Math.floor((geo.ny - 1) / step) + 1;
  const positions = new Float32Array(nx * ny * 3);
  const normals = new Float32Array(nx * ny * 3);
  const uv = new Float32Array(nx * ny * 2);
  const z = (i, j) => {
    const ii = Math.min(Math.max(i, 0), nx - 1) * step;
    const jj = Math.min(Math.max(j, 0), ny - 1) * step;
    return dem[jj * geo.nx + ii] / 10;
  };
  const cx = geo.dlng * step * geo.mx;
  const cy = geo.dlat * step * geo.my;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const gi = i * step;
      const gj = j * step;
      positions[k * 3] = geo.W + gi * geo.dlng - geo.lng0;
      positions[k * 3 + 1] = geo.N - gj * geo.dlat - geo.lat0;
      positions[k * 3 + 2] = z(i, j);
      const dzdx = (z(i + 1, j) - z(i - 1, j)) / (2 * cx);
      const dzdy = (z(i, j - 1) - z(i, j + 1)) / (2 * cy);
      const l = Math.hypot(dzdx, dzdy, 1);
      normals[k * 3] = -dzdx / l;
      normals[k * 3 + 1] = -dzdy / l;
      normals[k * 3 + 2] = 1 / l;
      uv[k * 2] = gi / (geo.nx - 1);
      uv[k * 2 + 1] = gj / (geo.ny - 1);
    }
  }
  const indices = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let o = 0;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      indices.set([a, c, b, b, c, d], o);
      o += 6;
    }
  }
  return meshFrom(positions, {normals, texCoords: uv, indices});
}

// Murs verticaux : quais (côté eau, à gauche du tracé) et socle de la maquette (côté extérieur)
export function wallsMesh(walls, geo) {
  const pos = [];
  const nor = [];
  const col = [];
  for (const w of walls) {
    const plinth = Boolean(w.plinth);
    const topC = plinth ? [0.2, 0.215, 0.25] : [0.66, 0.62, 0.54];
    const botC = plinth ? [0.035, 0.04, 0.05] : [0.36, 0.34, 0.3];
    const p = w.pts;
    for (let k = 0; k < p.length - 1; k++) {
      const [x1, y1, t1, b1] = p[k];
      const [x2, y2, t2, b2] = p[k + 1];
      const dx = (x2 - x1) * geo.mx;
      const dy = (y2 - y1) * geo.my;
      const l = Math.hypot(dx, dy) || 1;
      const nxv = w.side === 'L' ? -dy / l : dy / l;
      const nyv = w.side === 'L' ? dx / l : -dx / l;
      const X1 = x1 - geo.lng0;
      const Y1 = y1 - geo.lat0;
      const X2 = x2 - geo.lng0;
      const Y2 = y2 - geo.lat0;
      const quad = [
        [X1, Y1, b1, botC], [X2, Y2, b2, botC], [X2, Y2, t2, topC],
        [X1, Y1, b1, botC], [X2, Y2, t2, topC], [X1, Y1, t1, topC]
      ];
      for (const [x, y, z, c] of quad) {
        pos.push(x, y, z);
        nor.push(nxv, nyv, 0);
        col.push(...c);
      }
    }
  }
  return meshFrom(new Float32Array(pos), {normals: new Float32Array(nor), colors: new Float32Array(col)});
}

// Houppier à facettes (icosaèdre) : l'esthétique d'une maquette d'architecte
export function icosahedron() {
  const t = (1 + Math.sqrt(5)) / 2;
  const v = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]
  ].map(([x, y, z]) => {
    const l = Math.hypot(x, y, z);
    return [x / l, z / l, y / l];
  });
  const f = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]
  ];
  const pos = [];
  for (const tri of f) for (const i of tri) pos.push(...v[i]);
  return meshFrom(new Float32Array(pos));
}

export function cone(segments = 7) {
  const pos = [];
  for (let s = 0; s < segments; s++) {
    const a1 = (s / segments) * Math.PI * 2;
    const a2 = ((s + 1) / segments) * Math.PI * 2;
    pos.push(Math.cos(a1), Math.sin(a1), 0, Math.cos(a2), Math.sin(a2), 0, 0, 0, 1);
  }
  return meshFrom(new Float32Array(pos));
}

export function cylinder(segments = 6) {
  const pos = [];
  for (let s = 0; s < segments; s++) {
    const a1 = (s / segments) * Math.PI * 2;
    const a2 = ((s + 1) / segments) * Math.PI * 2;
    const [c1, s1, c2, s2] = [Math.cos(a1), Math.sin(a1), Math.cos(a2), Math.sin(a2)];
    pos.push(c1, s1, 0, c2, s2, 0, c2, s2, 1, c1, s1, 0, c2, s2, 1, c1, s1, 1);
  }
  return meshFrom(new Float32Array(pos));
}

// Tour Eiffel : quatre piles galbées, plateformes, fût et antenne (mètres, base au sol)
export function eiffelMesh() {
  const pos = [];
  const quad = (a, b, c, d) => pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  // tronc de pyramide à section carrée le long d'une suite de sections [cx, cy, z, demi-côté]
  const loft = sections => {
    for (let k = 0; k < sections.length - 1; k++) {
      const [x1, y1, z1, h1] = sections[k];
      const [x2, y2, z2, h2] = sections[k + 1];
      const c1 = [[x1 - h1, y1 - h1], [x1 + h1, y1 - h1], [x1 + h1, y1 + h1], [x1 - h1, y1 + h1]];
      const c2 = [[x2 - h2, y2 - h2], [x2 + h2, y2 - h2], [x2 + h2, y2 + h2], [x2 - h2, y2 + h2]];
      for (let s = 0; s < 4; s++) {
        const n = (s + 1) % 4;
        quad([...c1[s], z1], [...c1[n], z1], [...c2[n], z2], [...c2[s], z2]);
      }
    }
    const [x, y, z, h] = sections[sections.length - 1];
    quad([x - h, y - h, z], [x + h, y - h, z], [x + h, y + h, z], [x - h, y + h, z]);
  };
  const box = (h, z1, z2) => loft([[0, 0, z1, h], [0, 0, z2, h]]);
  for (const [sx, sy] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
    const sec = [];
    for (let i = 0; i <= 10; i++) {
      const z = (i / 10) * 116;
      const c = 50 * Math.exp(-z / 80);
      sec.push([sx * c, sy * c, z, 12.5 * Math.exp(-z / 150)]);
    }
    loft(sec);
  }
  box(33, 57, 64);          // premier étage
  box(19.5, 115, 119);      // deuxième étage
  const shaft = [];
  for (let i = 0; i <= 12; i++) {
    const z = 116 + (i / 12) * 160;
    shaft.push([0, 0, z, 17 * Math.exp(-(z - 115) / 95)]);
  }
  loft(shaft);
  box(7.5, 274, 283);       // sommet
  loft([[0, 0, 283, 2.2], [0, 0, 300, 1.3], [0, 0, 330, 0.5]]);
  return meshFrom(new Float32Array(pos));
}
