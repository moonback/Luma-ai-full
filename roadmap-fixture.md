# Roadmap — Fixtures et patch DMX

> Complément de [ROADMAP.md](ROADMAP.md), centré sur la page **Fixtures** (« Patch DMX : profils, univers, adresses et positions ») : comment faire entrer **n'importe quelle machine réelle** dans l'application, la piloter correctement et la patcher vite. Rédigé le 18/10/2026 à partir du code actuel et d'un fichier réel : `BeamZ@MHL1940@26Channels@MHL1940.xml` (export grandMA2).

## 1. État actuel

| Brique | Fichier | Ce qu'elle fait aujourd'hui |
|---|---|---|
| Schéma profil | `src/core/model/schemas.ts` | Profil → modes → canaux (`attribute`, `fine`, `cell`, `default`, `ranges[]`). 27 attributs fixes + `custom:<nom>`. `physical` = pan/tilt/angle uniquement |
| Validation | `src/core/fixtures/profiles.ts` | `validateProfile`, plages sans chevauchement, modes uniques, `ProfileLibrary` (intégrés + projet) |
| Attributs | `src/core/fixtures/attributes.ts` | Classes (intensité, couleur, position, beam, spécial), clés de cellule `red#3` |
| Couleur | `src/core/fixtures/color.ts` | Capacité `rgb / rgbw / cmy / wheel` par cellule |
| Import JSON | `AppService` `profile.import` | Format Luma documenté (`docs/PROFILE_FORMAT.md`) |
| Import OFL | `src/core/fixtures/ofl.ts` | Catalogue en ligne + fichier, 16 bits, roues, matrices → cellules, maintenance → `dangerous` |
| Patch | `src/core/fixtures/patch.ts` | Empreinte, chevauchements, dépassement de 512, première adresse libre |
| Rendu DMX | `src/core/engine/render.ts` | Défauts, dimmer virtuel, master, blackout, découpe 16 bits, blocage des valeurs dangereuses |
| UI | `src/renderer/features/Fixtures.tsx` | Tableau du patch, ajout en série, éditeur (mode, univers, adresse, X/Y, rotation, hauteur, tags), dialogues OFL et JSON, localisation caméra |

