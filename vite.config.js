import {defineConfig} from 'vite';
import {copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {extname, join} from 'node:path';
import {gzipSync} from 'node:zlib';

const DONNEES = 'public/data';
const COMPRESSIBLES = new Set(['.bin', '.json']);
// meta.json reste en clair : il est lu avant tout le reste et pèse 5 ko
const EN_CLAIR = new Set(['meta.json']);
const aCompresser = f => COMPRESSIBLES.has(extname(f)) && !EN_CLAIR.has(f);
const gz = buf => gzipSync(buf, {level: 9});
const ko = octets => `${Math.round(octets / 1e3).toLocaleString('fr-FR')} ko`;
const mo = octets => `${(octets / 1e6).toLocaleString('fr-FR', {maximumFractionDigits: 1})} Mo`;

// Poids transféré par fichier de données : compressé au build, brut en développement
function mesurer(build) {
  const tailles = {};
  for (const f of readdirSync(DONNEES)) {
    const chemin = join(DONNEES, f);
    tailles[f] = build && aCompresser(f) ? gz(readFileSync(chemin)).length : statSync(chemin).size;
  }
  return tailles;
}

// Tout ce que le navigateur télécharge, en comptant comme compressés par le serveur
// les fichiers texte de l'application (HTML, JS, CSS), ce que fait tout hébergement courant.
// Les couches de risque (fichiers risque*), chargées à la demande, sont comptées à part.
const aLaDemande = nom => nom.startsWith('risque');
function poidsTotal(dir) {
  const total = {demarrage: 0, risques: 0};
  for (const e of readdirSync(dir, {withFileTypes: true, recursive: true})) {
    // .woff : police de secours que les navigateurs actuels ne chargent pas (ils prennent le .woff2)
    if (!e.isFile() || e.name.startsWith('.') || /\.(txt|woff)$/.test(e.name)) continue;
    const chemin = join(e.parentPath ?? e.path, e.name);
    total[aLaDemande(e.name) ? 'risques' : 'demarrage'] += ['.html', '.js', '.css'].includes(extname(e.name))
      ? gz(readFileSync(chemin)).length
      : statSync(chemin).size;
  }
  return total;
}

function donneesCompressees() {
  let build = false;
  let outDir = 'dist';
  return {
    name: 'donnees-compressees',
    config(_, {command}) {
      build = command === 'build';
      return {define: {__TAILLES_DONNEES__: JSON.stringify(mesurer(build))}};
    },
    configResolved(cfg) {
      outDir = cfg.build.outDir;
    },
    transformIndexHtml(html) {
      // au build, le poids exact est posé dans closeBundle, une fois tous les fichiers écrits
      if (build) return html;
      const tailles = Object.entries(mesurer(false));
      const somme = filtre => tailles.filter(([f]) => filtre(f)).reduce((a, [, n]) => a + n, 0);
      return html
        .replace('%POIDS%', `${mo(somme(f => !aLaDemande(f)))} (développement, non compressé)`)
        .replace('%POIDS_RISQUES%', ko(somme(aLaDemande)));
    },
    closeBundle() {
      const dossier = join(outDir, 'data');
      for (const f of readdirSync(dossier).filter(aCompresser)) {
        const chemin = join(dossier, f);
        writeFileSync(`${chemin}.gz`, gz(readFileSync(chemin)));
        rmSync(chemin);
      }
      copyFileSync('LICENCE-DONNEES.txt', join(dossier, 'LICENCE-DONNEES.txt'));
      // licence OFL des polices embarquées
      mkdirSync(join(outDir, 'licences'), {recursive: true});
      for (const p of ['eb-garamond', 'ibm-plex-mono', 'instrument-sans']) {
        copyFileSync(`node_modules/@fontsource/${p}/LICENSE`, join(outDir, 'licences', `OFL-${p}.txt`));
      }
      const index = join(outDir, 'index.html');
      const poids = poidsTotal(outDir);
      writeFileSync(index, readFileSync(index, 'utf-8')
        .replace('%POIDS%', mo(poids.demarrage))
        .replace('%POIDS_RISQUES%', ko(poids.risques)));
    }
  };
}

export default defineConfig({
  base: './',
  plugins: [donneesCompressees()],
  // le disque NTFS monté sous WSL ne remonte pas les événements de fichiers
  server: {port: 5173, watch: {usePolling: true, interval: 300}},
  preview: {port: 4173},
  build: {target: 'es2022', chunkSizeWarningLimit: 2000}
});
