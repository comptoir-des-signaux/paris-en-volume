# Paris en volume

Carte interactive en trois dimensions du bâti parisien : les 127 438 emprises bâties
intra-muros (hors bois de Boulogne et de Vincennes), à leur hauteur mesurée, posées sur le
relief, colorées selon leur période de construction. Voyage dans le temps de 1800 à nos
jours, Seine, canaux, jardins, 175 671 arbres, et un mode de vol libre.

## Origine

L'idée et la plus grande partie du cahier des charges viennent du banc d'essai public de
Charles de Lassence, « LLM benchmark: 3D Atlas of Paris » (octobre 2026), qui soumet la même
invite aux modèles frontière : https://lassence.net/demos/benchmark/ . Son texte (attentes et
sources) est reproduit dans `prompt_paris_3d.md` avec l'accord de son auteur (17/10/2026). Apport de Pascal Chevallot (Comptoir des
Signaux) : la section « Immersive 3D Fly-Through Navigation » (mode de vol libre).

Le code est écrit par un agent d'IA (Claude, Opus 5.5) sous la direction de Pascal
Chevallot. Ce que le travail a demandé, coûté et corrigé est raconté dans un carnet de bord
publié à part, sous licence CC BY-SA 4.0.

## Licences

- Code : EUPL-1.2 (`LICENSE`).
- Invite (`prompt_paris_3d.md`) : texte de Charles de Lassence, reproduit avec son accord,
  hors licence EUPL ; la section de vol libre est de Pascal Chevallot.
- Données dérivées chargées par la carte : ODbL 1.0 (`LICENCE-DONNEES.txt`), produites par
  `scripts/fetch_data.py` et `scripts/build_data.py`.
- Polices : SIL Open Font License, jointes au build (`licences/`).

## Lancer

```bash
npm install
python3 scripts/fetch_data.py      # sources ODbL vers data/raw/ (environ 130 Mo)
python3 scripts/build_data.py      # préparation vers public/data/ (environ 1 min)
npm run dev                        # http://localhost:5173
```

Les scripts Python demandent `numpy`, `pillow`, `scipy`, `shapely`, `mapbox-earcut`,
`pyproj` (3.8.0) et `pyshp` (3.1.6), ces deux derniers pour le PPRI en Lambert 93
(sous WSL : `uv venv ~/.venvs/paris3d && uv pip install ...`, puis lancer avec ce Python).

Version statique : `npm run build` produit `dist/` (environ 14 Mo), servi par n'importe quel
serveur de fichiers, sans réglage (`npm run preview` pour la tester). Le build :

- compresse les données en `.gz` (25 Mo bruts, 13 Mo transférés). Le navigateur les
  décompresse lui-même ; si le serveur les envoie déjà avec `Content-Encoding: gzip`, la
  signature gzip absente le détecte et rien n'est décompressé deux fois ;
- pose dans l'écran d'accueil le poids réellement transféré, mesuré sur `dist/` ;
- joint `data/LICENCE-DONNEES.txt` (base dérivée sous ODbL) et `licences/` (OFL des polices).

Rien ne se télécharge avant le clic sur « Lancer la carte ». Un lien en `?lancer` (depuis
une page qui annonce déjà le poids) saute cet écran. Les polices sont servies avec la carte
(Fontsource, sous-ensemble latin) : aucun appel à un tiers. Les mouvements de caméra
automatiques sont supprimés si le système demande de réduire les animations.

## Ce que fait la préparation (`scripts/build_data.py`)

- **Périmètre** : union des arrondissements moins les deux bois (polygones « Bois » des
  espaces verts, fermés morphologiquement pour emporter lacs, routes et enclaves).
- **Bâti** : emprises Apur retenues par leur point intérieur, hauteur médiane (`h_med`,
  sinon moyenne, sinon maximale), cours intérieures conservées, triangulation faite une fois
  pour toutes (earcut), positions quantifiées sur 16 bits. Le pied de chaque volume descend
  au point le plus bas du terrain sous l'emprise : aucun bâtiment ne flotte.
- **Dates** : année exacte (`an_const`) quand elle tombe dans la période déclarée, sinon les
  bornes de la période. Le shader en déduit absent, possible (transparence) ou attesté.
- **Relief** : altitude médiane du sol des emprises (`al_med_mnt`) interpolée sur une grille
  de 10 m, filtrée (médiane puis gaussienne).
- **Eau** : Seine à une cote approximative de 27 m, canaux trois mètres sous le terrain, quais
  en pierre, canal Saint-Martin couvert retiré. Le sol est percé sur l'eau.
- **Tour Eiffel** : ses sept emprises Apur sont remplacées par une maquette (`src/meshes.js`).

