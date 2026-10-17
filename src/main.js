import {
  AmbientLight,
  Deck,
  DirectionalLight,
  FirstPersonView,
  FlyToInterpolator,
  LightingEffect,
  MapView
} from '@deck.gl/core';
// polices servies avec la carte, sous-ensemble latin (accents, guillemets, œ) : aucun appel à un tiers
import '@fontsource/eb-garamond/latin-500.css';
import '@fontsource/eb-garamond/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/instrument-sans/latin-400.css';
import '@fontsource/instrument-sans/latin-500.css';
import '@fontsource/instrument-sans/latin-600.css';
import {buildSurfaceGrid, cellValue, loadData, loadRisques, sampleGrid} from './data.js';
import {FLIGHT_FOVY, FlightController} from './flight.js';
import {PALETTE, TREE_CLASSES, buildLayers, createStaticResources, exposureMask} from './layers.js';

const $ = id => document.getElementById(id);
const fmt = new Intl.NumberFormat('fr-FR');
const fmt1 = new Intl.NumberFormat('fr-FR', {minimumFractionDigits: 1, maximumFractionDigits: 1});
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII',
  'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX'];
const ordinal = n => (n === 1 ? '1er' : `${n}e`);

const PRESETS = [
  {name: "Vue d'ensemble", sub: 'Paris intra-muros', view: {longitude: 2.3330, latitude: 48.8510, zoom: 12.3, pitch: 50, bearing: -14}},
  {name: 'Île de la Cité, Marais', sub: 'le cœur ancien', view: {longitude: 2.3522, latitude: 48.8546, zoom: 15.6, pitch: 62, bearing: 32}},
  {name: "Étoile et Champs-Élysées", sub: 'la ville haussmannienne', view: {longitude: 2.2985, latitude: 48.8722, zoom: 15.3, pitch: 50, bearing: 70}},
  {name: 'Butte Montmartre', sub: 'le relief et le Sacré-Cœur', view: {longitude: 2.3431, latitude: 48.8860, zoom: 15.6, pitch: 72, bearing: 8}},
  {name: 'Tour Eiffel, Front de Seine', sub: 'les tours des années 1970', view: {longitude: 2.2905, latitude: 48.8550, zoom: 14.8, pitch: 66, bearing: -62}},
  {name: 'Paris Rive Gauche', sub: 'le quartier des années 2000', view: {longitude: 2.3780, latitude: 48.8318, zoom: 15.2, pitch: 60, bearing: 36}}
];
const LIMITS = {minZoom: 11, maxZoom: 20, maxPitch: 85};
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const INTRO_FROM = {longitude: 2.3415, latitude: 48.8560, zoom: 11.7, pitch: 8, bearing: -40, ...LIMITS};

const mapView = new MapView({
  id: 'map',
  fovy: FLIGHT_FOVY,
  farZMultiplier: 3,
  controller: {inertia: 500, scrollZoom: {speed: 0.012, smooth: true}, dragMode: 'rotate', dragRotate: true, touchRotate: true, keyboard: true}
});
const flyView = new FirstPersonView({id: 'fly', fovy: FLIGHT_FOVY, near: 1, far: 32000, controller: false});

// Lumière rasante de fin de journée venue du sud-ouest, contre-jour froid
const lighting = new LightingEffect({
  ambient: new AmbientLight({color: [214, 222, 255], intensity: 0.95}),
  sun: new DirectionalLight({color: [255, 228, 190], intensity: 2.4, direction: [0.62, 0.48, -0.62]}),
  fill: new DirectionalLight({color: [120, 150, 220], intensity: 0.55, direction: [-0.55, -0.35, -0.75]})
});

const ui = {
  year: 2026,
  displayYear: 2026,
  playing: false,
  highlight: -1,
  highlightTarget: -1,
  highlightMix: 0,
  glow: 0,
  lastScrub: 0,
  showTrees: true,
  showDistricts: true,
  showLabels: true,
  flying: false,
  overview: true,
  showPpri: false,
  showCaves: false,
  exposedOnly: false,
  exposedColor: 'period'
};

