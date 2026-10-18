# Roadmap — La scène (visualiseur 2D / 3D)

> Complément de [ROADMAP.md](ROADMAP.md) (ergonomie de la page 3D : [roadmap-stage3d.md](roadmap-stage3d.md)), centré sur la **scène** : son modèle, son rendu, son édition et ce qu'elle apprend à l'opérateur. Rédigé le 17/10/2026 à partir du code actuel.

## 1. État actuel

| Brique | Fichier | Ce qu'elle fait aujourd'hui |
|---|---|---|
| Modèle visuel | `src/core/visualizer/model.ts` | `VisualFixture` agnostique du rendu : couleur, intensité, pan/tilt, zoom, cellules LED, strobe, gobo, prisme |
| Géométrie des faisceaux | `src/core/visualizer/beam.ts` | Direction, impact sur **sol ou cyclo uniquement**, forme de la tache, scintillement strobe |
| Vue 3D | `src/renderer/features/Stage3D.tsx` | three.js + bloom, 5 caméras fixes, brume, taches, noms, sélection au clic, plein écran, fenêtre détachable |
| Rig 3D | `src/renderer/features/stage3d/rig.ts` | Lyres articulées, cône volumétrique en shader, facettes de prisme, faisceaux par cellule |
| Décor | `src/renderer/features/stage3d/environment.ts` | Plateau rectangulaire, cyclo, coulisses, salle, truss **déduites des rangées de projecteurs** |
| Vue 2D | `src/renderer/features/Visualizer.tsx` | Plan de dessus, glisser-déposer des projecteurs, zoom/pan |
| Schéma projet | `src/core/model/schemas.ts` | Scène = `stageWidth` + `stageDepth` ; projecteur = `x`, `y`, `height`, `rotation` |

### Limites constatées
1. **La scène est vide** : pas de décor, de praticables, d'interprètes ni d'écrans. Impossible de juger si le chanteur est éclairé.
2. **Plateau rectangulaire uniquement** ; truss implicites, impossibles à dessiner ; accroche déduite de la hauteur (`< 1 m` = au sol), pas d'inclinaison de montage.
3. **Édition seulement en 2D**, projecteur par projecteur, sans alignement ni annulation (l'annulation n'existe que dans la timeline).
4. **Rendu sans lumière réelle** : les objets ne sont pas éclairés, pas d'ombres ; un mesh par projecteur, pas d'instancing (objectif de 5 000 projecteurs de la Phase 0 inatteignable en 3D).
5. **Caméras figées** (5 vues), pas de vue depuis un projecteur, pas de capture.
6. **Aucune analyse** : couverture, zones mortes, éblouissement du public, collisions : rien n'est mesuré alors que `beam.ts` sait déjà calculer les impacts.
7. **Aucune interopérabilité** : pas d'import/export MVR/GDTF, pas de plan d'implantation imprimable.

---

## 2. Les 20 fonctionnalités

Légende effort : **S** ≤ 1 semaine · **M** 2–3 semaines · **L** 4 semaines et plus. Les numéros renvoient aux dépendances.

### Lot A — Construire la scène (modèle et édition)

#### 1. Décor et praticables · M
- Nouveau tableau `visualizer.props[]` dans le schéma projet : boîte, cylindre, escalier, praticable, pendrillon, avec position, taille, rotation, couleur, nom.
- Rendu en 3D (`environment.ts`) et en 2D (contour coté).
- `beamHit()` étendu aux boîtes alignées : les faisceaux s'arrêtent sur le décor et la tache s'y dessine.
- **Critères** : migration de projet sans perte (`migrateProject`) ; test de `beamHit` sur un praticable.

#### 2. Formes de plateau · S
> **Livré (17/10/2026)** : rectangle, avancée (dimensions réglables), arène 360° ; cyclo activable ; caméras recadrées sur l'avancée. Reste : scène en T, trapèze, couleur et hauteur du cyclo.
- `stageShape` : rectangle (actuel), avancée / catwalk, scène en T, trapèze, arène 360° (public sur 4 côtés, sans cyclo).
- Cyclo optionnel avec couleur et hauteur réglables.
- **Critères** : les 5 caméras se recadrent automatiquement selon l'emprise.

