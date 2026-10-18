# Roadmap — Stage 3D : interface et création de scène

> Complément de [roadmap-scene.md](roadmap-scene.md) (modèle, rendu, analyses), centré ici sur l'**ergonomie** de la page Stage 3D et sur la **création de scène**. Rédigé le 17/10/2026 à partir du code actuel (`src/renderer/features/Stage3D.tsx`, `Visualizer.tsx`, `stage3d/*`).

## 1. Analyse de l'existant

### Ce qui fonctionne bien
- Rendu riche et rapide : faisceaux volumétriques, taches et gobos, brume animée, fumée, ombres réelles à budget adaptatif, ambiances, sols réfléchissants, écrans LED.
- Édition directe au gizmo (projecteurs et structures), grille, cotes pendant le déplacement, annuler / rétablir propre à la scène.
- Analyses utiles : « Dans le noir » (interprètes), « Éblouissement public » (lyres).
- Modèle agnostique (`core/visualizer`) testé sans three.js.

### Problèmes d'interface constatés
| # | Constat | Effet pour l'utilisateur |
|---|---|---|
| 1 | La barre d'outils 3D alignait **plus de 20 contrôles** sur une ligne : caméras, alertes, brume, glow, taches, fumée, ombres, ambiance, sol, noms, édition, outils, grille, capture, vidéo, plein écran, i/s. | Elle passait sur 2 ou 3 lignes et masquait le haut de la vue ; les alertes se perdaient au milieu des réglages. |
| 2 | Le panneau « Scène » s'ouvrait **au-dessus** de la vue, en lignes de 6 à 9 champs titrés d'une seule lettre (X, Y, H, L, °). | La vue 3D était repoussée hors de l'écran pendant l'édition ; les champs étaient difficiles à identifier. |
| 3 | Les dimensions du plateau étaient dans l'en-tête de page, le reste du plateau dans le panneau. | Réglages du plateau éparpillés en deux endroits. |
| 4 | Sans projecteur, la vue était **remplacée** par « Scène vide ». | Impossible de construire le décor avant de faire le patch. |
| 5 | Créer une scène, c'était ajouter les éléments un par un, tous posés au même point par défaut. | Long, et les objets s'empilent au centre du plateau. |
| 6 | Les noms modifiés gardaient l'ancienne valeur après Ctrl+Z (champ non contrôlé). | Le nom affiché ne correspondait plus au nom enregistré. |
| 7 | Boutons à icône seule sans nom accessible (capture, vidéo, plein écran, outils). | Lecteurs d'écran : boutons sans nom. |
| 8 | En 3D, seuls les projecteurs et les structures sont sélectionnables. Les points, interprètes et écrans ne se modifient que par des champs. | Deux façons de travailler selon le type d'objet. |
| 9 | Deux panneaux flottants (projecteur, structure) en bas à droite, sans lien avec le panneau Scène. | Pas d'inspecteur unique ; la sélection 3D n'apparaît pas dans la liste. |

---

## 2. Livré dans cette passe (17/10/2026)

- **Panneau latéral « Construire la scène »** (2D et 3D) : posé à côté de la vue au lieu d'au-dessus, découpé en sections repliables avec compteur (Modèle, Plateau, Points de scène, Structures, Interprètes, Écrans). Chaque élément est une carte : en-tête avec nom, type et suppression, puis une grille de champs titrés en clair (Longueur, Hauteur, Rotation…).
- **Modèles de scène en un clic** (`src/core/visualizer/templates.ts`) : Concert, Théâtre, Club / DJ, Conférence, Arène 360°, Défilé. Chacun fixe le plateau, les points, les structures, les interprètes posés sur leurs points et les écrans. Si la scène n'est pas vide, une confirmation est demandée ; le remplacement s'annule avec Ctrl+Z. La section « Partir d'un modèle » est ouverte quand la scène est vide et repliée sinon. Un test unitaire vérifie que chaque modèle donne un projet valide.
- **Plateau regroupé** : forme, largeur, profondeur, avancée et cyclorama dans une seule section ; l'en-tête de page garde Scène, Positionner (2D), Annuler / Rétablir, Groupe et Détacher.
- **La vue reste affichée sans projecteur**, avec un bandeau « Aucun projecteur… » et un bouton « Construire la scène ».
- **Barre d'outils 3D réorganisée** : caméras à gauche ; Éditer (et ses outils), **menu « Rendu »** (brume, glow, taches, fumée, noms, ombres, ambiance, sol), capture, vidéo, plein écran et i/s à droite. Le menu se ferme avec Échap, un nouveau clic sur « Rendu » ou un clic dans la vue.
- **Alertes déplacées en bas à gauche**, au-dessus de l'aide, où elles restent visibles.
- Les noms se mettent à jour après annuler / rétablir ; noms accessibles ajoutés sur les boutons à icône.

---

## 3. Suite proposée

Effort : **S** ≤ 1 semaine · **M** 2–3 semaines · **L** 4 semaines et plus.

