"""Téléchargement des données sources dans data/raw/ (ODbL, et Licence Ouverte 2.0 pour le PPRI).

Usage : python scripts/fetch_data.py
Idempotent : un fichier déjà présent n'est pas retéléchargé.
"""
import json
import pathlib
import time
import urllib.parse
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor

RAW = pathlib.Path(__file__).resolve().parent.parent / "data" / "raw"
APUR = "https://carto2.apur.org/apur/rest/services/OPENDATA/EMPRISE_BATIE_PARIS/MapServer/0/query"
APUR_FIELDS = ",".join([
    "n_sq_eb", "an_const", "an_rehab", "an_surelevation", "c_perconst",
    "h_moy", "h_med", "h_min", "h_max", "al_med_mnt", "al_med_mne",
    "n_sq_ar", "b_igh", "b_dalle", "b_horspu", "c_morpho", "c_tissu", "Shape_Area",
])
PAGE = 2000
OPENDATA = "https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/{}/exports/{}"
# PPRI de Paris, zonage réglementaire publié par l'État (DRIEAT), archive Atom : shapefile en Lambert 93
PPRI_ETAT = ("https://atom.geo-ide.developpement-durable.gouv.fr/atomArchive/GetResource"
             "?id=c0e04297-99a3-4230-8975-991c33c37e1b&dataType=dataset")


def get(url, tries=5):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "paris-3d/1.0"})
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read()
        except Exception as e:  # réseau capricieux : on réessaie
            if i == tries - 1:
                raise
            time.sleep(2 + 3 * i)
            print("  nouvel essai", url[:90], e)


def apur_page(offset):
    out = RAW / "apur" / f"page_{offset:06d}.geojson"
    if out.exists():
        return
    q = urllib.parse.urlencode({
        "where": "1=1", "outFields": APUR_FIELDS, "outSR": 4326, "f": "geojson",
        "orderByFields": "OBJECTID", "resultOffset": offset, "resultRecordCount": PAGE,
        "geometryPrecision": 7,
    })
    data = get(f"{APUR}?{q}")
    n = len(json.loads(data)["features"])
    out.write_bytes(data)
    print(f"  Apur {offset:>6} : {n} emprises")


def main():
    (RAW / "apur").mkdir(parents=True, exist_ok=True)
    total = json.loads(get(f"{APUR}?where=1%3D1&returnCountOnly=true&f=json"))["count"]
    print(f"Apur : {total} emprises bâties")
    with ThreadPoolExecutor(4) as ex:
        list(ex.map(apur_page, range(0, total, PAGE)))

    for name, fmt, params in [
        ("arrondissements", "geojson", {}),
        ("plan-de-voirie-voies-deau", "geojson", {}),
        ("espaces_verts", "geojson", {}),
        ("plub_pprizone", "geojson", {}),                 # PLU : report du zonage du PPRI
        ("zones-de-caves-inondees-1910", "geojson", {}),  # scénario de crue type 1910
        ("les-arbres", "csv", {
            "select": "idbase,domanialite,arrondissement,libellefrancais,genre,espece,"
                      "circonferenceencm,hauteurenm,stadedeveloppement,remarquable,geo_point_2d",
            "delimiter": ";",
        }),
    ]:
        out = RAW / f"{name}.{fmt}"
        if out.exists():
            continue
        url = OPENDATA.format(name, fmt) + ("?" + urllib.parse.urlencode(params) if params else "")
        out.write_bytes(get(url))
        print(f"{name} : {out.stat().st_size / 1e6:.1f} Mo")

    ppri = RAW / "ppri_etat"
    if not ppri.exists():
        archive = RAW / "ppri_etat.zip"
        archive.write_bytes(get(PPRI_ETAT))
        with zipfile.ZipFile(archive) as z:
            z.extractall(ppri)
        archive.unlink()
        print(f"PPRI (État) : {sum(1 for _ in ppri.rglob('*.shp'))} couche(s)")


if __name__ == "__main__":
    main()