#### 3. Structures et accroches explicites · M
> **Livré (17/10/2026)** : truss droites, cercles et carrés (longueur, hauteur, rotation, sur pieds ou suspendues), éditées dans le panneau « Scène » et dessinées en 2D et 3D ; accroche par `trussId` avec suivi automatique (déplacement, rotation, hauteur) et décrochage à la suppression ; aimantation au dépôt en 2D et en 3D ; accroche auto / suspendue / posée / murale et inclinaison. Les truss implicites ont été retirées le 17/10/2026 : un projecteur non accroché est dessiné seul, et ajouter des projecteurs au patch n'ajoute plus aucune structure.
- Les truss deviennent des objets (`visualizer.trusses[]`) : droite, cercle, carré, longueur, hauteur, pieds ou suspendue.
- Un projecteur peut être **accroché** à une truss (`fixture.trussId`) : il suit ses déplacements, aimantation au placement.
- Orientation de montage complète (`mountTilt`, accroche suspendue / posée / murale) au lieu de la règle « hauteur < 1 m ».
- ~~Les truss implicites actuelles restent le comportement par défaut pour les anciens projets.~~ Abandonné : elles apparaissaient à chaque ajout de projecteur ; seules les structures posées par l'utilisateur sont dessinées.

#### 4. Édition directe dans la 3D · M
> **Livré (17/10/2026)** : mode « Éditer » avec gizmo pour déplacer, monter et pivoter projecteurs et truss (les projecteurs accrochés suivent pendant le glisser) ; grille libre / 0,25 / 0,5 / 1 m et rotations par 15° ; cotes affichées pendant le déplacement ; annuler / rétablir de la scène (boutons, Ctrl+Z, Ctrl+Y), indépendant des autres modifications. Reste : les décors, qui attendent la fonctionnalité 1.
- `TransformControls` (déjà présent dans `three/examples`) : déplacer, monter, pivoter projecteurs, décors et truss dans la vue 3D.
- Aimantation à une grille (0,25 / 0,5 / 1 m), affichage des cotes pendant le déplacement.
- **Annuler / rétablir global** des modifications de scène, basé sur les commandes `act()` existantes.

#### 5. Outils de placement en lot · S
- Sur une multi-sélection (2D et 3D) : aligner, répartir régulièrement, symétrie jardin/cour, disposer en arc ou en cercle, copier avec décalage.
- Patch automatique des adresses à la duplication.

#### 6. Points de scène (markers) · S
> **Livré (17/10/2026)** : points nommés avec hauteur de visée, édités dans le panneau « Scène », déplaçables en 2D (mode Positionner), affichés en 3D. Reste : usage par l'IA et les palettes de position (3.2).
- Repères nommés posés sur le plateau (« chanteur », « batteur », « centre avant-scène ») avec hauteur de visée.
- Visibles en 2D et 3D, utilisables par l'IA et par les palettes de position.
- **Prérequis direct** de la 3.2 (focus automatique) et de la 3.3 (suivi) du ROADMAP principal.