let data;
let res;
let deck;
let flight;
let view = {...INTRO_FROM};
let dirty = true;

main().catch(err => {
  console.error(err);
  $('loader').classList.add('error');
  $('loader-msg').textContent = `Impossible de charger la carte : ${err.message}`;
});

// Écran d'accueil : rien ne se télécharge avant le clic (sobriété), sauf lien en ?lancer
async function gate() {
  const warn = msg => {
    $('gate-warn').textContent = msg;
    $('gate-warn').hidden = false;
  };
  if (!document.createElement('canvas').getContext('webgl2')) {
    warn("Ce navigateur ne prend pas en charge WebGL 2 : la carte ne peut pas s'afficher.");
    $('gate-btn').disabled = true;
    return new Promise(() => {});
  }
  if (window.matchMedia('(max-width: 900px), (pointer: coarse)').matches) {
    warn("Sur téléphone ou tablette, l'affichage peut être lent, et le vol libre demande un clavier.");
  }
  if (!new URLSearchParams(location.search).has('lancer')) {
    $('gate-btn').focus();
    await new Promise(resolve => $('gate-btn').addEventListener('click', resolve, {once: true}));
  }
  $('gate').hidden = true;
  $('progress').hidden = false;
}

async function main() {
  await gate();
  data = await loadData(p => {
    $('bar').style.width = `${Math.round(p * 100)}%`;
  });
  $('loader-msg').textContent = 'Mise en volume de la ville';
  await new Promise(r => setTimeout(r, 30));
  await document.fonts.load('600 30px "EB Garamond"').catch(() => {});

  const {meta, geo} = data;
  ui.year = ui.displayYear = meta.yearMax;
  res = createStaticResources(data);

  const surface = buildSurfaceGrid(data);
  flight = new FlightController({
    geo,
    ground: (lng, lat) => sampleGrid(data.dem, geo, lng, lat),
    surface: (lng, lat) => sampleGrid(surface, geo, lng, lat, 1),
    district: (lng, lat) => cellValue(data.arr, geo, lng, lat)
  });

  buildLegend();
  buildTimeline();
  buildControls();
  $('lede-count').textContent = fmt.format(meta.buildings.features);
  $('tree-count').textContent = fmt.format(data.trees.count);
  $('sources').innerHTML = meta.sources.map(s => `<li><a href="${s.url}" target="_blank" rel="noopener">${s.name}</a> (${s.licence})</li>`).join('');
  $('risk-agree').textContent = `${fmt1.format(meta.risques.sameZoneShare * 100)} %`;

  deck = new Deck({
    parent: $('map'),
    views: mapView,
    viewState: view,
    effects: [lighting],
    layers: buildLayers(data, res, ui),
    useDevicePixels: Math.min(window.devicePixelRatio || 1, 2),
    pickingRadius: 2,
    onViewStateChange: ({viewState}) => {
      if (ui.flying) return;
      view = viewState;
      // vue pilotée par l'application : sans ce renvoi, la souris ne déplace rien à l'écran
      deck.setProps({viewState: view});
      hideTooltip();
      updateCompass();
      // numéros d'arrondissement : repères de vue d'ensemble seulement
      const overview = viewState.zoom < 14.2;
      if (overview !== ui.overview) {
        ui.overview = overview;
        dirty = true;
      }
      return viewState;
    },
    onHover: onHover,
    onLoad: () => {
      $('loader').classList.add('done');
      flyTo(PRESETS[0].view, 4200);
    }
  });
  updateCensus();
  if (import.meta.env.DEV) window.__paris = {deck, flight, ui, enterFlight, exitFlight, get view() { return view; }};
  requestAnimationFrame(loop);
  bindKeys();
}

