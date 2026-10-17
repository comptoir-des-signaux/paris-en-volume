// Calques deck.gl de la carte.
import {COORDINATE_SYSTEM} from '@deck.gl/core';
import {PathLayer, SolidPolygonLayer, TextLayer} from '@deck.gl/layers';
import {SimpleMeshLayer} from '@deck.gl/mesh-layers';
import {PathStyleExtension} from '@deck.gl/extensions';
import {AlphaCutExtension, FogExtension, TimelineExtension} from './timeline-extension.js';
import {cone, cylinder, eiffelMesh, icosahedron, terrainMesh, wallsMesh} from './meshes.js';

// Du plus ancien au plus récent : des teintes chaudes et minérales vers des teintes froides,
// l'or de la pierre de taille au centre (1851-1914, près de la moitié du parc).
export const PALETTE = [
  [143, 45, 59],    // Avant 1800 : lie-de-vin
  [196, 81, 58],    // 1801-1850 : brique
  [230, 172, 88],   // 1851-1914 : pierre dorée
  [243, 216, 150],  // 1915-1939 : ocre clair
  [163, 201, 152],  // 1940-1967 : sauge
  [78, 180, 166],   // 1968-1975 : sarcelle
  [62, 148, 196],   // 1976-1981 : bleu acier
  [86, 112, 216],   // 1982-1989 : outremer
  [128, 96, 214],   // 1990-1999 : violet
  [182, 94, 206],   // 2000-2007 : orchidée
  [240, 88, 156],   // 2008 et après : magenta
  [128, 132, 140]   // Non daté : gris
];

export const TREE_CLASSES = [
  ['Platane', [86, 128, 70]],
  ['Marronnier', [60, 112, 62]],
  ['Tilleul', [118, 150, 74]],
  ['Érable', [96, 138, 64]],
  ['Sophora, robinier, févier', [110, 156, 84]],
  ['Fruitier d\'ornement', [176, 120, 136]],
  ['Conifère', [44, 92, 72]],
  ['Ginkgo', [150, 164, 70]],
  ['Frêne, micocoulier, orme', [82, 126, 80]],
  ['Chêne, hêtre', [70, 112, 58]],
  ['Autre essence', [92, 134, 78]]
];

const BUILDING_MATERIAL = {ambient: 0.42, diffuse: 0.62, shininess: 28, specularColor: [70, 64, 56]};
const TREE_MATERIAL = {ambient: 0.5, diffuse: 0.6, shininess: 8, specularColor: [20, 24, 20]};
const WATER_MATERIAL = {ambient: 0.5, diffuse: 0.45, shininess: 160, specularColor: [255, 236, 200]};
const TERRAIN_MATERIAL = {ambient: 0.62, diffuse: 0.55, shininess: 4, specularColor: [0, 0, 0]};
const WALL_MATERIAL = {ambient: 0.55, diffuse: 0.5, shininess: 6, specularColor: [10, 10, 10]};
const HIGHLIGHT = [255, 248, 230, 110];
const FOG_COLOR = [0.105, 0.125, 0.175];
const ALWAYS_ON_TOP = {depthCompare: 'always'};
// voile posé sur le relief : n'écrit pas la profondeur, et passe devant le sol qu'il recouvre
const DRAPE = {depthWriteEnabled: false, depthBias: -2, depthBiasSlopeScale: -2};
const NOT_EXPOSED = [70, 74, 82];
const TEXTURE_PARAMETERS = {
  minFilter: 'linear',
  magFilter: 'linear',
  mipmapFilter: 'linear',
  addressModeU: 'clamp-to-edge',
  addressModeV: 'clamp-to-edge',
  maxAnisotropy: 8
};