## Architecture du navigateur

| Fichier | Rôle |
|---|---|
| `src/main.js` | vues, lumière, boucle d'animation, interface, infobulle |
| `src/layers.js` | calques deck.gl et palette des périodes |
| `src/timeline-extension.js` | extensions GPU : voyage dans le temps, mise en exergue, découpe du sol, brume |
| `src/flight.js` | contrôleur du vol libre |
| `src/meshes.js` | sol, quais et socle, arbres, tour Eiffel |
| `src/data.js` | décodage des binaires, échantillonnage du relief |

Le temps, la mise en exergue d'une période et la brume sont des uniformes : changer d'année
ne recalcule aucun attribut, d'où une lecture fluide année par année.

## Navigation sur la carte

| Commande | Effet |
|---|---|
| Glisser (clic gauche) | tourner autour du point visé et incliner la vue |
| Glisser au clic droit, ou Ctrl + glisser | déplacer la carte |
| Molette | zoomer et dézoomer vers le pointeur |

## Vol libre

| Commande | Effet |
|---|---|
| Pointeur | la cible avance vers la direction indiquée, le regard suit en douceur |
| Clic gauche, ↑ | un cran de vitesse en avant (4 à 480 m/s) |
| Clic droit, ↓ | un cran en arrière ; sous zéro, la vitesse devient négative (marche arrière) |
| Maj maintenue | altitude constante (cote figée à l'appui), quelle que soit l'orientation |
| T | suivi du relief : hauteur au-dessus du sol maintenue, anticipée sur 1,2 s |
| ← →, Pg↑ Pg↓, glisser | virer, monter et descendre, regarder autour |
| Espace, Échap ou F | arrêt progressif ; sortie du vol |

Altitude constante et suivi du relief sont deux comportements distincts, et aucun des deux
n'évite les bâtiments : la barre d'état signale l'obstacle (surface des toits échantillonnée
devant la trajectoire), le passage sous le sol ou dans un bâtiment. Accélérations, virages et
changements d'altitude sont lissés exponentiellement ; l'entrée en vol depuis une vue lointaine
glisse vers une pose d'approche basse.

## Risque d'inondation

Trois couches, à afficher ou masquer, chargées au premier affichage seulement (environ 200 ko) :

- **Zonage du PPRI** : zonage réglementaire publié par l'État (DRIEAT), numérisé au 1/5 000
  sur le parcellaire cadastral, posé en voile sur le relief. Libellés et définitions tirés de
  la notice du PLU (`plub_pprizone`) : zone rouge, le cours de la Seine ; zone verte, zone
  d'expansion des crues ; zones bleues, zone de risque soumise aux prescriptions du PPRI,
  approuvé par arrêté préfectoral du 15 juillet 2003.
- **Caves inondées (crue 1910)** : scénario de crue type 1910 publié par la Ville, pas un
  relevé historique.
- **Bâtiments exposés seuls** : les bâtiments hors des couches affichées passent en gris ; les
  autres gardent la couleur de leur période (lecture âge × risque, la légende donne alors la
  part de chaque période parmi les exposés) ou prennent celle de leur zone. Le zonage suivant
  le parcellaire, il couvre les îlots, que les bâtiments masquent : il se lit sur le bâti.

Rapprochement avant affichage (`build_data.py`, chiffres dans `risques.json`) : le zonage de
l'État et son report dans le PLU de Paris se recouvrent à 0,998 (intersection sur union), zone
par zone de 0,98 à 1,00 sauf la zone bleu sombre hachurée (0,81, 0,17 km² contre 0,14) ; ils
placent 99,96 % des bâtiments dans la même zone. Seul le zonage de l'État, qui fait foi, est
affiché. Un bâtiment est rattaché à une zone par un point de son emprise ; quelques centaines
de bâtiments enclavés dans le zonage n'y figurent pas (212 à 346 selon une fermeture de 25 à
40 m, mesuré le 17/10/2026), dont Notre-Dame, dont l'emprise n'est couverte par aucune zone.
Information sans valeur réglementaire : seul le PPRI approuvé fait foi.

## Sources

ODbL : Apur, Emprise bâtie Paris ; Ville de Paris, Arrondissements, Plan de voirie : voies
d'eau, Espaces verts et assimilés, Les arbres, PLU bioclimatique : secteurs de risque,
inondations, Zones des caves inondées - 1910. Licence Ouverte 2.0 : DRIEAT Île-de-France,
Plan de prévention des risques d'inondation à Paris. Les données brutes et préparées ne sont
pas versionnées (`.gitignore`) : elles se régénèrent avec les deux scripts.