// ------------------------------------------------------------------ boucle d'animation
let last = performance.now();
function loop(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  if (ui.playing) {
    // 12 ans par seconde, ralenti dans les décennies récentes où les dates sont précises
    const rate = ui.year < 1914 ? 14 : 9;
    ui.year = Math.min(ui.year + rate * dt, data.meta.yearMax);
    if (ui.year >= data.meta.yearMax) setPlaying(false);
    setYearDisplay(Math.floor(ui.year));
    dirty = true;
  }
  const glowTarget = ui.playing || now - ui.lastScrub < 1600 ? 1 : 0;
  if (Math.abs(ui.glow - glowTarget) > 0.002) {
    ui.glow += (glowTarget - ui.glow) * (1 - Math.exp(-dt * (glowTarget ? 6 : 1.4)));
    dirty = true;
  }
  const hTarget = ui.highlightTarget >= 0 ? 1 : 0;
  if (ui.highlightTarget >= 0) ui.highlight = ui.highlightTarget;
  if (Math.abs(ui.highlightMix - hTarget) > 0.002) {
    ui.highlightMix += (hTarget - ui.highlightMix) * (1 - Math.exp(-dt * 7));
    dirty = true;
  } else if (hTarget === 0 && ui.highlight !== -1) {
    ui.highlight = -1;
    ui.highlightMix = 0;
    dirty = true;
  }

  if (ui.flying) {
    const {width, height} = deck;
    const vs = flight.update(dt, width, height);
    deck.setProps({viewState: vs});
    updateFlightUI(width, height);
    updateHorizon(flight.pitch);
  }
  if (dirty) {
    deck.setProps({layers: buildLayers(data, res, ui)});
    dirty = false;
  }
  requestAnimationFrame(loop);
}

function flyTo(target, duration = 2600) {
  if (REDUCED_MOTION) duration = 0;
  view = {
    ...view,
    ...target,
    ...LIMITS,
    transitionDuration: duration,
    transitionInterpolator: new FlyToInterpolator({curve: 1.4}),
    transitionEasing: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
  };
  deck.setProps({viewState: view});
}

function updateCompass() {
  $('needle').setAttribute('transform', `rotate(${-view.bearing} 32 32)`);
  updateHorizon(view.pitch - 90);
}

// Hauteur de l'horizon à l'écran, pour placer le halo du ciel
function updateHorizon(pitch) {
  const h = window.innerHeight;
  const f = h / 2 / Math.tan((FLIGHT_FOVY / 2) * Math.PI / 180);
  const y = h / 2 + Math.tan((pitch * Math.PI) / 180) * f;
  document.documentElement.style.setProperty('--horizon', `${Math.max(-20, Math.min(120, (y / h) * 100))}%`);
}

// ------------------------------------------------------------------ légende
function buildLegend() {
  const {periods} = data.meta;
  $('periods').innerHTML = periods
    .map((p, i) => {
      const c = `rgb(${PALETTE[i].join(',')})`;
      return `<li class="period" data-i="${i}" tabindex="0" role="button" aria-pressed="false">
        <span class="sw" style="background:${c}"></span>
        <span class="lab">${p.label}</span>
        <span class="bar"><i style="background:${c}"></i></span>
        <span class="pct"></span>
        <span class="period-detail"></span>
      </li>`;
    })
    .join('');
  for (const li of $('periods').children) {
    const toggle = () => setHighlight(Number(li.dataset.i));
    li.addEventListener('click', toggle);
    li.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
  }
  updateLegend();
}

function updateLegend() {
  const {periods} = data.meta;
  const exposed = ui.exposedOnly && data.risques && exposureMask(ui) ? exposedSet() : null;
  const shares = periods.map((p, i) => (exposed ? exposed.byPeriod[i] / exposed.count : p.share));
  const max = Math.max(...shares);
  $('legend-title').textContent = exposed ? 'Bâtiments exposés' : 'Périodes de construction';
  $('legend-hint').textContent = exposed
    ? `${fmt.format(exposed.count)} bâtiments, soit ${fmt1.format((exposed.count / data.risques.stats.total) * 100)} % du parc. Part de chaque période parmi eux.`
    : "Part du parc bâti, en nombre de bâtiments. Cliquer une période pour l'isoler.";
  [...$('periods').children].forEach((li, i) => {
    const p = periods[i];
    li.querySelector('.bar i').style.width = `${(shares[i] / max) * 100}%`;
    li.querySelector('.pct').textContent = `${fmt1.format(shares[i] * 100)} %`;
    li.querySelector('.period-detail').textContent = exposed
      ? `${fmt.format(exposed.byPeriod[i])} bâtiments exposés, soit ${fmt1.format((exposed.byPeriod[i] / p.count) * 100)} % de cette période`
      : `${fmt.format(p.count)} bâtiments ; ${fmt1.format(p.areaShare * 100)} % de l'emprise au sol`;
  });
}