export function createStaticResources(data) {
  const {geo, meta, buildings, trees, context, dem} = data;
  const origin = [geo.lng0, geo.lat0, 0];
  const offsets = {coordinateSystem: COORDINATE_SYSTEM.LNGLAT_OFFSETS, coordinateOrigin: origin};

  // accesseurs stables (une seule évaluation par attribut)
  const bAcc = {
    getElevation: (_, {index}) => buildings.elevation[index],
    getTimeRange: (_, {index, target}) => {
      target[0] = buildings.yearStart[index];
      target[1] = buildings.yearEnd[index];
      target[2] = buildings.period[index];
      return target;
    }
  };

  // arbres : trois familles de formes, une couleur par genre légèrement variée
  const deciduous = [];
  const conifers = [];
  for (let i = 0; i < trees.count; i++) (trees.genus[i] === 6 ? conifers : deciduous).push(i);
  const jitter = i => ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1;
  const treeColor = i => {
    const base = TREE_CLASSES[Math.min(trees.genus[i], TREE_CLASSES.length - 1)][1];
    const j = 0.82 + jitter(i) * 0.3;
    return [base[0] * j, base[1] * j, base[2] * j, 255];
  };
  const treePos = (i, dz, target) => {
    target[0] = trees.pos[i * 3];
    target[1] = trees.pos[i * 3 + 1];
    target[2] = trees.pos[i * 3 + 2] + dz;
    return target;
  };

  const water = context.water.map(w => ({
    seine: w.seine,
    // le plan d'eau est un volume : sa tranche apparaît au bord du socle
    polygon: w.rings.map(r => r.map(([x, y, z]) => [x - geo.lng0, y - geo.lat0, meta.plinthBase])),
    level: w.rings[0].reduce((s, p) => s + p[2], 0) / w.rings[0].length
  }));

  return {
    offsets,
    bAcc,
    one: [0],
    eiffelData: [meta.eiffel],
    treeData: {length: trees.count},
    ext: (() => {
      const fog = new FogExtension();
      return {
        fog: [fog],
        timelineGrow: [new TimelineExtension({grow: true}), fog],
        timeline: [new TimelineExtension(), fog],
        alphaCut: [new AlphaCutExtension(), fog],
        dash: [new PathStyleExtension({dash: true})]
      };
    })(),
    deciduous,
    conifers,
    treeColor,
    treePos,
    water,
    terrain: terrainMesh(dem, geo),
    walls: wallsMesh(context.walls, geo),
    ico: icosahedron(),
    cone: cone(),
    trunk: cylinder(),
    eiffel: eiffelMesh(),
    arrPaths: context.arrPaths.map(p => p.map(([x, y, z]) => [x - geo.lng0, y - geo.lat0, z])),
    labels: context.arrLabels,
    rim: [context.walls.find(w => w.plinth).pts.map(([x, y, z]) => [x - geo.lng0, y - geo.lat0, z + 0.3])]
  };
}

// Bits de risques.bin : zone du PPRI (0-2), secteur de caves inondées en crue type 1910 (3)
export function exposureMask(ui) {
  return (ui.showPpri ? 7 : 0) | (ui.showCaves ? 8 : 0);
}

// Couleur du bâti : sa période ; en mode « exposés », gris hors des zones de risque affichées,
// et pour les bâtiments exposés, au choix leur période ou leur zone (le zonage du PPRI suit le
// parcellaire : il couvre les îlots, que les bâtiments masquent, d'où sa lecture sur le bâti)
function buildingColor(data, ui) {
  const b = data.buildings;
  const mask = ui.exposedOnly && data.risques ? exposureMask(ui) : 0;
  if (!mask) return {getFillColor: (_, {index}) => PALETTE[b.period[index]], key: 0};
  const {flags, stats} = data.risques;
  if (ui.exposedColor !== 'zone') {
    return {getFillColor: (_, {index}) => (flags[index] & mask ? PALETTE[b.period[index]] : NOT_EXPOSED), key: mask};
  }
  const zoneColors = stats.zones.map(z => z.color);
  return {
    getFillColor: (_, {index}) => {
      const f = flags[index] & mask;
      return f & 7 ? zoneColors[(f & 7) - 1] : f ? stats.cavesColor : NOT_EXPOSED;
    },
    key: `${mask}z`
  };
}

function drape(id, res, texture, lift, fog) {
  return new SimpleMeshLayer({
    id,
    ...res.offsets,
    data: res.one,
    mesh: res.terrain,
    texture,
    textureParameters: TEXTURE_PARAMETERS,
    _instanced: false,
    getPosition: [0, 0, lift],
    getColor: [255, 255, 255],
    material: TERRAIN_MATERIAL,
    extensions: res.ext.fog,
    ...fog,
    parameters: DRAPE,
    pickable: false
  });
}

