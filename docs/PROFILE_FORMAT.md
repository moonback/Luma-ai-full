# Format de profil de projecteur

Pour importer des profils : *Fixtures › Importer des profils*. Le fichier JSON contient soit un profil, soit `{ "profiles": [ … ] }`. Chaque profil est validé (`validateProfile`). Les profils invalides sont signalés avec la cause, et seuls les profils valides sont ajoutés au projet.

```json
{
  "id": "acme-wash-19",
  "name": "Wash 19x15W",
  "manufacturer": "ACME",
  "type": "moving-head-wash",
  "physical": { "panRange": 540, "tiltRange": 270, "beamAngle": 12 },
  "modes": [
    {
      "name": "15ch",
      "channels": [
        { "name": "Pan", "attribute": "pan", "default": 128 },
        { "name": "Pan fine", "attribute": "pan", "fine": true },
        { "name": "Tilt", "attribute": "tilt", "default": 128 },
        { "name": "Tilt fine", "attribute": "tilt", "fine": true },
        { "name": "Dimmer", "attribute": "dimmer" },
        { "name": "Shutter", "attribute": "shutter", "default": 255, "ranges": [
          { "from": 0, "to": 7, "label": "Fermé", "kind": "closed" },
          { "from": 8, "to": 247, "label": "Strobe", "kind": "strobe" },
          { "from": 248, "to": 255, "label": "Ouvert", "kind": "open" }
        ] },
        { "name": "Rouge", "attribute": "red" },
        { "name": "Vert", "attribute": "green" },
        { "name": "Bleu", "attribute": "blue" },
        { "name": "Blanc", "attribute": "white" },
        { "name": "Reset", "attribute": "control", "ranges": [
          { "from": 0, "to": 199, "label": "—" },
          { "from": 200, "to": 255, "label": "Reset", "kind": "reset", "dangerous": true }
        ] }
      ]
    }
  ]
}
```

## Règles
- `id` : `[A-Za-z0-9_-]`. Les identifiants des profils intégrés (`demo-*`) sont réservés.
- `type` : `par`, `moving-head-spot`, `moving-head-wash`, `strobe`, `dimmer`, `led-bar` ou `other`. Ce type est utilisé par l'IA (« les lyres »).
- `attribute` : `dimmer red green blue white amber uv cyan magenta yellow cto colorWheel pan tilt panTiltSpeed shutter strobe gobo goboRotation prism focus zoom iris frost speed macro control`, ou `custom:<nom>`.
- Un attribut apparaît au plus une fois par mode. Un canal `fine: true` est l'octet de poids faible d'un attribut 16 bits, dont le canal principal doit exister.
- `cell` (facultatif) : numéro de cellule pour les projecteurs multi-cellules (barres LED, pixels). Un même attribut peut alors apparaître une fois par cellule (par exemple `red` en cellules 1 à 8).
- `default` : valeur DMX (0–255) émise quand aucune source ne contrôle le canal. Pour un shutter, choisissez la valeur « ouvert ».
- `ranges` : plages DMX qui ne se chevauchent pas, avec `kind` (`open`, `closed`, `strobe`, `color` + `color` en hexadécimal pour les roues, `gobo`, `reset`, `lamp-on`, `lamp-off`…). `dangerous: true` impose une confirmation manuelle et interdit la valeur à l'IA, aux scènes et aux effets.

Les noms et fonctions des canaux proviennent toujours du profil chargé : l'application ne suppose aucune disposition commune.

## Open Fixture Library
*Fixtures › Open Fixture Library* importe directement les fixtures OFL (licence MIT), soit depuis le catalogue en ligne (fabricant → modèle), soit depuis un fichier `.json` OFL. Le convertisseur gère les alias fins 16 bits, les roues de couleurs et de gobos, les shutters et strobes, les matrices de pixels (converties en cellules) et les canaux `Maintenance` (marqués dangereux). Tout canal non représentable devient un canal générique : les adresses restent exactes et un avertissement est affiché. Vérifiez toujours le profil importé avec le manuel du fabricant.