function setHighlight(i) {
  ui.highlightTarget = ui.highlightTarget === i ? -1 : i;
  const legend = $('legend');
  legend.classList.toggle('has-active', ui.highlightTarget >= 0);
  for (const li of $('periods').children) {
    const on = Number(li.dataset.i) === ui.highlightTarget;
    li.classList.toggle('active', on);
    li.setAttribute('aria-pressed', String(on));
  }
  dirty = true;
}

// ------------------------------------------------------------------ risque d'inondation
let risquesLoading = null;
async function setRisk(key, on) {
  ui[key] = on;
  if (on && !data.risques) {
    $('risk-msg').textContent = 'Chargement des couches de risque…';
    risquesLoading ??= loadRisques();
    try {
      data.risques = await risquesLoading;
    } catch (err) {
      console.error(err);
      risquesLoading = null;
      $('risk-msg').textContent = `Couches de risque indisponibles : ${err.message}`;
      return;
    }
    buildZones();
  }
  const any = ui.showPpri || ui.showCaves;
  $('t-exposed').disabled = !any;
  $('exposed-color').hidden = !(any && ui.exposedOnly);
  $('zones').hidden = !ui.showPpri;
  if (data.risques) {
    const s = data.risques.stats;
    $('risk-msg').textContent = any
      ? `${fmt.format(exposedSet().count)} bâtiments sur ${fmt.format(s.total)}. Pour information : seul le PPRI approuvé fait foi.`
      : 'Pour information : seul le PPRI approuvé fait foi.';
  }
  updateLegend();
  dirty = true;
}

// Ensemble des bâtiments exposés selon les couches affichées
function exposedSet() {
  const {sets} = data.risques.stats;
  return ui.showPpri && ui.showCaves ? sets.both : ui.showPpri ? sets.ppri : sets.caves;
}

function buildZones() {
  $('zones').innerHTML = data.risques.stats.zones
    .map(z => `<li><i class="${z.hatch ? 'hatch' : ''}" style="background-color:rgb(${z.color.join(',')})"></i>${z.label}<span class="n">${fmt.format(z.buildings)}</span></li>`)
    .join('');
}

// ------------------------------------------------------------------ frise chronologique
function buildTimeline() {
  const {yearMin, yearMax, periods} = data.meta;
  const span = yearMax - yearMin;
  const slider = $('slider');
  slider.min = yearMin;
  slider.max = yearMax;
  slider.value = yearMax;
  // bande colorée : chaque période occupe ses années
  const segs = [];
  periods.slice(1, -1).forEach((p, k) => {
    const s = Math.max(p.start, yearMin);
    const e = Math.min(p.end ?? yearMax, yearMax);
    segs.push(`<i style="flex:${e - s + 1};background:rgb(${PALETTE[k + 1].join(',')})"></i>`);
  });
  $('track').innerHTML = segs.join('');
  $('ticks').innerHTML = [1800, 1850, 1900, 1950, 2000]
    .map(y => `<span style="left:${((y - yearMin) / span) * 100}%">${y}</span>`)
    .join('') + `<span style="left:100%">${yearMax}</span>`;

  slider.addEventListener('input', () => {
    setPlaying(false);
    ui.year = Number(slider.value);
    ui.lastScrub = performance.now();
    setYearDisplay(ui.year);
    dirty = true;
  });
  $('play').addEventListener('click', () => {
    if (!ui.playing && ui.year >= yearMax) {
      ui.year = yearMin;
      setYearDisplay(yearMin);
    }
    setPlaying(!ui.playing);
  });
}

