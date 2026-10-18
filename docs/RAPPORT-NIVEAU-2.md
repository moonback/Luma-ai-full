# Rapport d'amélioration — passer Luma AI DMX au niveau 2

> Rédigé le 18/10/2026 à partir du dépôt (branche `feat/scene-lot2`, commit `5998174` + 2 fichiers modifiés non commités).
> Les roadmaps existantes (`ROADMAP.md`, `roadmap-scene.md`, `roadmap-stage3d.md`, `roadmap-fixture.md`) décrivent **quoi construire**. Ce rapport traite de **comment le construire et le livrer** : passer d'un prototype riche, développé seul et vite, à un logiciel qu'on peut confier à un éclairagiste sur un vrai plateau.

## 1. Diagnostic

### Mesures du jour
| Vérification | Résultat |
|---|---|
| `npm run typecheck` | ✅ propre |
| `npm run lint` | ❌ **1 erreur** commitée : `attributeSchema` importé mais inutilisé (`src/shared/commands.ts:3`) |
| `vitest run` | ✅ 21 fichiers, **212 tests**, 24 s |
| Taille | ≈ 20 000 lignes dans `src/`, 28 commits les 17 et 18/10 |
| CI | ❌ aucune (pas de `.github/`) |
| Couverture | non mesurée (aucun outil configuré) |

L'erreur de lint est le meilleur argument du rapport : `npm run check` existe, mais rien n'oblige à le lancer avant de commiter.

### Points forts (à garder)
| Domaine | Constat |
|---|---|
| Architecture | `core/` sans Electron ni React, testable sous Node ; main et renderer séparés ; contrat IPC unique validé par Zod (`src/shared/commands.ts`, 82 commandes). |
| Sécurité Electron | `contextIsolation`, `sandbox`, `nodeIntegration: false`, CSP stricte, navigation et `window.open` bloqués, permissions en liste blanche, secrets via `safeStorage`. Bien au-dessus de la moyenne. |
| Robustesse des données | Mutations appliquées à une copie puis revalidées par `projectSchema`, écriture atomique, `.bak`, autosave toutes les 15 s, récupération. |
| IA encadrée | L'IA ne parle jamais DMX : actions typées, validation, aperçu, rapport vérifié, flash guard, banc d'évaluation. Le plan LLM est réparé section par section au lieu d'être rejeté. |
| Qualité locale | TypeScript strict (`noUncheckedIndexedAccess`), ESLint, tests unitaires + intégration + perf + e2e Playwright. |
| Périmètre fonctionnel | Moteur 40–44 Hz, 5 protocoles, RDM, MIDI/OSC/LTC, télécommande, song-to-show, vision, 3D, onboarding, 10 démos. |

### Ce qui bloque le niveau 2
On produit des fonctionnalités beaucoup plus vite qu'on ne peut les **vérifier sur le terrain** et les **maintenir**. Six freins principaux :

1. **Aucune validation matérielle.** Aucun projecteur, aucune interface DMX réelle testée. Tout le reste en dépend.
2. **Aucune intégration continue.** La qualité repose sur l'exécution manuelle de `npm run check`, et la preuve est là : une erreur de lint est déjà commitée.
3. **Historique git inexploitable.** 7 commits « up », d'autres dont le message est un compte rendu de conversation (« 4 améliorations retenues par l'utilisateur… »). Impossible de bisecter, de rédiger un changelog ou d'annuler une fonctionnalité.
4. **Fichiers-dieux.** `AppService.ts` (1 366 lignes, ≈ 108 branches de commande), `Visualizer.tsx` (1 049 lignes), `Stage3D.tsx` (763 lignes). Chaque nouvelle fonctionnalité les fait grossir.
5. **Exploitation à l'aveugle.** Le journal (`core/log`) n'existe qu'en mémoire : après un plantage en plein show, il ne reste aucune trace. Pas de rapport de crash, pas de mise à jour automatique, pas de signature de code.
6. **Renderer presque pas testé.** Un seul test de composant (`tests/components/console.test.tsx`) pour 12 espaces de travail, et un seul fichier e2e.

---

## 2. Plan d'action priorisé

Légende effort : **S** ≤ 2 jours · **M** ≤ 1 semaine · **L** > 1 semaine.

