# Architecture

```
src/
  shared/      brand.ts, commands.ts (contrat IPC Zod + types de résultats), api.ts (types du pont preload)
  core/        logique métier SANS Electron ni React (testable sous Node)
    model/       schémas Zod du domaine (profils, patch, scènes, cues, effets, timeline, projet)
    fixtures/    attributs (+ cellules « red#3 »), profils, profils fictifs, patch, couleur, ofl (import Open Fixture Library)
    engine/      Engine (tick), merge (priorités), render (DMX 8/16 bits, fonctions spéciales, blackout),
                 playback (cue lists), effects, timeline, resolve (index du projet)
    protocols/   config (schémas), types (OutputAdapter : état, stats, reconnexion), artnet, sacn, enttec, opendmx, rdm (E1.20 via Art-Net),
                 virtual, OutputManager (armement, STOP, cadence, état transmis)
    ai/          actions (schéma strict), director (validation, aperçu, exécution, vérification),
                 local/interpreter (mode déterministe), providers/openrouter (API compatible OpenAI, fetch)
    audio/       analyzer (niveau, énergie, attaques, BPM, montées d'énergie), reactive (réactions → moteur)
    safety/      flashGuard (estimation des flashs photosensibles, limiteur du moteur, refus des effets IA dangereux)
    control/     midi (messages, MTC), timecode (décodeur LTC), osc (UDP), remote (télécommande HTTP + SSE)
    vision/      geometry (caméra sténopé, calibration homographie + Levenberg–Marquardt, triangulation),
                 image (taches lumineuses), locate (séquences codées, décodage, positions, erreurs de patch, RDM)
    demo/        catalog (10 projets fictifs décrits en données), projects (génération validée par projectSchema)
    music/       dsp (FFT, bandes, chroma), analyze (tempo, battements, premiers temps, structure, tonalité, événements),
                 tempoTracker (tempo live), dropPredictor (drop / refrain), songToShow (plan + compilateur)
    project/     format (création, versions, migrations), store (écriture atomique, .bak, récupération)
    settings/    paramètres applicatifs ; log/ journal en mémoire ; visualizer/ modèle visuel 2D/3D
    app/         AppService : orchestration + bus de commandes (injection des dialogues et secrets)
  main/        Electron : fenêtre sécurisée, IPC validé, secrets chiffrés (safeStorage)
  preload/     contextBridge : { invoke, on }
  renderer/    React + Zustand : App (shell), features/* (12 espaces, Stage3D three.js), audioEngine (Web Audio), shortcuts
tests/         unit, integration (parcours complet), components (Testing Library), e2e (Playwright + Electron)
```