function setPlaying(on) {
  ui.playing = on;
  $('play').classList.toggle('playing', on);
  $('play').setAttribute('aria-label', on ? 'Mettre en pause' : 'Lancer le voyage dans le temps');
  if (!on) ui.lastScrub = performance.now();
}

function setYearDisplay(y) {
  if (y === ui.displayYear) return;
  ui.displayYear = y;
  $('year').textContent = y;
  if (!ui.playing || y % 2 === 0) $('slider').value = y;
  updateCensus();
}

function updateCensus() {
  const b = data.buildings;
  const y = ui.displayYear;
  let sure = 0;
  let maybe = 0;
  for (let p = 0; p < b.count; p++) {
    if (!b.first[p]) continue;
    if (b.yearStart[p] === b.yearEnd[p] ? b.yearStart[p] <= y : b.yearEnd[p] <= y) sure++;
    else if (b.yearStart[p] <= y) maybe++;
  }
  // les emprises Apur de la tour Eiffel, remplacées par la maquette, restent comptées
  if (b.eiffelPieces === undefined) {
    let n = 0;
    for (let p = 0; p < b.count; p++) n += b.first[p];
    b.eiffelPieces = data.meta.buildings.features - n;
  }
  if (y >= data.meta.eiffel.year) sure += b.eiffelPieces;
  $('census').innerHTML = y >= data.meta.yearMax
    ? `<b>${fmt.format(sure)}</b> bâtiments aujourd'hui, dont <b>${fmt.format(data.meta.periods.at(-1).count)}</b> non datés`
    : `En ${y} : <b>${fmt.format(sure)}</b> bâtiments attestés, <b>${fmt.format(maybe)}</b> possibles`;
}

// ------------------------------------------------------------------ commandes
function buildControls() {
  $('presets').innerHTML = PRESETS.map((p, i) => `<button data-i="${i}">${p.name}<small>${p.sub}</small></button>`).join('');
  for (const b of $('presets').children) b.addEventListener('click', () => flyTo(PRESETS[Number(b.dataset.i)].view));
  const bindToggle = (id, key) =>
    $(id).addEventListener('change', e => {
      ui[key] = e.target.checked;
      dirty = true;
    });
  bindToggle('t-trees', 'showTrees');
  bindToggle('t-districts', 'showDistricts');
  bindToggle('t-labels', 'showLabels');
  for (const [id, key] of [['t-ppri', 'showPpri'], ['t-caves', 'showCaves'], ['t-exposed', 'exposedOnly']]) {
    $(id).addEventListener('change', e => setRisk(key, e.target.checked));
  }
  for (const btn of $('exposed-color').children) {
    btn.addEventListener('click', () => {
      ui.exposedColor = btn.dataset.v;
      for (const b of $('exposed-color').children) b.setAttribute('aria-checked', String(b === btn));
      dirty = true;
    });
  }
  $('fly').addEventListener('click', enterFlight);
  $('f-exit').addEventListener('click', exitFlight);
  $('compass').addEventListener('click', () => flyTo({bearing: 0}, 900));
  $('about-btn').addEventListener('click', () => $('about').showModal());

  const gauge = [];
  for (let l = -6; l <= 9; l++) gauge.push(`<i data-l="${l}" class="${l === 0 ? 'zero' : ''}"></i>`);
  $('f-gauge').innerHTML = gauge.join('');
}