#### 7. Interprètes et instruments · M
> **Livré (17/10/2026)** : silhouettes debout, assis, batterie, clavier, pupitre, posées librement ou sur un point de scène (elles le suivent) ; éclairement estimé sur le visage (couleur et niveau en 2D et en 3D) et badge « Dans le noir ». Reste : l'option de déplacement le long d'un chemin synchronisé sur la timeline.
- Silhouettes déplaçables (personne debout / assise, batterie, clavier, pupitre) rattachables à un point de scène (6).
- **Éclairement estimé** : chaque silhouette prend la couleur et le niveau des faisceaux qui la touchent (test d'appartenance au cône depuis `beamDirection` + `beamAngle`), pour voir immédiatement si quelqu'un est dans le noir.
- Option : rejouer un déplacement d'interprète le long d'un chemin, synchronisé sur la timeline.

### Lot B — Rendu

#### 8. Mode « éclairage réel » avec ombres · L
> **Livré (17/10/2026)** : bouton « Ombres » sans rechargement ; spots three.js donnés aux projecteurs les plus intenses, budget adaptatif de 4 à 24 sources selon la cadence ; ombres des truss, interprètes et écrans. Mesuré : 55 i/s avec 12 à 16 sources. Limite matérielle : une ombre occupe une unité de texture, donc 12 sources ombrées au plus sur une carte à 16 unités ; les suivantes éclairent sans ombre. Le critère de 24 sources ombrées n'est pas atteignable sur ce matériel.
- Mode qualité optionnel : `SpotLight` three.js pour les N projecteurs les plus contributifs (budget adaptatif), ombres portées du décor (1) et des interprètes (7).
- Le mode actuel (shader de cône + taches) reste le mode rapide par défaut.
- **Critères** : ≥ 30 i/s avec 24 sources ombrées sur une carte graphique intégrée ; bascule sans recharger la scène.

#### 9. Brume vivante · S
> **Livré (17/10/2026)** : brume animée dans le shader des faisceaux, fumée basse (bouton « Fumée »). Reste : densité par zone.
- Bruit 3D animé dans `beamMaterial()` : la brume dérive et ondule au lieu d'être uniforme.
- Fumée lourde au sol (nappe animée) et réglage de densité par zone (plus dense au lointain).
- Le curseur « brume » existant pilote l'ensemble.

#### 10. Ambiances de salle et matériaux · S
> **Livré (17/10/2026)** : salle noire, lumière de service, plein air nuit, club, théâtre ; sol mat, laqué ou mouillé (reflets réels du plateau et de l'avancée). Le sol réfléchissant coûte un rendu de plus (≈ 38 i/s mesurés avec les ombres).
- Préréglages : salle noire, lumière de service, plein air nuit, club, théâtre (couleur du fond, éclairage ambiant, brouillard de distance).
- Sol réfléchissant optionnel (plateau laqué / sol mouillé) et choix du matériau du plateau.

#### 11. Écrans LED et surfaces vidéo · M
> **Livré (17/10/2026)** : écrans placés librement (couleur, image réduite à 512 px et enregistrée dans le projet, vidéo choisie pour la séance et non enregistrée, pixel mapping des barres LED) ; halo dans la brume et lumière diffusée sur le plateau. Écart : les écrans ne font pas encore partie d'un décor (fonctionnalité 1).
- Surfaces d'écran dans le décor (1) affichant : une couleur, une image, une vidéo, ou le **pixel mapping** des barres LED et matrices du kit.
- L'écran éclaire légèrement son environnement (contribution à la brume et au sol).

#### 12. Modèles 3D par famille et import glTF · M
- Corps distincts par `FixtureType` (PAR, lyre spot / wash / beam, barre, stroboscope, découpe, machine à fumée) au lieu du modèle générique.
- Import optionnel d'un modèle glTF par profil, avec repères de pan/tilt/lentille.

#### 13. Performance grands kits · M
- `InstancedMesh` pour les corps et les cônes de faisceaux, mise à jour par attributs au lieu d'objets individuels.
- Niveaux de détail selon la distance et qualité adaptative pilotée par le compteur d'i/s déjà affiché.
- **Critères** : 1 000 projecteurs à 60 i/s, 5 000 à 30 i/s ; nouveau cas dans `vitest.perf.config.ts`.

### Lot C — Regarder, comparer, analyser

#### 14. Caméras libres, vue projecteur et capture · S
> **Livré (17/10/2026)** : vues enregistrées dans le projet, vue projecteur, capture PNG, enregistrement WebM. Reste : capture à résolution supérieure à l'écran.
- Enregistrer des points de vue nommés dans le projet, transitions animées entre eux.
- **Vue « depuis le projecteur »** (œil du faisceau) pour régler un focus.
- Capture PNG haute définition et enregistrement WebM de la vue (`MediaRecorder` sur le canvas) ; première étape avant l'export MP4 synchronisé (4.6 du ROADMAP).

#### 15. Mode aveugle et comparaison A/B · M
- **Blind** : afficher dans la scène une cue, un look IA ou le programmeur **sans l'envoyer au DMX** (le canvas 2D accepte déjà des `values` externes).
- Écran partagé : « en sortie » / « prochaine cue », avec bascule et curseur de fondu.
- Les propositions de l'IA s'ouvrent par défaut en aveugle avant validation.

#### 16. Carte de couverture · M
- Vue de dessus en carte de chaleur : éclairement estimé au sol et sur le décor à partir des taches de `poolShape()`.
- Zones mortes signalées, notamment sur les points de scène (6) et les interprètes (7) ; équilibre jardin/cour chiffré.
- Base mesurable de l'auto-critique visuelle (4.3 du ROADMAP).

#### 17. Alertes de sécurité visuelles · S
> **Livré en partie (17/10/2026)** : badge « Éblouissement public » pour les lyres (axe du faisceau, hauteur des yeux 1,1–1,8 m, avancée et arène prises en compte). Reste : collisions avec truss et décor, branchement sur la validation IA et le Flash Guard.
- **Éblouissement du public** : faisceau qui atteint la zone salle à hauteur des yeux (1,2–1,8 m), surtout en faisceau serré ou strobe.
- **Collisions** : faisceau coupé par une truss ou un décor, lyre dont la course pan/tilt touche une structure.
- Badges dans la vue et règles réutilisables par la validation des actions IA et par le Flash Guard.

#### 18. Trajectoires des mouvements · S
- Dessiner sur le plateau le chemin que parcourent les taches des lyres pendant un effet ou une transition de cue (échantillonnage du moteur hors ligne).
- Repérer d'un coup d'œil un balayage qui passe par la salle ou un croisement non voulu.

### Lot D — Échanger avec le monde réel

#### 19. Plan d'implantation (light plot) · M
- Export PDF / SVG du plan de dessus : symboles par type, nom, univers/adresse, truss cotées, légende et nomenclature (nombre par modèle, consommation estimée).
- Import d'une **image de fond calibrée** (plan de salle, DWG exporté en image) sous la vue 2D, mise à l'échelle par deux points.

#### 20. Import / export MVR (GDTF) · L
- Lire et écrire le format **My Virtual Rig** (archive avec scène XML + profils GDTF) : positions, truss, décors, patch.
- Échange avec les visualiseurs et consoles du marché (grandMA3, Capture, Vectorworks Spotlight).
- Réutiliser l'import de profils existant (`src/core/fixtures/ofl.ts`) comme modèle de conversion.
- **Critères** : aller-retour d'un projet sans perte de position ni d'adresse ; import d'un fichier MVR de référence publié.

---

## 3. Ordre conseillé

| Étape | Fonctionnalités | Pourquoi |
|---|---|---|
| 1 — Fondations rapides | 2, 6, 9, 14, 17 | Petites, très visibles, débloquent la suite (points de scène, vue projecteur, sécurité) |
| 2 — Peupler la scène | 1, 3, 5, 7 | Le décor et les interprètes rendent toute analyse pertinente |
| 3 — Éditer et décider | 4, 15, 16, 18 | Édition 3D, mode aveugle et analyses s'appuient sur le modèle enrichi |
| 4 — Rendu avancé | 10, 11, 12, 13, 8 | Instancing (13) avant les ombres (8) pour garder le budget de rendu |
| 5 — Interopérabilité | 19, 20 | Exige un modèle de scène stabilisé |

## 4. Principes à respecter
- **Le modèle reste agnostique** : tout nouvel élément passe par `core/visualizer` (testable sans three.js) avant d'être rendu en 2D et 3D.
- **La scène ne pilote jamais le DMX par erreur** : les modes aveugle, analyse et édition n'écrivent rien en sortie sans action explicite.
- **Aide visuelle, pas photométrie** : l'interface continue de dire que les niveaux affichés sont des estimations.
- **Compatibilité** : chaque ajout au schéma a une valeur par défaut et une migration ; les anciens projets s'ouvrent à l'identique.