### Limites constatées
1. **Une seule porte d'entrée « pro »** : OFL. Aucun import des formats que les fabricants et les consoles fournissent vraiment : **grandMA2 XML** (le fichier de l'exemple), **GDTF**, **QLC+ `.qxf`** (très fourni en BeamZ, Eurolite, Stairville…), Avolites, Sunlite.
2. **Aucun éditeur de profil** : pour une machine absente de tout catalogue (cas fréquent des marques d'entrée de gamme), il faut écrire du JSON à la main.
3. **Bibliothèque invisible** : pas de liste des profils du projet, pas de suppression (la commande `profile.remove` existe mais aucun bouton ne l'appelle), pas d'export, pas de bibliothèque partagée entre projets.
4. **Vocabulaire d'attributs trop court** : pas de blanc chaud / blanc froid / lime / indigo, pas de mode pan/tilt, de macros couleur, de roue d'effets, de vitesse de macro, d'intensité de strobe, de température de couleur distincte de CTO. Tout devient `custom:*`, que l'IA, les effets et les palettes ignorent.
5. **Multi-modules incomplet** : un projecteur à plusieurs « têtes » (lyre + anneau LED, barre + strobe) passe par les cellules, mais **`render.ts` ne traite que `dimmer`** : `dimmer#1` n'est ni multiplié par le grand master ni coupé par le blackout. **Risque de sécurité**.
6. **Pas de données physiques utiles** : fréquence du strobe en Hz, vitesse pan/tilt, angle de zoom min/max, plage de tilt asymétrique (−110/+110), dimensions, poids, puissance, couleur réelle de chaque émetteur.
7. **Valeurs par défaut 8 bits seulement** : le défaut d'un canal 16 bits (ex. pan = 21626/65535) perd son octet fin.
8. **Pas de macros d'entretien** : les « reset pan », « reset tilt », « reset total » (valeur X pendant 5 s puis retour) n'existent pas ; on ne peut qu'envoyer une valeur dangereuse à la main.
9. **Patch lent sur le terrain** : pas de vue « carte des 512 canaux », pas de notation `U.AAA`, pas de re-patch en lot, pas d'échange de profil, pas d'aide aux DIP switches, pas d'« identify » ni de test canal par canal, pas d'export de feuille de patch.

---

## 2. Analyse du fichier exemple : BeamZ MHL1940, mode 26 canaux

Format : export **grandMA2** (`<MA><FixtureType>`), schéma 3.9.60. Un fichier = **un mode** d'une machine.

### 2.1 Structure
- `FixtureType name="MHL1940" mode="26Channels"`, `manufacturer` = BeamZ.
- **2 modules** : `Main Module` (classe `Headmover`, beamtype `Wash`, corps 0,40 × 0,40 × 0,42 m) et `RGB Pix Ring` (classe `LED`, angle 12°).
- **2 instances** : instance 0 = module principal (canaux absolus = `coarse`), instance 1 = anneau avec `patch="18"` (canal absolu = 18 + `coarse` − 1).
- `Wheels` vide, `FixtureMacroCollect` = 4 macros de reset sur le canal 26.

### 2.2 Canaux reconstitués et correspondance cible

| DMX | Module | Attribut MA2 | Cible Luma aujourd'hui | Cible après cette roadmap |
|---|---|---|---|---|
| 1 / 2 | Main | PAN (coarse / fine), 0–540°, défaut 21626,55 | `pan` + fin, défaut 84 (fin perdu) | `pan` 16 bits, défaut 16 bits exact |
| 3 / 4 | Main | TILT, −110…+110° | `tilt` + fin, `tiltRange` 270 (faux) | `tilt`, `tiltMin/Max` = −110/110 |
| 5 | Main | POSITIONMODE | `custom:positionmode` | `panTiltMode` |
| 6 | Main | DIM | `dimmer` | `dimmer` |
| 7 | Main | SHUTTER : 7 fonctions (fermé, strobe 10→0,1 Hz, ouvert, pulse, ouvert, random, ouvert) | `shutter` + plages, fréquences perdues | `shutter`, plages avec `hzFrom/hzTo` |
| 8–11 | Main | COLORRGB1/2/3/5 (R, G, B, White) | `red green blue white` | idem + couleur d'émetteur |
| 12 | Main | ZOOM (0,7 → 1) | `zoom` | `zoom` + angle min/max |
| 13 | Main | EFFECTWHEEL | `custom:*` | `effectWheel` |
| 14 | Main | ZOOMMODE | `custom:*` | `zoomMode` |
| 15 | Main | COLORMIXMACROFADETIME | `custom:*` | `colorMacroFade` |
| 16 | Main | COLORTEMPERATURE | `cto` (approximatif) | `colorTemperature` |
| 17 | Main | COLORRGB6 (Warm White, `ffffcc`) | **doublon de `white` → générique** | `warmWhite` |
| 18 | Ring | DIM | `dimmer#1` — **non coupé au blackout** | `dimmer#1`, master + blackout |
| 19 | Ring | STROBEINTENSITY | `custom:*` | `strobe#1` |
| 20–22 | Ring | COLORRGB1/2/3 | `red#1 green#1 blue#1` | idem |
| 23 | Ring | COLORMIXMACROFADETIME | `custom:*` | `colorMacroFade#1` |
| 24 | Ring | EFFECTMACROS | `custom:*` | `macro#1` |
| 25 | Ring | EFFECTMACRORATE | `custom:*` | `macroSpeed#1` |
| 26 | Main | FIXTUREGLOBALRESET | `control` | `control` + macros d'entretien (52 = reset pan, 57 = tilt, 62 = zoom, 72 = total, 5 s) |

### 2.3 Pièges du format MA2 à gérer
- **Résolution des valeurs incohérente** : les `ChannelSet from_dmx` sont tantôt en 8 bits (shutter : 0–255), tantôt en 16 bits même sur un canal 8 bits (dimmer « open » = 65535). **Source fiable = `min_dmx_24` / `max_dmx_24`** des `ChannelFunction` (24 bits) : `dmx8 = floor(v24 / 65536)`.
- `default` est exprimé dans la résolution du canal (16 bits s'il y a un `fine`, sinon 8 bits avec décimales : `254.999` → 255).
- Plusieurs `ChannelFunction` du même canal donnent les **plages** ; `subattribute` donne leur nature (`STROBE`, `STROBE_PULSE_CLOSE`, `STROBE_RANDOM`, `SHUTTER`) ; `physfrom/physto` donne la fréquence en Hz.
- Canaux sans `ChannelSet` (macros, roue d'effets) : **une plage générique** couvrant 0–255.
- `patch` d'instance à appliquer, et canaux non déclarés (trous) → canaux génériques « inutilisé » pour garder les adresses exactes.
- Nom de fichier `Fabricant@Modèle@Mode@...xml` : utile pour regrouper plusieurs modes d'une même machine.

---

## 3. Les fonctionnalités

Légende effort : **S** ≤ 1 semaine · **M** 2–3 semaines · **L** 4 semaines et plus. Les numéros renvoient aux dépendances.

### Lot 0 — Prérequis de sécurité

#### 0. Blackout et grand master par cellule · S
- `finalizeFixture` : appliquer master et blackout à **toutes** les clés dont la base est `dimmer` (`dimmer`, `dimmer#1`…) ; dimmer virtuel calculé **par cellule** (une cellule sans dimmer propre suit le dimmer global).
- Politique `intensity-shutter` : fermer aussi les `shutter#n`.
- **Critères** : test sur un profil lyre + anneau (`dimmer` + `dimmer#1`) : blackout → les deux à 0 ; master 50 % → les deux à 50 %.

### Lot A — Modèle de profil plus riche

#### 1. Vocabulaire d'attributs étendu · S
- Ajouter à `BUILTIN_ATTRIBUTES` : `warmWhite`, `coldWhite`, `lime`, `indigo`, `colorTemperature`, `colorMacro`, `colorMacroFade`, `panTiltMode`, `effectWheel`, `macroSpeed`, `zoomMode`, `fog`, `fan`… avec classe et libellé dans `attributes.ts`.
- `EMITTER_ATTRIBUTES` et `color.ts` : prise en compte de `warmWhite/coldWhite/lime` (capacité `rgbw+`).
- OFL : `Warm White` → `warmWhite`, `Cold White` → `coldWhite` (fin des doublons convertis en génériques).
- **Critères** : projet ancien chargé sans migration ; test de conversion OFL d'un RGBWW.

#### 2. Données physiques et valeurs exactes · M
- `physical` : `tiltMin/tiltMax` (au lieu d'une plage symétrique), `zoomMin/zoomMax` (degrés), `panTiltTime` (s pour 540°), `dimensions` (m), `weight` (kg), `power` (W), `connector`.
- Canal : `default16` facultatif pour les attributs 16 bits ; `emitterColor` (hex) pour les canaux de couleur (le `ffffcc` du blanc chaud).
- Plage : `hzFrom/hzTo` pour les strobes et pulses ; `physFrom/physTo` génériques.
- Utilisation : effets strobe en Hz réels, visualiseur (vitesse, angle de zoom, taille du corps), estimation de puissance par circuit (feature 15).
- **Critères** : `migrateProject` sans perte ; tests de `render.ts` pour le défaut 16 bits.

#### 3. Multi-modules (« têtes ») · M · dépend de 0
- Ajouter `modules[]` au profil : nom, type de faisceau, angle, géométrie relative (anneau autour de la lentille, pixel n° k d'une barre). Un canal `cell` se rattache à un module.
- Visualiseur : l'anneau du MHL1940 rendu comme un anneau, pas comme un second faisceau.
- Console live / programmeur : sélection « tête principale » / « anneau » / « toutes ».
- **Critères** : le MHL1940 s'affiche avec 2 groupes de couleur nommés ; l'IA peut viser « l'anneau ».

#### 4. Macros d'entretien · S · dépend de 2
- `profile.maintenance[]` : `{ label, channel, value, holdSeconds, then }` (reset pan/tilt/zoom/total, lampe on/off).
- Bouton « Entretien » dans l'éditeur de projecteur et sur une sélection : confirmation, envoi de la valeur pendant la durée, retour au défaut, journal.
- Import : depuis `FixtureMacroCollect` (MA2), canaux `Maintenance` (OFL), `Capability Preset="ResetAll"` (QLC+).
- **Critères** : la valeur n'est jamais émise par une scène, un effet ou l'IA (règle `dangerous` actuelle conservée).

### Lot B — Faire entrer ses machines

#### 5. Import grandMA2 XML · M · dépend de 1, 2
- `src/core/fixtures/ma2.ts`, sur le modèle de `ofl.ts` : `convertMa2Fixture(xml) → { profile, warnings, errors }`.
- Analyse XML : `fast-xml-parser` (sans DOM, utilisable dans `core` et les tests ; servira aussi aux features 6 et 7).
- Table de correspondance des attributs MA2 → Luma (`DIM`, `PAN`, `TILT`, `SHUTTER`, `COLORRGB1..6`, `COLOR1` = roue, `GOBO1/2`, `GOBO1_POS`, `PRISMA1`, `FROST1`, `ZOOM`, `FOCUS1`, `IRIS`, `CTO`, `COLORTEMPERATURE`, `POSITIONMODE`, `EFFECTMACROS`…) ; inconnu → `custom:*` + avertissement.
- Règles de la section 2.3 : `dmx_24`, `patch` d'instance, trous, plages par `ChannelFunction`, Hz depuis `physfrom/physto`, roues depuis `<Wheels><Wheel><Slot>`, macros de reset, `class/beamtype` → `type`.
- **Fusion de modes** : importer plusieurs XML du même fabricant + `short_name` ajoute des modes au même profil (`ma2-beamz-mhl1940`).
- Dialogue d'ouverture : filtres `.json`, `.xml`, `.gdtf`, `.qxf` et détection automatique du format.
- **Critères** : le fichier exemple est copié dans `tests/fixtures/ma2/` et donne exactement le tableau 2.2 (26 canaux, `pan`/`tilt` 16 bits, 7 plages de shutter, 4 macros) ; un XML malformé renvoie une erreur lisible, jamais une exception.

#### 6. Import GDTF · L · dépend de 3, 5
- Standard industriel (DIN SPEC 15800) publié par les fabricants et sur GDTF Share. Fichier ZIP (`description.xml` + modèles 3D + gobos) : `fflate` pour décompresser.
- DMXModes → modes, Geometries → modules (feature 3), ChannelFunctions → plages, Wheels → roues avec images de gobos, PhysicalDescriptions → couleurs d'émetteurs.
- Prépare l'import **MVR** (plan de feu complet) prévu dans la roadmap scène.
- **Critères** : 5 fichiers GDTF de référence (lyre spot, wash, barre pixel, strobe, PAR) importés sans canal générique imprévu.

#### 7. Import QLC+ `.qxf` · M · dépend de 5
- Format XML simple, bibliothèque très riche en marques d'entrée de gamme (BeamZ, Eurolite, Stairville, Cameo, Showtec).
- `Channel/Group` + `Preset` → attribut ; `Capability Min/Max` → plages ; `Mode/Head` → cellules ; `Physical` → données physiques.
- **Critères** : 10 fichiers `.qxf` de marques différentes importés ; mêmes règles d'avertissement qu'OFL.

#### 8. Éditeur de profil intégré · L · dépend de 1, 2
- Nouvel onglet « Bibliothèque » de la page Fixtures : créer, dupliquer, modifier un profil sans écrire de JSON.
- Saisie rapide d'un tableau DMX du manuel : une ligne par canal (n°, nom, attribut proposé automatiquement d'après le nom : « Pan fine », « Strobe », « Warm White »…), plages ajoutées par canal avec type et Hz.
- Modes : dupliquer un mode, réordonner les canaux par glisser-déposer, détection en direct des erreurs (`validateProfile` affiché ligne par ligne).
- Mode « coller » : coller un tableau copié depuis un PDF ou un tableur (colonnes canal / fonction / valeurs) → pré-remplissage à vérifier.
- **Critères** : recréer le MHL1940 26 canaux à la main en moins de 10 minutes ; un profil importé (OFL, MA2…) est modifiable et marqué « modifié ».

#### 9. Bibliothèque de profils · M · dépend de 8
- Liste des profils du projet : fabricant, modèle, modes, source (intégré, JSON, OFL, MA2, GDTF, QLC+, manuel), nombre de projecteurs qui l'utilisent, avertissements d'import conservés.
- Actions : supprimer (via `profile.remove`, bloqué si utilisé), exporter en JSON Luma, renommer, comparer deux profils.
- **Bibliothèque utilisateur** hors projet (`userData/profiles/`) : un profil importé une fois est disponible dans tous les projets ; copié dans le projet au patch pour que le fichier `.luma` reste autonome.
- Recherche unifiée dans le dialogue « Ajouter » : bibliothèque utilisateur + projet + OFL en ligne.
- **Critères** : supprimer un profil utilisé est refusé avec le nombre de projecteurs ; un projet ouvert sur un autre ordinateur garde ses profils.

#### 10. Vérification d'un profil sur la machine · M · dépend de 8
- Mode « Test du profil » : la machine est patchée, chaque canal a un curseur DMX brut et chaque plage un bouton ; l'utilisateur coche « conforme » canal par canal.
- Statut de profil : `non vérifié` / `vérifié sur machine (date)`. Les profils importés démarrent en `non vérifié` (rappel actuel « vérifiez avec le manuel » rendu actionnable).
- **Critères** : impossible d'émettre une plage `dangerous` depuis ce mode sans confirmation.

### Lot C — Patch rapide et fiable

#### 11. Carte DMX par univers · M
- Vue grille 512 cases par univers : blocs colorés par projecteur, trous visibles, conflits en rouge, glisser un bloc pour le ré-adresser.
- Notation `U.AAA` (ex. `2.101`) dans tous les champs d'adresse, saisie comprise aussi.
- **Critères** : ré-adresser par glisser-déposer passe par `fixture.update` et reste annulable (feature 14).

#### 12. Re-patch en lot et échange de profil · M · dépend de 11
- Sélection multiple → « Re-patcher à partir de… » (adresses consécutives, avec un écart possible), changer d'univers, renuméroter les noms.
- « Changer de profil/mode » sur des projecteurs déjà patchés : correspondance des attributs, aperçu des scènes, palettes et effets qui perdront des valeurs.
- Ajout : quantité au-delà de 128, débordement automatique sur l'univers suivant, option « laisser N canaux libres ».
- **Critères** : passer 8 MHL1940 de 26 à un autre mode conserve les couleurs et positions des scènes.

#### 13. Aide au réglage des machines · S
- Pour chaque projecteur : adresse affichée comme sur l'écran de la machine (`d001`, `A.001`) et **position des DIP switches** (schéma 1–9/10) pour les machines sans afficheur.
- **Identify** : bouton (et raccourci) qui met le projecteur en blanc plein / faisceau ouvert quelques secondes, les autres à 0, pour le repérer sur le pont. RDM identify en complément quand disponible (`rdm.identify` existe déjà).
- **Critères** : l'identify est restitué à la fin sans laisser de valeur forcée.

#### 14. Annulation et historique du patch · S
- Annuler / rétablir pour ajout, suppression, déplacement, re-patch, changement de mode (aujourd'hui l'annulation n'existe que dans la timeline).
- **Critères** : 50 niveaux, persistance dans la session.

#### 15. Feuilles de patch et puissance · S · dépend de 2
- Export CSV et PDF : nom, profil, mode, univers, adresse, DIP, position, tags, puissance.
- Total de puissance par univers / par tag (circuit) avec alerte au-delà d'un seuil (ex. 16 A / 3 600 W).
- **Critères** : le CSV se réimporte (feature 16).

#### 16. Import de patch · M · dépend de 5, 15
- Importer un patch depuis CSV, depuis un show grandMA2 (liste de fixtures avec `FixtureType`), ou MVR (après la feature 6).
- Profils manquants listés avec un bouton « trouver » (bibliothèque, OFL, fichier).
- **Critères** : un CSV exporté par la feature 15 recrée le patch à l'identique.

### Lot D — Intelligence

#### 17. Reconnaissance automatique · M · dépend de 1, 5
- À l'import, rapprochement fabricant/modèle avec OFL et la bibliothèque utilisateur : « ce profil existe déjà, en mode 18 canaux et 26 canaux ».
- Proposition d'attribut d'après le nom du canal, pour tous les canaux `custom:*` restants (règles + LLM facultatif).
- **Critères** : 0 appel réseau sans action de l'utilisateur.

#### 18. Import de manuel PDF · L · dépend de 8
- Déjà prévu dans [ROADMAP.md](ROADMAP.md) (5.2) : le résultat s'ouvre dans l'éditeur de la feature 8, en différence face au tableau du PDF, plages dangereuses à confirmer.

---

## 4. Ordre conseillé

| Étape | Features | Résultat |
|---|---|---|
| 1 | **0**, 1 | Blackout sûr sur les multi-têtes, vocabulaire suffisant pour le MHL1940 |
| 2 | **5**, 2, 4 | Les fichiers grandMA2 s'importent tels quels, resets inclus |
| 3 | 8, 9 | Les machines sans fichier se créent en quelques minutes et suivent d'un projet à l'autre |
| 4 | 13, 11, 12, 14 | Patch sur le terrain : identify, DIP, carte DMX, re-patch, annulation |
| 5 | 7, 3, 10 | Catalogue QLC+, multi-têtes propres, profils vérifiés sur machine |
| 6 | 6, 15, 16, 17, 18 | GDTF/MVR, feuilles de patch, intelligence |

## 5. Points d'attention
- **Format de projet** : chaque ajout au schéma passe par `migrateProject` et reste facultatif ; les profils intégrés `demo-*` ne changent pas.
- **Sécurité** : toute plage de reset, lampe ou macro importée est `dangerous` par défaut ; seule une confirmation manuelle l'émet.
- **Licences** : OFL (MIT) et GDTF Share autorisent la réutilisation ; les bibliothèques QLC+ (Apache 2.0) aussi, avec mention. Les fichiers grandMA2 exportés par l'utilisateur restent locaux.
- **Tests** : un dossier `tests/fixtures/<format>/` par importeur, avec le fichier source et le profil Luma attendu.