function bindKeys() {
  window.addEventListener('keydown', e => {
    if (e.target.closest && e.target.closest('input, dialog')) {
      if (e.target.id !== 'slider' && e.target.type !== 'checkbox') return;
    }
    if (ui.flying) {
      if (e.key === 'Escape' || e.key === 'f' || e.key === 'F') {
        exitFlight();
        e.preventDefault();
        return;
      }
      if (flight.onKeyDown(e)) e.preventDefault();
      return;
    }
    if (e.target.id === 'slider') return;
    if (e.key === 'f' || e.key === 'F') enterFlight();
    else if (e.key === 'p' || e.key === 'P') $('play').click();
  });
  window.addEventListener('keyup', e => ui.flying && flight.onKeyUp(e));
  window.addEventListener('blur', () => flight && (flight.keys.clear(), (flight.lockedAlt = null)));

  // souris du vol libre : clic = cran de vitesse, glisser = regarder autour
  const el = $('map');
  el.addEventListener('pointermove', e => {
    if (!ui.flying) return;
    flight.pointer = {x: e.clientX, y: e.clientY, inside: true};
    if (flight.drag) {
      const dx = e.clientX - flight.drag.x;
      const dy = e.clientY - flight.drag.y;
      if (Math.hypot(dx, dy) > 4) flight.drag.moved = true;
      if (flight.drag.moved) {
        flight.yaw += (e.clientX - flight.drag.lx) * 0.18;
        flight.pitch = Math.max(-89, Math.min(89, flight.pitch - (e.clientY - flight.drag.ly) * 0.18));
      }
      flight.drag.lx = e.clientX;
      flight.drag.ly = e.clientY;
    }
  });
  el.addEventListener('pointerleave', () => ui.flying && (flight.pointer.inside = false));
  el.addEventListener('pointerdown', e => {
    if (!ui.flying) return;
    flight.drag = {x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, moved: false, button: e.button};
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointerup', e => {
    if (!ui.flying || !flight.drag) return;
    const {moved, button} = flight.drag;
    flight.drag = null;
    if (moved) return;
    if (button === 0) flight.changeLevel(1);
    else if (button === 2) flight.changeLevel(-1);
    else if (button === 1) flight.stop();
  });
  // clic droit : marche arrière en vol, déplacement de la carte sinon ; jamais le menu du navigateur
  el.addEventListener('contextmenu', e => e.preventDefault());
  let wheelAcc = 0;
  el.addEventListener('wheel', e => {
    if (!ui.flying) return;
    e.preventDefault();
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) > 120) {
      flight.changeLevel(wheelAcc < 0 ? 1 : -1);
      wheelAcc = 0;
    }
  }, {passive: false});
}

// ------------------------------------------------------------------ vol libre : entrée et sortie
function enterFlight() {
  if (ui.flying) return;
  const vp = deck.getViewports()[0];
  const [lng, lat, z] = vp.unprojectPosition(vp.cameraPosition);
  // vue lointaine : on rejoint d'abord une pose d'approche basse, en arrière du centre visé
  const g = sampleGrid(data.dem, data.geo, view.longitude, view.latitude) ?? 35;
  let approach = null;
  if (z - g > 700) {
    const back = 650;
    const b = (view.bearing * Math.PI) / 180;
    approach = {
      lng: view.longitude - (Math.sin(b) * back) / data.geo.mx,
      lat: view.latitude - (Math.cos(b) * back) / data.geo.my,
      alt: g + 240,
      yaw: view.bearing,
      pitch: -17
    };
  }
  flight.enter({lng, lat, alt: z, bearing: view.bearing, pitch: view.pitch - 90}, approach);
  ui.flying = true;
  dirty = true;
  document.body.classList.add('flying');
  hideTooltip();
  deck.setProps({views: flyView, viewState: flight.viewState()});
}