export function buildLayers(data, res, ui) {
  const {geo, meta, buildings, trees, image, risques} = data;
  const color = buildingColor(data, ui);
  const {offsets, bAcc} = res;
  const fog = ui.flying
    ? {fogRange: [900, 9000, 0.85], fogColor: FOG_COLOR}
    : {fogRange: [4000, 24000, 0.6], fogColor: FOG_COLOR};
  const timeline = {
    ...fog,
    timelineYear: ui.year,
    highlightPeriod: ui.highlight,
    highlightMix: ui.highlightMix,
    ghostAlpha: 0.34,
    glow: ui.glow
  };
  const layers = [
    new SimpleMeshLayer({
      id: 'terrain',
      ...offsets,
      data: res.one,
      mesh: res.terrain,
      texture: image,
      textureParameters: TEXTURE_PARAMETERS,
      _instanced: false,
      getPosition: [0, 0, 0],
      getColor: [255, 255, 255],
      material: TERRAIN_MATERIAL,
      extensions: res.ext.alphaCut,
      ...fog,
      pickable: false
    }),
    new SolidPolygonLayer({
      id: 'water',
      ...offsets,
      data: res.water,
      getPolygon: d => d.polygon,
      positionFormat: 'XYZ',
      extruded: true,
      getElevation: d => d.level - meta.plinthBase,
      getFillColor: d => (d.seine ? [44, 92, 132] : [52, 104, 138]),
      material: WATER_MATERIAL,
      extensions: res.ext.fog,
      ...fog,
      pickable: false
    }),
    new SimpleMeshLayer({
      id: 'walls',
      ...offsets,
      data: res.one,
      mesh: res.walls,
      _instanced: false,
      getPosition: [0, 0, 0],
      getColor: [255, 255, 255],
      material: WALL_MATERIAL,
      extensions: res.ext.fog,
      ...fog,
      pickable: false
    }),
    new PathLayer({
      id: 'rim',
      ...offsets,
      data: res.rim,
      getPath: d => d,
      positionFormat: 'XYZ',
      getColor: [226, 190, 120, 150],
      getWidth: 1.4,
      widthUnits: 'pixels',
      pickable: false
    }),
    risques && ui.showCaves && drape('risque-caves', res, risques.caves, 1.2, fog),
    risques && ui.showPpri && drape('risque-ppri', res, risques.ppri, 0.8, fog),
    ui.showDistricts &&
      new PathLayer({
        id: 'districts',
        ...offsets,
        data: res.arrPaths,
        getPath: d => d,
        positionFormat: 'XYZ',
        getColor: [236, 214, 170, 120],
        getWidth: 1.2,
        widthUnits: 'pixels',
        getDashArray: [5, 4],
        dashJustified: true,
        extensions: res.ext.dash,
        pickable: false
      }),
    new SolidPolygonLayer({
      id: 'buildings',
      ...offsets,
      data: buildings.data,
      positionFormat: 'XYZ',
      _normalize: false,
      _windingOrder: 'CCW',
      extruded: true,
      ...bAcc,
      getFillColor: color.getFillColor,
      updateTriggers: {getFillColor: color.key},
      material: BUILDING_MATERIAL,
      extensions: res.ext.timelineGrow,
      ...timeline,
      pickable: !ui.flying,
      autoHighlight: true,
      highlightColor: HIGHLIGHT
    }),
    new SimpleMeshLayer({
      id: 'eiffel',
      ...offsets,
      data: res.eiffelData,
      mesh: res.eiffel,
      getPosition: d => [d.lng - geo.lng0, d.lat - geo.lat0, d.z],
      getColor: PALETTE[meta.eiffel.period],
      getTimeRange: d => [d.year, d.year, d.period],
      material: BUILDING_MATERIAL,
      extensions: res.ext.timeline,
      ...timeline,
      pickable: !ui.flying,
      autoHighlight: true,
      highlightColor: HIGHLIGHT
    })
  ];

  if (ui.showTrees) {
    const common = {...offsets, material: TREE_MATERIAL, pickable: !ui.flying, extensions: res.ext.fog, ...fog};
    layers.push(
      new SimpleMeshLayer({
        id: 'trunks',
        ...offsets,
        data: res.treeData,
        mesh: res.trunk,
        getPosition: (_, {index, target}) => res.treePos(index, 0, target),
        getScale: (_, {index}) => {
          const r = trees.radius[index];
          return [0.12 + r * 0.035, 0.12 + r * 0.035, Math.max(1.2, trees.height[index] - 1.5 * r)];
        },
        getColor: [92, 74, 60],
        material: TREE_MATERIAL,
        extensions: res.ext.fog,
        ...fog,
        pickable: false
      }),
      new SimpleMeshLayer({
        id: 'crowns',
        ...common,
        data: res.deciduous,
        mesh: res.ico,
        getPosition: (i, {target}) => res.treePos(i, trees.height[i] - trees.radius[i] * 0.85, target),
        getScale: i => {
          const r = trees.radius[i];
          return [r, r, r * 0.85];
        },
        getOrientation: i => [0, (i * 47) % 360, 0],
        getColor: i => res.treeColor(i)
      }),
      new SimpleMeshLayer({
        id: 'conifers',
        ...common,
        data: res.conifers,
        mesh: res.cone,
        getPosition: (i, {target}) => res.treePos(i, trees.height[i] * 0.18, target),
        getScale: i => {
          const r = trees.radius[i] * 0.75;
          return [r, r, trees.height[i] * 0.82];
        },
        getColor: i => res.treeColor(i)
      })
    );
  }

  if (ui.showLabels && ui.overview && !ui.flying) {
    layers.push(
      new TextLayer({
        id: 'labels',
        ...offsets,
        data: res.labels,
        getPosition: d => [d.lng - geo.lng0, d.lat - geo.lat0, d.z + 150],
        getText: d => d.roman,
        getSize: 30,
        sizeUnits: 'pixels',
        sizeMinPixels: 14,
        sizeMaxPixels: 46,
        fontFamily: '"EB Garamond", Georgia, serif',
        fontWeight: 600,
        characterSet: 'IVXLC',
        fontSettings: {sdf: true, fontSize: 96, buffer: 12, radius: 24},
        outlineWidth: 3,
        outlineColor: [8, 10, 16, 220],
        getColor: [240, 222, 184, 225],
        billboard: true,
        parameters: ALWAYS_ON_TOP,
        pickable: false
      })
    );
  }
  return layers.filter(Boolean);
}