## Flux de données
1. Le renderer envoie une commande typée `window.luma.invoke({ type, ... })`.
2. Le processus principal vérifie l'origine, valide la commande avec `commandSchema` (Zod), puis appelle `AppService.execute`.
3. Les mutations de projet sont appliquées à une copie, **revalidées entièrement** avec `projectSchema`, puis remplacent le document. Les mutations invalides sont refusées sans effet de bord. L'index du projet est reconstruit et transmis au moteur.
4. Le moteur tourne dans le processus principal. Ordonnanceur à échéances : `setTimeout` jusqu'à l'échéance moins le retard maximal des timers observé sur les 64 derniers réveils, puis `setImmediate` (les E/S et l'IPC passent entre deux itérations) jusqu'à l'échéance. Un retard inférieur à une période est absorbé ; au-delà, resynchronisation sans rafale de rattrapage. À chaque tick :
   - avancement des playbacks, des effets et de la timeline ;
   - fusion des sources ;
   - complément par les valeurs par défaut, puis virtual dimmer, master et blackout ;
   - rendu en DMX ;
   - remise des trames à l'`OutputManager`.
5. Événements vers le renderer : `values` (≈ 25 Hz, sources ≈ 5 Hz), `runtime` (≈ 10 Hz), `project` (à chaque modification), `log`.

Trois états distincts sont exposés :
- **état demandé** : programmeur, couches, cues ;
- **état calculé** : `engine.values` / `engine.universes` ;
- **état transmis** : `OutputManager.transmitted`, la dernière trame remise au transport, avec son horodatage.

Aucun élément de l'interface ne présente l'état calculé comme une preuve de réception par le projecteur.

## Politique de priorité et de fusion (`core/engine/merge.ts`)
| Source | Priorité par défaut | Réglage |
|---|---|---|
| Manuel (programmeur) | toujours gagnant | — |
| Couche IA | 60 | Settings › Moteur |
| Audio réactif | 55 | Settings › Moteur |
| Listes de cues | 50 | propriétés de la liste |
| Effets | 50 | paramètres de l'effet |
| Timeline | 40 | Settings › Moteur |

- Couches de base (cues, IA, timeline, audio) regroupées par priorité. **Dans une même priorité** : intensité en HTP, autres attributs en LTP (activation la plus récente). Une **priorité supérieure remplace** la valeur d'une priorité inférieure.
- Effets : appliqués ensuite. Un effet ne touche un attribut que si son propriétaire actuel a une priorité inférieure ou égale. Mode `override` = remplace ; mode `scale` = multiplie.
- Programmeur : écrase tout. Le relâcher rend immédiatement la main aux autres sources.
- Attributs non contrôlés : valeur par défaut du profil (par exemple shutter « ouvert », pan/tilt au centre).

## Intelligence musicale (`core/music`)
- **Analyse de fichier** (renderer, tranches asynchrones) : trames de 93 ms, saut de 23 ms. Tempo par peigne d'autocorrélation du flux spectral, avec un a priori sur la plage du genre. Battements par programmation dynamique (Ellis). Premiers temps par accents de basse et changements harmoniques. Structure par matrice d'auto-similarité par mesure et noyau en damier, avec frontières calées sur les phrases de 4 mesures. Étiquettes par répétitions (vecteurs centrés : harmonie, timbre, énergie) et règles d'énergie. Tonalité par Krumhansl–Schmuckler.
- **Tempo live** : enveloppe d'attaques rééchantillonnée à 50 Hz (8 s). La grosse caisse définit le temps : une candidate qui a une attaque forte à sa demi-période est pénalisée. Kalman avec confirmation des changements (3 estimations concordantes). Pendant un breakdown sans basse, le tempo et la grille continuent sur leur lancée. Le recalage de phase est progressif.
- **Song-to-Show** : le planificateur (règles locales, ou OpenRouter revalidé par `showSectionPlanSchema`) produit un plan typé par section. Le compilateur déterministe le traduit en scènes, en effets synchronisés au BPM et calés sur la mesure (`barSync`), et en timeline (fondus enchaînés grâce à `fadeOut`, accents sur les impacts). Chaque effet est contrôlé par le garde-fou photosensible.

## Moteur d'effets
Les effets sont des fonctions pures de la phase (`computeEffect`). Les instances intègrent leur phase dans le tick : aucun timer par effet, pas de travail sur le thread de l'interface. L'aléatoire utilise un hachage déterministe (`hash01(seed, cycle, fixture)`), ce qui donne des résultats reproductibles. Le strobe est plafonné par `maxStrobeHz`.

## Visualiseurs 2D et 3D
`core/visualizer/model.ts` produit des `VisualFixture` : position et hauteur en mètres, pan/tilt en degrés, angle de faisceau, couleur, intensité, couleurs des cellules. Le modèle inclut aussi l'accroche (au sol sous 1 m), la fréquence de strobe estimée, le gobo actif, le prisme et l'angle zoomé. Le canvas 2D et la vue 3D consomment ce même modèle.

La vue 3D (`renderer/features/Stage3D.tsx` + `renderer/features/stage3d/`) se compose de :
- `core/visualizer/beam.ts` : géométrie pure et testée (direction, impact sol/cyclorama, forme et atténuation des taches, flashs de strobe) ;
- `stage3d/rig.ts` : modèles articulés (racine → lyre (pan) → tête (tilt) → lentille) et shader de faisceau volumétrique (bords adoucis selon l'angle de vue, cœur lumineux, atténuation le long du faisceau, mélange additif) ;
- `stage3d/environment.ts` : plateau, cyclorama, coulisses, salle, truss en treillis générés par rangée de projecteurs accrochés ;
- `stage3d/textures.ts` : tache de lumière et gobos procéduraux.

Le post-traitement glow (bloom) passe par l'EffectComposer de three.js. Les objets ne sont reconstruits que si la structure d'un projecteur change ; tout le reste est mis à jour à chaque image. Ce n'est pas une simulation photométrique : pas d'ombres ni de transport réel de la lumière.

## Projecteurs multi-cellules
Un canal de profil peut porter `cell: n`. Sa valeur est alors stockée sous la clé `attribut#n` (par exemple `red#3`). La fusion, le rendu DMX, le virtual dimmer et le blackout utilisent ces clés. `colorToAttributes` applique une couleur à toutes les cellules ou à une seule. Rainbow et Color cycle traitent chaque cellule comme un élément de la répartition de phase.

## Import Open Fixture Library
`core/fixtures/ofl.ts` convertit le format OFL (licence MIT, vérifiée) : canaux disponibles, alias fins (16 bits), capacités → attributs, roues (couleurs et gobos), canaux modèles et `matrixChannels` (pixels → cellules), `Maintenance` → plages marquées dangereuses. Le catalogue en ligne lit `manufacturers.json` et les fichiers bruts du dépôt GitHub d'OFL.

## Choix techniques
- **Protocoles implémentés en interne** (dgram) plutôt qu'avec des bibliothèques tierces : Art-Net (ArtDmx) et E1.31 (paquet de données) tiennent en environ 100 lignes chacun, dont les octets sont testés contre les offsets des spécifications. Cela évite des dépendances peu maintenues.
- **Moteur dans le processus principal**, sans worker (décision réexaminée en Phase 0 : tout `AppService` lit l'état du moteur de façon synchrone ; le problème mesuré était la cadence, corrigé par l'ordonnanceur) : la charge mesurée est d'environ 0,25 ms par tick pour quelques projecteurs. Le test de charge (1 000 projecteurs, 12 univers, 3 effets) a mesuré ≈ 7,4 ms par tick sur la machine de développement, soit ≈ 30 % de la période de 25 ms. Au-delà de quelques milliers de projecteurs, un worker ou une optimisation de la fusion deviendrait nécessaire. Un worker ajouterait de la sérialisation sans gain démontré.
- **Pas de base de données** : un projet est un fichier JSON versionné, lisible et exportable.

## Dépendances
| Paquet | Raison |
|---|---|
| electron, electron-vite, vite, @vitejs/plugin-react | application desktop, build main/preload/renderer |
| react, react-dom | interface |
| zustand | état partagé du renderer |
| zod | validation aux frontières (IPC, fichiers, IA, paramètres) |
| lucide-react | jeu d'icônes uniforme |
| serialport | accès série : Enttec DMX USB Pro et Open DMX (module natif N-API, chargé dynamiquement) |
| three, @types/three | visualiseur 3D |
| (aucune) | OpenRouter et OFL passent par le `fetch` natif de Node : pas de SDK |
| vitest, jsdom, @testing-library/* | tests unitaires, d'intégration et de composants |
| @playwright/test | tests end-to-end sur l'application Electron |
| eslint, typescript-eslint, eslint-plugin-react-hooks | lint |
| electron-builder | packaging |
