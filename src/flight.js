// Vol libre immersif.
//
// Le pointeur indique la direction : la cible de la caméra avance (ou recule) le long
// du rayon qui passe sous le pointeur, et le regard la rattrape en douceur.
// Clic gauche : un cran de vitesse en avant ; clic droit : un cran en arrière
// (la vitesse devient négative après l'arrêt). Flèches haut / bas : idem au clavier.
// MAJ maintenue : altitude constante (cote absolue figée), quelle que soit l'orientation.
// T : suivi du relief (hauteur au-dessus du sol maintenue). Deux comportements distincts :
// l'altitude constante n'évite rien, le suivi du relief épouse le terrain mais pas les toits.
// Aucun des deux n'empêche une collision avec un bâtiment : l'alerte la signale.

const SPEEDS = [0, 4, 8, 15, 28, 50, 90, 160, 280, 480]; // m/s par cran
const MAX_LEVEL = SPEEDS.length - 1;
const MIN_LEVEL = -6;
const DEG = Math.PI / 180;

export const FLIGHT_FOVY = 55;

export function levelSpeed(level) {
  return Math.sign(level) * SPEEDS[Math.min(Math.abs(level), MAX_LEVEL)];
}

function wrapAngle(a) {
  return ((((a + 180) % 360) + 360) % 360) - 180;
}

export class FlightController {
  constructor({geo, ground, surface, district}) {
    this.geo = geo;
    this.ground = ground;     // (lng, lat) => altitude du sol (m) ou null hors périmètre
    this.surface = surface;   // (lng, lat) => altitude des toits (m)
    this.district = district; // (lng, lat) => numéro d'arrondissement
    this.active = false;
    this.pointer = {x: 0, y: 0, inside: false};
    this.keys = new Set();
    this.drag = null;
  }

  // approach : pose d'arrivée facultative, rejointe en douceur depuis la caméra de la carte
  enter(camera, approach = null) {
    Object.assign(this, {
      lng: camera.lng, lat: camera.lat, alt: camera.alt,
      yaw: camera.bearing, pitch: camera.pitch,
      level: 0, speed: 0, follow: false, clearance: 60,
      lockedAlt: null, motion: [0, 0, 0], active: true, warning: null,
      tween: approach ? {from: {...camera, yaw: camera.bearing}, to: approach, t: 0, duration: 2.2} : null
    });
  }

  stepTween(dt) {
    const tw = this.tween;
    tw.t = Math.min(1, tw.t + dt / tw.duration);
    const e = tw.t < 0.5 ? 4 * tw.t ** 3 : 1 - (-2 * tw.t + 2) ** 3 / 2;
    const {from, to} = tw;
    this.lng = from.lng + (to.lng - from.lng) * e;
    this.lat = from.lat + (to.lat - from.lat) * e;
    // descente en arc : l'altitude rejoint la cible un peu plus tôt que la position
    this.alt = from.alt + (to.alt - from.alt) * Math.min(1, e * 1.15);
    this.yaw = from.yaw + wrapAngle(to.yaw - from.yaw) * e;
    this.pitch = from.pitch + (to.pitch - from.pitch) * e;
    if (tw.t >= 1) this.tween = null;
  }

  exit() {
    this.active = false;
    this.keys.clear();
  }