function exitFlight() {
  if (!ui.flying) return;
  const {f} = flight.basis();
  const ground = (lng, lat) => sampleGrid(data.dem, data.geo, lng, lat) ?? 35;
  // point visé : intersection du regard avec le sol, ou point devant soi
  let t = 0;
  let hit = null;
  const step = Math.max(5, flight.alt / 60);
  while (t < 12000) {
    t += step;
    const lng = flight.lng + (f[0] * t) / data.geo.mx;
    const lat = flight.lat + (f[1] * t) / data.geo.my;
    const z = flight.alt + f[2] * t;
    if (z <= ground(lng, lat)) {
      hit = {lng, lat, z: ground(lng, lat), t};
      break;
    }
  }
  if (!hit || hit.t > 6000) {
    const h = Math.hypot(f[0], f[1]) || 1;
    const d = 600;
    const lng = flight.lng + (f[0] / h) * d / data.geo.mx;
    const lat = flight.lat + (f[1] / h) * d / data.geo.my;
    hit = {lng, lat, z: ground(lng, lat), t: Math.hypot(d, flight.alt - ground(lng, lat))};
  }
  const pitch = Math.max(0, Math.min(85, flight.pitch + 90));
  const altitude = 0.5 / Math.tan((FLIGHT_FOVY / 2) * Math.PI / 180);
  const C = 40075016.686 * Math.cos((hit.lat * Math.PI) / 180);
  const zoom = Math.log2((altitude * deck.height * C) / (512 * Math.max(hit.t, 30)));
  ui.flying = false;
  dirty = true;
  flight.exit();
  document.body.classList.remove('flying');
  view = {longitude: hit.lng, latitude: hit.lat, zoom: Math.max(11, Math.min(20, zoom)), pitch, bearing: flight.yaw, ...LIMITS};
  deck.setProps({views: mapView, viewState: view});
  updateCompass();
}

const CARDINALS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
let lastBar = 0;
function updateFlightUI(width, height) {
  // réticule : centre et direction indiquée par le pointeur
  const cx = width / 2;
  const cy = height / 2;
  const p = flight.pointer;
  const line = $('steer-line');
  const dot = $('steer-dot');
  const show = p.inside && Math.hypot(p.x - cx, p.y - cy) > 0.05 * Math.min(cx, cy);
  line.setAttribute('x1', cx);
  line.setAttribute('y1', cy);
  line.setAttribute('x2', show ? p.x : cx);
  line.setAttribute('y2', show ? p.y : cy);
  dot.setAttribute('cx', show ? p.x : cx);
  dot.setAttribute('cy', show ? p.y : cy);
  document.querySelector('.reticle .center').setAttribute('cx', cx);
  document.querySelector('.reticle .center').setAttribute('cy', cy);
  document.querySelector('.reticle .center-cross').setAttribute('d', `M${cx - 22} ${cy}h9M${cx + 13} ${cy}h9M${cx} ${cy - 22}v9M${cx} ${cy + 13}v9`);

  const now = performance.now();
  if (now - lastBar < 80) return;
  lastBar = now;
  const s = flight.status();
  const modes = {
    free: 'Vol libre',
    constant: `Altitude constante ${fmt.format(Math.round(s.lockedAlt))} m`,
    follow: `Suivi du relief +${fmt.format(Math.round(s.clearance))} m`
  };
  $('f-mode').textContent = modes[s.mode];
  const kmh = Math.abs(s.speed) * 3.6;
  const sp = $('f-speed');
  const sign = s.speed < -0.05 ? '−' : '';
  sp.textContent = `${sign}${fmt1.format(Math.abs(s.speed))} m/s · ${fmt.format(Math.round(kmh))} km/h`;
  sp.classList.toggle('back', s.speed < -0.05);
  for (const i of $('f-gauge').children) {
    const l = Number(i.dataset.l);
    i.classList.toggle('on', l !== 0 && (s.level > 0 ? l > 0 && l <= s.level : l < 0 && l >= s.level));
    i.classList.toggle('rev', l < 0);
  }
  const moving = Math.abs(s.speed) > 0.3;
  const card = CARDINALS[Math.round(s.heading / 22.5) % 16];
  $('f-dir').textContent = moving
    ? `${String(Math.round(s.heading)).padStart(3, '0')}° ${card}${s.speed < 0 ? ' (marche arrière)' : ''}`
    : `regard ${String(Math.round(s.yaw)).padStart(3, '0')}° ${CARDINALS[Math.round(s.yaw / 22.5) % 16]}`;
  $('f-climb').textContent = `${s.climb > 0.5 ? '▲' : s.climb < -0.5 ? '▼' : ''} ${fmt1.format(Math.abs(s.climb))}°`;
  $('f-alt').textContent = `${fmt.format(Math.round(s.alt))} m${s.agl === null ? '' : ` · sol +${fmt.format(Math.round(s.agl))}`}`;
  $('f-district').textContent = s.district ? `${ROMAN[s.district]}e arr.`.replace(/^Ie/, 'Ier') : 'hors périmètre';
  const al = $('f-alert');
  al.className = `cell alert ${s.warning ? s.warning.level : ''}`;
  al.textContent = s.warning ? `⚠ ${s.warning.text}` : 'Aucun obstacle';
}