### P0 — Fondations (avant toute nouvelle fonctionnalité)

| # | Action | Pourquoi | Effort | Critère de fin |
|---|---|---|---|---|
| 1 | **CI GitHub Actions** sur `windows-latest` : `npm ci`, `typecheck`, `lint`, `test`, puis `test:e2e` et `package:dir` | Le seul garde-fou actuel est la discipline manuelle | S | Toute PR vers `master` est bloquée si un job échoue |
| 2 | **Discipline git** : une branche par fonctionnalité ; des commits petits au format Conventional Commits (déjà utilisé sur une partie de l'historique : `feat(scene): …`) ; des PR, même en solo ; un `CHANGELOG.md` | Bisect, revue, retour arrière, notes de version | S | Plus aucun commit « up » ; changelog à chaque version |
| 3 | **Campagne matérielle minimale** (`docs/HARDWARE.md`, roadmap 0.1) : 1 nœud Art-Net ou sACN, 1 Enttec Pro, 1 PAR RGBW, 1 lyre 16 bits | Risque n° 1 : aucune fonctionnalité IA n'a de valeur si la trame est fausse | M | Testeur DMX : valeurs reçues = valeurs envoyées sur 100 % des canaux ; 8 h sans perte ; reconnexion < 10 s |
| 4 | **Journal persistant + diagnostic** : fichier tournant dans `userData/logs` ; `crashReporter` local ; `uncaughtException` et `unhandledRejection` journalisés ; bouton « Exporter un diagnostic » (logs + réglages sans secrets + version) | Un utilisateur qui plante en show doit pouvoir vous envoyer quelque chose | S | Un plantage forcé laisse un fichier exploitable |
| 5 | **Télécommande durcie** : aujourd'hui, elle écoute sur `0.0.0.0` en HTTP, avec le jeton dans l'URL (`?t=`). Choisir l'interface d'écoute, régénérer le jeton à la demande, limiter le débit, rappeler dans l'UI que le réseau doit être privé | Le jeton circule en clair et reste dans l'historique du téléphone | S | Interface choisie, bouton « nouveau jeton », test de refus |

### P1 — Maintenabilité (pour pouvoir continuer à aller vite)

| # | Action | Pourquoi | Effort | Critère de fin |
|---|---|---|---|---|
| 6 | **Découper `AppService`** par domaine (`project`, `patch`, `playback`, `ai`, `music`, `vision`, `control`, `output`) : un module de handlers par domaine ; `AppService` ne garde que l'état partagé et le bus `execute` | Un fichier de 1 366 lignes, ce sont des conflits, une revue impossible et des tests lourds | M | Aucun fichier de `core/app` > 400 lignes ; comportement inchangé (tests verts) |
| 7 | **Découper `Visualizer.tsx` et `Stage3D.tsx`** : panneau « Construire la scène », barre d'outils, inspecteur et vue en composants séparés ; la logique pure va dans `core/visualizer` (déjà amorcé avec `sceneEdit.ts`) | Ce sont les zones qui changent le plus en ce moment | M | Composants < 400 lignes ; logique d'édition testée sans DOM |
| 8 | **Couverture mesurée** : `@vitest/coverage-v8`, seuils sur `src/core` (par ex. 80 % des lignes) en CI | On ne sait pas ce qui est couvert | S | Rapport publié par la CI ; seuil bloquant sur `core` |
| 9 | **Tests du renderer** : 1 test de composant par espace critique (Live Console, Cues, Fixtures, Output, AI Director) et un e2e pour chacun des 5 parcours clés : <br>• patch → scène → cue → GO <br>• import d'un morceau → génération <br>• IA → appliquer <br>• sortie armée → STOP <br>• ouverture d'une démo | Les régressions d'UI ne se voient aujourd'hui qu'à la main | M | 5 parcours e2e verts en CI |
| 10 | **Documentation rangée** : déplacer les roadmaps de la racine dans `docs/roadmap/` ; écrire de courtes ADR (`docs/adr/`) pour les décisions déjà prises (moteur hors worker, IA sans DMX, priorités de fusion) | La racine du dépôt devient un brouillon ; les décisions se perdent | S | Racine = README, ROADMAP, config ; une ADR par choix structurant |

### P2 — Produit « niveau 2 » (livrable à de vrais utilisateurs)

| # | Action | Pourquoi | Effort |
|---|---|---|---|
| 11 | **Distribution** : signature de code Windows, `electron-updater` avec canal bêta, vrai numéro de version (le projet est en `0.1.0` depuis le début) | SmartScreen bloque les binaires non signés ; sans mise à jour automatique, les correctifs n'arrivent pas chez les utilisateurs | M |
| 12 | **Programme bêta** : 3 à 5 éclairagistes (club, théâtre, événementiel) ; un formulaire de retour intégré ; une télémétrie **opt-in**, locale d'abord (fonctions utilisées, erreurs, jamais le contenu des projets) | Les roadmaps sont écrites sans retour terrain, donc leurs priorités aussi | M |
| 13 | **Évaluation IA à l'échelle** : passer le banc de 32 à ≥ 150 cas (objectif de la roadmap : 300) ; y inclure le LLM distant avec des réponses enregistrées, et le corpus de 50 titres annotés pour song-to-show | Chaque amélioration de l'IA doit être prouvée, pas ressentie | M |
| 14 | **Contrat d'actions IA versionné** (roadmap 11.2), avant d'ajouter de nouvelles actions | Un projet enregistré ou un plan LLM ne doit pas casser à la version suivante | S |
| 15 | **Interopérabilité** : import GDTF et grandMA2 XML (déjà amorcé avec `ma2.ts`), export MVR, feuille de patch PDF/CSV | C'est ce qui permet d'intégrer l'outil dans un flux de travail pro | L |
| 16 | **macOS / Linux** : à construire en CI une fois Windows stable ; sinon retirer ces cibles de `electron-builder.yml` pour ne rien promettre | Cibles configurées mais jamais construites | S |
| 17 | **Internationalisation** : l'UI est écrite en dur, en français. Extraire les textes dans un catalogue (un objet par langue suffit) avant que les écrans se multiplient | Le marché de l'éclairage est international, et l'extraction coûte plus cher à chaque nouvel écran | M |

### Ce qu'il ne faut volontairement **pas** faire maintenant
- **Pas de nouvelle grande fonctionnalité IA** (copilote, commande vocale, suivi d'artiste) avant P0 n° 3 : sans validation matérielle, on empile des promesses invérifiables.
- **Pas de passage du moteur dans un worker** tant que la charge ne l'exige pas : la roadmap a déjà tranché, mesures à l'appui (40/44 Hz ± 0,5 Hz).
- **Pas de réécriture** : l'architecture `core / main / renderer` est saine ; il faut découper, pas refaire.

---

## 3. Calendrier proposé (développeur seul, à temps plein)

| Semaine | Contenu | Livrable |
|---|---|---|
| S1 | P0 n° 1, 2, 4, 5 | CI verte, journal persistant, télécommande durcie, première version taguée `v0.2.0` avec changelog |
| S2–S3 | P0 n° 3 (matériel) + correctifs qu'elle révèle | Rapport de campagne dans `docs/HARDWARE.md` |
| S4–S5 | P1 n° 6 à 10 | `AppService` et visualiseur découpés, couverture mesurée, 5 parcours e2e |
| S6–S8 | P2 n° 11 à 14 | Installateur signé avec mise à jour automatique, bêta ouverte à 3–5 utilisateurs |
| Ensuite | P2 n° 15 à 17, puis la roadmap produit (Phase 2) guidée par les retours bêta | — |

## 4. Critères du niveau 2
Le niveau 2 est atteint quand **tous** ces points sont vrais :
- [ ] CI bloquante sur chaque PR ; couverture de `core` ≥ 80 %.
- [ ] Validation matérielle documentée sur au moins 2 interfaces et 3 types de projecteurs.
- [ ] Un plantage produit un diagnostic exportable.
- [ ] Installateur signé, mise à jour automatique fonctionnelle.
- [ ] Au moins 3 utilisateurs externes ont fait un vrai show (ou une vraie répétition) avec l'application.
- [ ] Aucun fichier source de plus de 600 lignes.
- [ ] Banc d'évaluation IA ≥ 150 cas, 0 violation de sécurité.