  // Interactions -------------------------------------------------------------
  changeLevel(delta) {
    this.level = Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, this.level + delta));
  }

  stop() {
    this.level = 0;
  }

  toggleFollow() {
    this.follow = !this.follow;
    if (this.follow) {
      const g = this.ground(this.lng, this.lat) ?? 35;
      this.clearance = Math.min(Math.max(8, this.alt - g), 400);
    }
  }

  onKeyDown(e) {
    const k = e.key;
    if (k === 'ArrowUp') this.changeLevel(1);
    else if (k === 'ArrowDown') this.changeLevel(-1);
    else if (k === ' ') this.stop();
    else if (k === 't' || k === 'T') this.toggleFollow();
    else if (k === 'Shift' && this.lockedAlt === null) this.lockedAlt = this.alt;
    else if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'PageUp' || k === 'PageDown') {
      this.keys.add(k);
    } else return false;
    return true;
  }

  onKeyUp(e) {
    if (e.key === 'Shift') this.lockedAlt = null;
    this.keys.delete(e.key);
  }

  // Direction du rayon passant par le pointeur, dans le repère est / nord / haut
  basis() {
    const cy = Math.cos(this.yaw * DEG);
    const sy = Math.sin(this.yaw * DEG);
    const cp = Math.cos(this.pitch * DEG);
    const sp = Math.sin(this.pitch * DEG);
    const f = [sy * cp, cy * cp, sp];
    const r = [cy, -sy, 0];
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    return {f, r, u};
  }

  pointerRay(width, height) {
    const {f, r, u} = this.basis();
    if (!this.pointer.inside || this.drag) return f;
    let nx = (this.pointer.x / width) * 2 - 1;
    let ny = 1 - (this.pointer.y / height) * 2;
    const dead = 0.05;
    const m = Math.hypot(nx, ny);
    if (m < dead) return f;
    const k = (m - dead) / (1 - dead) / m;
    nx *= k;
    ny *= k;
    const th = Math.tan((FLIGHT_FOVY / 2) * DEG);
    const tw = th * (width / height);
    const d = [0, 1, 2].map(i => f[i] + r[i] * nx * tw + u[i] * ny * th);
    const l = Math.hypot(...d);
    return d.map(x => x / l);
  }

  // Pas de simulation -------------------------------------------------------
  update(dt, width, height) {
    dt = Math.min(dt, 0.1);
    if (this.tween) {
      this.stepTween(dt);
      this.motion = [0, 0, 0];
      this.warning = null;
      return this.viewState();
    }
    const target = levelSpeed(this.level);
    // accélération progressive : rattrapage exponentiel, plus doux pour les grands écarts
    this.speed += (target - this.speed) * (1 - Math.exp(-dt * 1.6));
    if (Math.abs(this.speed) < 0.02 && target === 0) this.speed = 0;

    // rotation clavier (flèches gauche / droite) et glisser-déposer pour regarder
    if (this.keys.has('ArrowLeft')) this.yaw -= 50 * dt;
    if (this.keys.has('ArrowRight')) this.yaw += 50 * dt;

    const dir = this.pointerRay(width, height);
    const moving = Math.abs(this.speed) > 0.3;
    if (moving) {
      // le regard suit la direction indiquée
      const tYaw = Math.atan2(dir[0], dir[1]) / DEG;
      const tPitch = Math.asin(Math.max(-1, Math.min(1, dir[2]))) / DEG;
      const k = 1 - Math.exp(-dt * 1.4);
      this.yaw += wrapAngle(tYaw - this.yaw) * k;
      this.pitch += (tPitch - this.pitch) * k;
    }
    this.yaw = wrapAngle(this.yaw);
    this.pitch = Math.max(-89, Math.min(89, this.pitch));

    const constant = this.lockedAlt !== null;
    let v = dir.map(x => x * this.speed);
    if (constant || this.follow) {
      // déplacement horizontal : la composante verticale est retirée, la vitesse conservée
      let h = Math.hypot(dir[0], dir[1]);
      let hx = dir[0];
      let hy = dir[1];
      if (h < 1e-3) {
        hx = Math.sin(this.yaw * DEG);
        hy = Math.cos(this.yaw * DEG);
        h = 1;
      }
      v = [(hx / h) * this.speed, (hy / h) * this.speed, 0];
    }
    this.lng += (v[0] * dt) / this.geo.mx;
    this.lat += (v[1] * dt) / this.geo.my;

    const g = this.ground(this.lng, this.lat);
    if (constant) {
      this.alt += (this.lockedAlt - this.alt) * (1 - Math.exp(-dt * 6));
    } else if (this.follow) {
      // la composante verticale du pointeur règle la hauteur au-dessus du sol
      this.clearance = Math.max(3, this.clearance + dir[2] * this.speed * dt);
      if (this.keys.has('PageUp')) this.clearance += 30 * dt;
      if (this.keys.has('PageDown')) this.clearance = Math.max(3, this.clearance - 30 * dt);
      const ahead = this.ground(this.lng + (v[0] * 1.2) / this.geo.mx, this.lat + (v[1] * 1.2) / this.geo.my);
      const ref = Math.max(g ?? 35, ahead ?? g ?? 35);
      this.alt += (ref + this.clearance - this.alt) * (1 - Math.exp(-dt * 2.5));
    } else {
      this.alt += v[2] * dt;
      if (this.keys.has('PageUp')) this.alt += 30 * dt;
      if (this.keys.has('PageDown')) this.alt -= 30 * dt;
    }
    this.alt = Math.min(this.alt, 6000);
    this.motion = v;
    this.warning = this.checkObstacles(v, g);
    return this.viewState();
  }

  checkObstacles(v, g) {
    if (g !== null && this.alt < g + 0.5) return {level: 'danger', text: 'Sous le sol'};
    const s = this.surface(this.lng, this.lat);
    if (s !== null && this.alt < s && s - (g ?? 0) > 2) return {level: 'danger', text: 'Dans un bâtiment'};
    const sp = Math.hypot(v[0], v[1], v[2]);
    if (sp < 0.5) return null;
    const horizon = Math.max(60, sp * 4);
    for (let d = 10; d <= horizon; d += 10) {
      const t = d / sp;
      const lng = this.lng + (v[0] * t) / this.geo.mx;
      const lat = this.lat + (v[1] * t) / this.geo.my;
      const z = this.alt + v[2] * t;
      const top = this.surface(lng, lat);
      if (top !== null && z < top + 2) {
        const gnd = this.ground(lng, lat);
        const what = gnd !== null && top - gnd > 2 ? 'Bâtiment' : 'Relief';
        return {level: d < sp * 1.5 ? 'danger' : 'warn', text: `${what} à ${Math.round(d)} m`};
      }
    }
    return null;
  }

  viewState() {
    return {
      longitude: this.lng,
      latitude: this.lat,
      position: [0, 0, this.alt],
      bearing: this.yaw,
      // FirstPersonView : tangage positif vers le bas, l'inverse de ce contrôleur
      pitch: -this.pitch
    };
  }

  status() {
    const g = this.ground(this.lng, this.lat);
    const h = Math.hypot(this.motion[0], this.motion[1]);
    const heading = h > 0.3 ? Math.atan2(this.motion[0], this.motion[1]) / DEG : this.yaw;
    const climb = Math.abs(this.speed) > 0.3 ? Math.atan2(this.motion[2], h) / DEG : 0;
    return {
      mode: this.lockedAlt !== null ? 'constant' : this.follow ? 'follow' : 'free',
      level: this.level,
      speed: this.speed,
      heading: (heading + 360) % 360,
      yaw: (this.yaw + 360) % 360,
      climb,
      alt: this.alt,
      agl: g === null ? null : this.alt - g,
      lockedAlt: this.lockedAlt,
      clearance: this.clearance,
      district: this.district(this.lng, this.lat),
      warning: this.warning
    };
  }
}