// ------------------------------------------------------------------ infobulle
function onHover(info) {
  if (ui.flying || !info.layer || info.index < 0) return hideTooltip();
  const tt = $('tooltip');
  let html = '';
  if (info.layer.id === 'buildings') {
    const b = data.buildings;
    const i = info.index;
    const pi = b.period[i];
    const per = data.meta.periods[pi];
    const exact = b.year[i];
    const y = ui.displayYear;
    const possible = !(b.yearStart[i] === b.yearEnd[i] ? b.yearStart[i] <= y : b.yearEnd[i] <= y);
    html = `<div class="tt-head"><i style="background:rgb(${PALETTE[pi].join(',')})"></i>${per.label}</div>
      <dl>
        <dt>Construction</dt><dd>${exact ? (exact < 1800 ? `${exact} (antérieur à 1800)` : exact) : 'année non renseignée'}</dd>
        <dt>Hauteur</dt><dd>${fmt1.format(b.height[i] / 10)} m</dd>
        <dt>Altitude du sol</dt><dd>${fmt1.format(b.ground[i] / 10)} m</dd>
        <dt>Arrondissement</dt><dd>${b.arrondissement[i] ? ordinal(b.arrondissement[i]) : '-'}</dd>
        ${riskRows(i)}
      </dl>
      ${possible && y < data.meta.yearMax ? `<p class="tt-note">En ${y}, sa présence est possible mais pas attestée.</p>` : ''}`;
  } else if (info.layer.id === 'eiffel') {
    html = `<div class="tt-head"><i style="background:rgb(${PALETTE[2].join(',')})"></i>Tour Eiffel</div>
      <dl><dt>Construction</dt><dd>1889</dd><dt>Hauteur</dt><dd>maquette simplifiée, 330 m</dd><dt>Arrondissement</dt><dd>7e</dd></dl>`;
  } else if (info.layer.id === 'crowns' || info.layer.id === 'conifers') {
    const i = info.object;
    const t = data.trees;
    html = `<div class="tt-head"><i style="background:rgb(${TREE_CLASSES[Math.min(t.genus[i], 10)][1].join(',')})"></i>${TREE_CLASSES[Math.min(t.genus[i], 10)][0]}</div>
      <dl><dt>Hauteur</dt><dd>${fmt.format(Math.round(t.height[i]))} m</dd><dt>Houppier estimé</dt><dd>${fmt.format(Math.round(t.radius[i] * 2))} m</dd></dl>`;
  } else return hideTooltip();
  tt.innerHTML = html;
  const x = Math.min(info.x + 16, window.innerWidth - 300);
  const yPos = Math.min(info.y + 16, window.innerHeight - 160);
  tt.style.left = `${x}px`;
  tt.style.top = `${yPos}px`;
  tt.classList.add('show');
}

function riskRows(i) {
  if (!data.risques || !(ui.showPpri || ui.showCaves)) return '';
  const f = data.risques.flags[i];
  const zone = f & 7;
  return `<dt>PPRI</dt><dd>${zone ? data.risques.stats.zones[zone - 1].label : 'hors zone'}</dd>
    <dt>Caves, crue 1910</dt><dd>${f & 8 ? 'secteur inondé' : 'hors secteur'}</dd>`;
}

function hideTooltip() {
  $('tooltip').classList.remove('show');
}