### Étape 1 — Créer plus vite (priorité haute)

#### 1.1 Équiper un modèle · S
> **Livré (17/10/2026)** : bouton « Équiper les structures » (section Structures). Il traite la sélection si elle existe, sinon tous les projecteurs suspendus ; ceux posés au sol ou muraux restent en place. Lyres sur la moitié lointaine des structures, projecteurs fixes sur la moitié proche ; avec une seule structure, tous la partagent. Répartition régulière sur le contour (droites, cercles, carrés), accroche `trussId`. Nouvelle commande `fixture.place` : une seule étape d'annulation. Modèle + Équiper = 2 clics.
- Bouton « Équiper » sur un modèle appliqué : répartit régulièrement les projecteurs du patch (ou d'un groupe) sur les structures du modèle, lyres en contre et PAR en face, avec accroche `trussId`.
- **Critère** : une scène « Concert » éclairée et accrochée en moins de 30 s et 3 clics depuis un projet vide patché.

#### 1.2 Poser au clic · S
> **Livré (17/10/2026)** : bouton « Poser au clic » à côté de chaque « + Ajouter », bandeau d'aide et curseur en croix ; en 3D, l'élément est posé là où le rayon touche le sol. Échap annule la pose sans relâcher le programmeur. Sans clic, chaque ajout se décale de 1 m (0, +1, −1, +2…) au lieu de s'empiler. L'élément créé est sélectionné.
- Choisir un type (point, interprète, structure, écran) puis cliquer sur le plateau, en 2D ou en 3D (raycast sur le sol), pour le poser à cet endroit.
- Sans clic, un nouvel élément est décalé par rapport au précédent au lieu d'être posé au même point.

#### 1.3 Dupliquer et supprimer au clavier · S
> **Livré (17/10/2026)** : sélection de scène partagée : carte du panneau, clic sur un élément en 2D, ou structure en 3D. La carte sélectionnée est surlignée et ramenée à l'écran, et l'élément est entouré en violet sur le plan. Ctrl+D duplique l'élément (copie décalée de 1 m, interprète libéré de son point) ; sans élément sélectionné, Ctrl+D duplique les projecteurs sélectionnés à la prochaine adresse libre (`fixture.duplicate`). Suppr supprime l'élément ; un interprète posé sur un point supprimé reste à sa place. Ctrl+C / Ctrl+V passent par le presse-papiers système (texte `luma-scene:`, validé par les schémas du projet), donc fonctionnent d'un projet à l'autre. **Écart** : Suppr ne supprime pas les projecteurs, car leur retrait du patch n'est pas annulable par l'historique de scène.
- Ctrl+D duplique la sélection avec un décalage de 1 m ; Suppr supprime (avec annulation).
- Copier / coller d'éléments de scène entre projets.

#### 1.4 Modèles personnels · S
- « Enregistrer comme modèle » : la scène courante (sans projecteurs) devient un modèle réutilisable, stocké dans les réglages utilisateur et exportable en fichier.

#### 1.5 Bibliothèque d'éléments · M
> **Livré (17/10/2026)** : section « Bibliothèque » du panneau, en 4 onglets.
> - **Structures** : droites 0,5 / 1 / 2 / 3 / 4 m, angle 90°, té, croix, totems 1 / 2 / 3 m, cercle Ø 4 m, carré 3 m, pont sur pieds 8 m.
> - **Décor** : praticables 2 × 1 et 2 × 2 m, escalier, enceinte, retour, pied de micro, table / régie DJ, pendrillon, cube, colonne.
> - **Artistes**, et **Vidéo et repères** (écran 16:9, mur LED, point de scène).
>
> Pour poser une pièce : cliquer la tuile puis le plateau, ou glisser la tuile sur la vue 2D ou 3D (point d'impact sur le sol). Chaque tuile a un petit dessin vu de dessus.
>
> - **Nouveaux types de structure** : `corner`, `tee`, `cross` (bras mesurés depuis le nœud) et `totem` (tour verticale du sol à sa hauteur). Nouveau support « Posée (assemblage) » : ni pieds ni moteurs.
> - **Aimantation bout à bout** (35 cm) à la pose, au glisser 2D et au gizmo 3D : la pièce rejoint l'extrémité la plus proche et prend sa hauteur (une droite sur un totem se pose à son sommet).
> - **Décor** : nouveau tableau `visualizer.props` avec type, dimensions, élévation (empilement), rotation et couleur. Rendu 3D par type, avec ombres en mode éclairage réel. Section « Décor » dans le panneau.
> - **Déplacement libre** : en 2D (mode Positionner) pour les structures, le décor et les écrans ; en 3D au gizmo (mode Éditer) pour les structures et le décor (la hauteur du gizmo règle l'élévation du décor). Le panneau 3D de sélection propose Dupliquer et Supprimer.
> - **Une seule sélection active** : sélectionner des projecteurs désélectionne l'élément de scène, et inversement.
>
> **Projecteurs seuls** : ajouter des projecteurs au patch n'ajoute plus de truss en 3D. Les « truss implicites », dessinées pour chaque rangée de projecteurs suspendus non accrochés, sont retirées ; seules les structures posées par l'utilisateur apparaissent.
>
> Les anciens projets s'ouvrent avec `props: []`. Le modèle « Concert » reçoit enceintes, retour et pied de micro.
>
> **Complété (17/10/2026)** : les faisceaux s'arrêtent sur le décor et la tache se dessine sur la face touchée (`beamHit`, boîte englobante de chaque pièce) ; un interprète posé sur un praticable, un escalier, un cube ou une table monte à son sommet (rendu 3D et éclairement estimé) ; un projecteur s'accroche sur la face avant d'un totem, juste sous le sommet, y compris avec « Équiper les structures » (projecteurs empilés tous les 50 cm).

### Étape 2 — Une seule façon d'éditer (priorité haute)

#### 2.1 Tous les objets sélectionnables en 3D · M
- Points, interprètes et écrans reçoivent le même gizmo que projecteurs et structures (déplacer, pivoter, grille, cotes).
- Un interprète lâché près d'un point s'y pose, comme en 2D.

#### 2.2 Inspecteur unifié · M
- Le panneau latéral gagne un onglet **Sélection** qui remplace les panneaux flottants (projecteur, structure) : mêmes cartes, mêmes champs.
- Cliquer une carte sélectionne l'objet dans la vue (et cadre la caméra au double-clic) ; sélectionner dans la vue fait défiler la liste jusqu'à la carte et la met en surbrillance.

#### 2.3 Menu contextuel · S
- Clic droit sur un objet en mode Éditer : Dupliquer, Supprimer, Accrocher à…, Centrer la vue, Vue projecteur. Le déplacement de caméra au clic droit reste disponible hors édition.

### Étape 3 — Lisibilité et confort (priorité moyenne)

#### 3.1 Préréglages de rendu · S
- En tête du menu Rendu : **Rapide / Équilibré / Qualité** (bloom, taches, ombres, sol réfléchissant), les réglages fins restant en dessous. Choix automatique selon les i/s mesurés au premier affichage.

#### 3.2 Raccourcis clavier affichés · S
- 1–5 : caméras ; E : Éditer ; G : grille ; T / R : déplacer / pivoter ; F : cadrer la sélection ; ? : aide des raccourcis.
- Les raccourcis passent par `src/renderer/shortcuts.ts` pour rester personnalisables.

#### 3.3 Mini-plan dans la vue 3D · S
- Petit plan de dessus (rendu par `StageCanvas` en mode compact) dans un coin, avec le cône de la caméra ; un clic dessus déplace la caméra.

#### 3.4 Petits écrans · S
- Sous 1100 px, le panneau devient un tiroir par-dessus la vue ; la barre d'outils se réduit aux icônes avec infobulles.

#### 3.5 Assistant premier lancement · M
- Sur un projet neuf : dimensions → forme → modèle → patch → équipement (1.1), avec saut possible à chaque étape. Réutilise `Onboarding.tsx`.

### Étape 4 — Présentation (priorité basse)

#### 4.1 Mode présentation · S
- Touche P : masque toute l'interface ; dans la fenêtre détachée, une mini-barre (caméras, plein écran) apparaît quand la souris bouge.

#### 4.2 Transitions de caméra pilotées · M
- Enchaîner les vues enregistrées sur la timeline ou au déclenchement d'une cue, pour les captures vidéo et les présentations client.

---

## 4. Ordre conseillé

| Étape | Contenu | Pourquoi |
|---|---|---|
| 1 | 1.1, 1.2, 1.3 | Gain immédiat sur le temps de création, peu de code (modèle et actions existants) |
| 2 | 2.1, 2.2, 2.3 | Une seule façon d'éditer ; prérequis du décor et des praticables (fonctionnalité 1 de roadmap-scene) |
| 3 | 3.1, 3.2, 3.3, 1.4, 3.4 | Confort quotidien, une fois l'édition stabilisée |
| 4 | 3.5, 4.1, 4.2 | L'assistant réutilise tout ce qui précède |

## 5. Principes
- **Une action, un endroit** : tout ce qui construit la scène va dans le panneau latéral ; la barre d'outils sert à regarder (caméras, rendu, captures).
- **La vue reste visible** pendant l'édition : aucun panneau ne la repousse.
- **Tout s'annule** : chaque modification de scène passe par `project.update` (historique de scène, Ctrl+Z).
- **Valeurs lisibles** : unités et libellés en clair dans les champs ; abréviations seulement dans les infobulles.
- **Testable hors rendu** : modèles, placements automatiques et équipement vivent dans `core/visualizer`, avec un test unitaire.
- **Compatibilité e2e** : les `data-testid` existants sont conservés ; le scénario e2e ouvre le menu Rendu avant d'utiliser ses réglages.
