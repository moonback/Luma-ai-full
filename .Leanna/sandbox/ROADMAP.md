# Roadmap — Luma AI DMX

> Document de pilotage produit et technique. Rédigé le 17/10/2026 à partir de l'état du dépôt (commit `8c2a393` + travaux en cours : vue 3D détachable).
> Les durées sont des **estimations** pour un développeur à temps plein ; elles servent à ordonner, pas à promettre.

## Sommaire
1. [Vision](#1-vision)
2. [État actuel (audit)](#2-état-actuel-audit)
3. [Principes non négociables](#3-principes-non-négociables)
4. [Vue d'ensemble des phases](#4-vue-densemble-des-phases)
5. [Phase 0 — Fiabilisation terrain](#phase-0--fiabilisation-terrain-t4-2026)
6. [Phase 1 — Intelligence musicale](#phase-1--intelligence-musicale-t1-2027)
7. [Phase 2 — Copilote live et contrôle vocal](#phase-2--copilote-live-et-contrôle-vocal-t2-2027)
8. [Phase 3 — Vision par ordinateur et calibration automatique](#phase-3--vision-par-ordinateur-et-calibration-automatique-t3-2027)
9. [Phase 4 — Design assisté et apprentissage du style](#phase-4--design-assisté-et-apprentissage-du-style-t4-2027)
10. [Phase 5 — Maintenance prédictive et exploitation](#phase-5--maintenance-prédictive-et-exploitation-2028)
11. [Chantiers transverses](#11-chantiers-transverses)
12. [Évaluation de l'IA](#12-évaluation-de-lia)
13. [Indicateurs de succès](#13-indicateurs-de-succès)
14. [Risques et parades](#14-risques-et-parades)
15. [Backlog et idées non planifiées](#15-backlog-et-idées-non-planifiées)

---

## 1. Vision

Faire de Luma AI DMX **la console d'éclairage qui comprend la musique, la scène et l'intention du concepteur**, tout en restant une console fiable que l'on peut piloter entièrement à la main.

L'IA n'est pas un gadget de génération de looks : elle doit **faire gagner du temps sur les tâches techniques pénibles** (patch, focus, calibration, programmation sur un morceau, dépannage) et **assister l'opérateur en live** sans jamais lui retirer la main.

Trois promesses :
- **Préparer un show en minutes** : patch automatique, focus automatique par caméra, programmation d'un morceau à partir de son analyse.
- **Jouer en live sans filet invisible** : copilote qui anticipe (drops, refrains), propose, et n'agit qu'avec l'accord de l'opérateur ou dans un cadre qu'il a fixé.
- **Ne jamais mettre le public en danger** : garde-fous photosensibles, strobe plafonné, fonctions dangereuses verrouillées, IA sans accès direct au DMX.

---

## 2. État actuel (audit)

### Ce qui existe et fonctionne
| Domaine | Modules | État |
|---|---|---|
| Moteur DMX | `core/engine/*` (Engine, merge HTP/LTP par priorités, render 8/16 bits, playback, effets, timeline) | Fonctionnel, ≈ 40 Hz, test de charge 1 000 projecteurs ≈ 7,4 ms/tick |
| Sorties | `core/protocols/*` (Art-Net, sACN, Enttec Pro, Open DMX, virtuelle, OutputManager) | Testées en boucle locale, **jamais sur matériel** |
| Projecteurs | `core/fixtures/*` (profils, cellules multi-pixels, import OFL) | Fonctionnel, conversion OFL à vérifier au cas par cas |
| IA | `core/ai/actions.ts` (11 actions typées), `director.ts` (validation, aperçu, exécution, vérification), `local/interpreter.ts` (règles FR/EN), `providers/openrouter.ts` | Fonctionnel ; OpenRouter testé avec réponses simulées uniquement |
| Audio | `core/audio/analyzer.ts`, `reactive.ts`, `renderer/audioEngine.ts` | Niveau, énergie, attaques, BPM (erreur ×2 possible), montées d'énergie ; **pas** de refrains ni de drops |
| Visualisation | `core/visualizer/*`, `renderer/features/Stage3D.tsx`, `stage3d/*` | 2D + 3D three.js (faisceaux volumétriques, gobos, lyres articulées, 5 caméras), fenêtre 3D détachable |
| Application | `core/app/AppService.ts`, IPC Zod, secrets `safeStorage`, projet JSON versionné | Solide, sécurité Electron stricte |
| Tests | unit, intégration, composants, e2e Playwright | 92 tests unitaires + 7 e2e au vert |

### Lacunes identifiées
1. **Aucune validation matérielle** : c'est le risque n° 1 avant toute fonctionnalité IA.
2. **Pas de RDM**, pas d'entrée timecode (LTC/MTC), pas de MIDI/OSC, pas de surface de contrôle physique.
3. **Audio superficiel** : pas d'analyse de structure, pas de grille de temps (downbeats), pas d'analyse de fichier hors ligne.
4. **IA réactive uniquement** : elle répond à une demande, elle n'anticipe rien et n'apprend rien de l'opérateur.
5. **Positions de scène saisies à la main**, pas de notion de « point focus » en 3D.
6. **Moteur mono-thread dans le main** : suffisant aujourd'hui, limite au-delà de quelques milliers de projecteurs.
7. **Pas d'évaluation quantitative de l'IA** (jeu de prompts de référence, métriques de régression).
8. Visualiseur non photométrique (ni ombres, ni atténuation réelle) — acceptable, à documenter.

---

## 3. Principes non négociables

Ces règles s'appliquent à **toutes** les fonctionnalités ci-dessous. Une fonctionnalité qui ne peut pas les respecter n'est pas livrée.

1. **L'IA ne parle jamais DMX.** Elle produit des actions typées, validées par Zod puis par `director.ts`. Toute nouvelle capacité IA = nouvelles actions typées, jamais un accès aux canaux bruts.
2. **Le manuel gagne toujours.** Programmeur > tout. `Échap` relâche, `Maj+Échap` coupe la sortie, quel que soit l'état de l'IA.
3. **Aperçu avant application** pour toute action non triviale, avec rapport d'exécution vérifié sur l'état calculé.
4. **Modes autonomes bornés** : quand l'IA agit seule (copilote en mode auto), c'est dans une enveloppe définie par l'opérateur (groupes autorisés, attributs autorisés, intensité max, strobe interdit par défaut) et avec un bouton « reprendre la main » toujours visible.
5. **Local d'abord.** Toute fonction IA a un mode dégradé hors ligne. Le réseau est une option, jamais une dépendance en live.
6. **Transparence** : l'interface dit toujours qui contrôle quoi (manuel, cue, IA, audio), en mode local ou distant, et quelles données partent sur le réseau.
7. **Mesuré, pas supposé** : chaque promesse de performance a un test ou une métrique affichée.

---

## 4. Vue d'ensemble des phases

| Phase | Période cible | Thème | Fonctionnalités IA phares |
|---|---|---|---|
| 0 | T4 2026 | Fiabilisation terrain | Garde-fou photosensible, banc d'évaluation IA |
| 1 | T1 2027 | Intelligence musicale | Analyse de structure, auto-programmation d'un morceau, prédiction de drop |
| 2 | T2 2027 | Copilote live | Copilote anticipatif, commande vocale locale, busking assisté |
| 3 | T3 2027 | Vision | Auto-localisation des projecteurs par caméra, auto-focus, suivi d'artiste |
| 4 | T4 2027 | Design assisté | Moodboard → looks, apprentissage du style, auto-critique visuelle |
| 5 | 2028 | Exploitation | Maintenance prédictive RDM, import de manuels PDF, diagnostic assisté |

Dépendances clés : **Phase 0 bloque tout le reste** (pas d'IA live sur un moteur non validé sur matériel). Phase 1 alimente Phase 2 (le copilote a besoin de la structure musicale). Phase 3 alimente Phase 4 (les looks par cible spatiale ont besoin des positions calibrées).

---

## Phase 0 — Fiabilisation terrain (T4 2026)

Objectif : rendre l'application **utilisable sur un vrai plateau**. Peu d'IA, beaucoup de fondations.

> **État au 17/10/2026** — implémenté et testé sans matériel : 0.2 (variante, voir ci-dessous), 0.3, 0.4 (Art-Net), 0.5, 0.6, 0.7. Reste : 0.1 (campagne matérielle), RDM via Enttec, QR code d'appairage, sortie OSC au-delà de l'accusé de réception, banc d'évaluation pour le LLM distant et extension du jeu de cas (32 aujourd'hui, objectif 300).
>
> 0.2 : le moteur n'a **pas** été déplacé dans un worker. Tout `AppService` lit le moteur de façon synchrone et le gain n'était pas démontré ; le problème mesuré (37–40 Hz pour 40) venait de l'ordonnanceur, réécrit à échéances auto-calibrées : 40 et 44 Hz à ± 0,5 Hz, gigue p95 < 2 ms en test. Le passage en worker reste à faire si la charge (plusieurs milliers de projecteurs) l'exige.

### 0.1 Campagne de validation matérielle
- Exécuter intégralement [docs/HARDWARE.md](docs/HARDWARE.md) sur au moins : 1 nœud Art-Net, 1 récepteur sACN, 1 Enttec DMX USB Pro, 1 interface Open DMX, 3 projecteurs de types différents (PAR RGBW, lyre spot 16 bits, barre LED multi-cellules).
- Mesurer et publier : cadence réelle par sortie, gigue, latence bout en bout (photodiode + oscilloscope ou caméra haute vitesse).
- **Critères d'acceptation** : 8 h d'émission continue sans perte, reconnexion après débranchement < 10 s, valeurs transmises = valeurs reçues (testeur DMX) sur 100 % des canaux testés.
- Estimation : 2 semaines (dépend de l'accès au matériel).

### 0.2 Moteur dans un Worker
- Déplacer `Engine` + `OutputManager` dans un `worker_threads` ; le main ne garde que l'orchestration et l'IPC.
- Timer haute résolution dans le worker (boucle `Atomics.wait` compensée) pour viser 44 Hz stables au lieu de 37–40 Hz.
- Transfert des univers par `SharedArrayBuffer` (pas de sérialisation par tick).
- **Critères** : gigue p99 < 2 ms à 44 Hz, 5 000 projecteurs / 32 univers < 50 % de la période, interface fluide pendant un appel IA long.
- Estimation : 2 semaines.

### 0.3 Entrées de contrôle : MIDI, OSC, timecode
- MIDI (Web MIDI dans le renderer, relayé en commandes typées) : mapping apprenable (« learn ») vers GO, BACK, master, faders de groupes.
- OSC entrant/sortant (UDP, `dgram`) : intégration QLab, Ableton, TouchOSC.
- Timecode LTC (entrée audio) et MTC (MIDI) pour piloter la timeline.
- **Critères** : GO MIDI → changement DMX < 30 ms ; timeline verrouillée sur LTC avec dérive < 1 image sur 10 min.
- Estimation : 3 semaines.

### 0.4 RDM (Remote Device Management)
- Découverte RDM via Enttec Pro (label RDM) et Art-Net RDM (ArtTod / ArtRdm).
- Lecture : modèle, fabricant, adresse, mode, compteur d'heures, capteurs (température).
- Écriture **sur confirmation** : adresse DMX, mode, identify.
- Prérequis direct de 5.1 (maintenance prédictive) et 3.1 (auto-patch).
- Estimation : 3 semaines.

### 0.5 IA — Garde-fou photosensible (« Flash Guard »)
Fonctionnalité de sécurité, prioritaire parce que l'IA génère des effets.
- Analyse en temps réel du **flux visuel calculé** (pas du DMX brut) : luminance relative par zone de scène, dérivée du modèle `VisualFixture` (intensité × couleur × surface éclairée estimée).
- Détection des **flashs généraux et des flashs rouges saturés** selon les seuils de référence des recommandations sur l'épilepsie photosensible (même logique que les tests de type Harding / ITU-R BT.1702 : pas plus de 3 flashs par seconde au-delà d'un seuil de variation de luminance et de surface).
- Trois niveaux : *avertir* (badge), *atténuer* (réduction automatique de l'amplitude d'effet, couche de sécurité au-dessus des effets, sous le programmeur), *bloquer* (refus de l'action IA à la validation).
- Intégré à `director.ts` : toute proposition IA est simulée sur 10 s dans le moteur hors ligne et rejetée si elle dépasse le seuil.
- **Limite assumée** : estimation à partir d'un modèle approximatif, pas une certification. Le dire clairement dans l'interface.
- **Critères** : jeu de 50 séquences étiquetées (dangereuses / sûres), 100 % des dangereuses détectées, < 10 % de faux positifs.
- Estimation : 2 semaines.

### 0.6 IA — Banc d'évaluation (voir [§12](#12-évaluation-de-lia))
Mettre en place avant les phases IA : sans mesure, impossible de savoir si une amélioration en est une.

### 0.7 Contrôle à distance (tablette / téléphone)
- Serveur WebSocket local optionnel (désactivé par défaut, appairage par QR code + jeton), interface web réduite : GO/BACK, master, blackout, palettes, vue 3D.
- Même validation Zod que l'IPC, mêmes priorités.
- Estimation : 2 semaines.

---

## Phase 1 — Intelligence musicale (T1 2027)

Objectif : que l'application **comprenne un morceau** aussi bien qu'un opérateur qui l'a écouté trois fois.

> **État au 17/10/2026** : 1.1 à 1.5 implémentés et testés. Écarts assumés par rapport au plan :
> - pas de modèle ONNX (ni corpus annoté ni modèle entraîné). L'étiquetage des sections et la prédiction de drop reposent sur du traitement du signal et des règles à poids fixés à la main, vérifiés sur des morceaux synthétiques à vérité terrain connue (tempo à ±1 BPM, premiers temps > 90 %, frontières à ±1 temps, 4 min analysées en ≈ 2 s ; suivi live sans erreur d'octave de 80 à 170 BPM ; drop annoncé à ±1 temps sans fausse alerte sur un groove stable) ;
> - analyse dans le thread du renderer, en tranches asynchrones, plutôt que dans un worker ;
> - pas de détection de voix, ni d'empreinte acoustique au-delà de l'empreinte SHA-256 du fichier.
>
> Reste à faire : constituer le corpus réel de 50 titres annotés et y mesurer les critères, puis valider le rendu par des éclairagistes (critère « 8 titres sur 10 utilisables »).

### 1.1 Analyse de fichier audio hors ligne
- Import d'un fichier (WAV, MP3, FLAC, via décodage Web Audio dans le renderer, analyse dans un worker).
- Extraction :
  - **grille rythmique** : tempo, temps, premiers temps de mesure (downbeats), dérive de tempo ;
  - **structure** : segmentation en sections (intro, couplet, pré-refrain, refrain, pont, break, drop, outro) par matrice d'auto-similarité sur chroma + MFCC + énergie, puis étiquetage ;
  - **descripteurs** : énergie par section, brillance spectrale, densité d'attaques, tonalité et mode (majeur/mineur), présence de voix ;
  - **événements** : accents, silences, montées (risers), impacts.
- Modèles : traitement du signal classique en TypeScript pour la grille et l'énergie ; modèle léger de segmentation exécuté via **ONNX Runtime** (`onnxruntime-node` ou `onnxruntime-web` en WASM/WebGPU) pour l'étiquetage des sections.
- Cache par empreinte de fichier (hash) dans le dossier du projet.
- **Critères** : downbeats corrects > 90 % sur un corpus de 50 titres variés ; frontières de sections à ± 1 temps dans 80 % des cas ; analyse d'un titre de 4 min < 15 s sur un PC portable milieu de gamme.
- Estimation : 5 semaines.

### 1.2 Correction du BPM live (erreur ×2)
- Remplacer l'histogramme d'intervalles par un suivi de tempo à base de **fonction d'onset + autocorrélation + filtre de Kalman** sur le tempo, avec désambiguïsation ×2 / ÷2 par la plage de genre configurée (ex. 120–135 pour la house).
- Option « tap pour corriger » qui recale la phase sans casser le suivi.
- **Critères** : erreur d'octave < 5 % sur le corpus, verrouillage < 4 s.
- Estimation : 2 semaines.

### 1.3 IA — Auto-programmation d'un morceau (« Song-to-Show »)
Fonction phare de la phase.
- Entrée : un fichier analysé (1.1) + une intention en langage naturel (« concert pop, sobre sur les couplets, explosion sur les refrains, pas de strobe ») + le kit patché.
- Sortie : une **timeline complète** (`core/engine/timeline.ts`) synchronisée sur la grille : un look par section, transitions calées sur les downbeats, effets cadencés au tempo, accents sur les impacts.
- Architecture en deux étages :
  1. **Planificateur** (LLM via OpenRouter, ou règles locales) : produit un *plan de show* typé — pour chaque section : palette de couleurs, niveau d'énergie, groupes actifs, type de mouvement, densité d'effets. Nouveau schéma Zod `showPlanSchema`, validé comme les actions actuelles.
  2. **Compilateur déterministe** (local, testable) : traduit le plan en scènes, effets et événements de timeline en respectant les capacités réelles du kit, la sécurité (strobe, Flash Guard) et les priorités.
- Le LLM ne voit jamais l'audio : il reçoit la structure symbolique (sections, durées, énergie, tonalité). Données envoyées faibles et documentées.
- Édition : chaque section régénérable isolément (« refais le 2ᵉ refrain plus chaud »), variantes A/B, verrouillage de sections validées.
- **Critères** : programme exploitable (jugé « utilisable avec retouches mineures » par 3 éclairagistes) sur 8 titres sur 10 ; génération complète < 30 s en local, < 60 s avec LLM.
- Estimation : 6 semaines.

### 1.4 IA — Prédiction de drop et de refrain en live
- En live, sans fichier : prédire **4 à 8 temps à l'avance** l'arrivée d'un drop ou d'un refrain.
- Signaux : montée d'énergie, filtrage passe-haut progressif (riser), raréfaction des basses (breakdown), roulements de caisse claire, position dans la mesure (frontières de 8/16/32 temps).
- Modèle : petit réseau récurrent ou modèle à base d'arbres sur descripteurs, entraîné sur un corpus annoté, exporté en ONNX, inférence < 5 ms par trame d'analyse.
- Intégration : nouvelle source d'événements `audio.prediction` (confiance + échéance en temps) consommée par le copilote (2.1) et par des **cues armés** : « au prochain drop prédit avec confiance > 0,8, déclencher la cue 12 ».
- Mode avec fichier connu (1.1) : la prédiction devient une certitude si le morceau est reconnu (empreinte acoustique locale sur les titres déjà analysés du projet).
- **Critères** : rappel > 80 %, précision > 85 % pour les drops en musique électronique ; aucun déclenchement autonome sans armement explicite.
- Estimation : 5 semaines (dont constitution du corpus).

### 1.5 Effets musicaux avancés
- Effets calés sur la **mesure** et non plus seulement sur le BPM (phrase de 4/8/16 temps), avec rampes par section.
- Effets « suiveurs de bande » : intensité pilotée par la bande grave, couleur par la brillance, mouvement par la densité d'attaques.
- Estimation : 2 semaines.

---

## Phase 2 — Copilote live et contrôle vocal (T2 2027)

Objectif : un **assistant de régie** qui fait gagner des secondes précieuses en live, sans jamais surprendre l'opérateur.

### 2.1 IA — Copilote anticipatif
- Panneau latéral permanent en live, qui propose **la prochaine action probable** : prochaine cue, changement de look au refrain prédit, retour au calme au break.
- Trois modes, sélectionnables à tout moment :
  - **Conseil** : suggestions affichées, validation par une touche (configurable, ex. `Entrée` sur le pavé numérique ou bouton MIDI).
  - **Assisté** : exécution automatique des suggestions dont la confiance dépasse un seuil, **dans l'enveloppe autorisée** (groupes, attributs, intensité max), avec annulation en un geste pendant 3 s.
  - **Pilote automatique** (« busking IA ») : l'IA joue seule dans l'enveloppe ; tout geste manuel la suspend sur les projecteurs touchés.
- Moteur de décision **local** (latence < 50 ms) : combinaison de la structure musicale (Phase 1), de l'historique de la soirée (anti-répétition, évolution de l'énergie sur le set) et des préférences apprises (4.2). Le LLM n'est utilisé que pour reformuler ou générer de nouveaux looks hors du chemin critique.
- Journal complet : chaque décision IA est horodatée avec sa raison (« drop prédit 0,91, look énergie 5 »), exportable.
- **Critères** : en mode Conseil, > 60 % des suggestions acceptées par des opérateurs testeurs ; en mode Assisté, 0 action hors enveloppe (vérifié par test automatique).
- Estimation : 6 semaines.

### 2.2 IA — Commande vocale locale
- Push-to-talk (pédale, touche, bouton MIDI) — **jamais d'écoute permanente**.
- Reconnaissance vocale **embarquée** (modèle de type Whisper quantifié, exécuté via ONNX Runtime / WebGPU ou binaire natif), français et anglais, vocabulaire biaisé sur les noms du projet (groupes, scènes, projecteurs).
- Deux chemins :
  - **commandes directes** reconnues par grammaire (« GO », « cue 14 », « lyres en bleu », « master à 50 », « blackout ») → exécution immédiate, < 300 ms après la fin de la parole ;
  - **demandes ouvertes** (« quelque chose de plus intime sur le piano ») → `ai.propose` existant, avec aperçu.
- Retour sonore discret ou visuel de la commande comprise ; « annule » toujours disponible.
- Robustesse au bruit de concert : modèle de réduction de bruit en entrée, test à 95 dB SPL de musique de fond.
- **Critères** : taux d'erreur sur commandes directes < 3 % au calme, < 10 % en bruit de concert ; aucun déclenchement hors push-to-talk.
- Estimation : 5 semaines.

### 2.3 IA — Busking assisté par palettes intelligentes
- Grille de « boutons d'énergie » (calme → explosion) et de « couleurs d'ambiance » : un appui produit un look **cohérent avec ce qui joue déjà** (transition lisse, pas de saut de couleur incohérent).
- L'IA génère et met en cache à l'avance un jeu de looks pour chaque combinaison à partir du kit et du style appris, pour un déclenchement instantané.
- Estimation : 3 semaines.

### 2.4 IA — Apprentissage par démonstration (« Rehearsal Recorder »)
- L'opérateur joue le show à la main pendant une répétition ; l'application enregistre ses gestes alignés sur la musique (timecode ou analyse).
- L'IA **nettoie** l'enregistrement en timeline : quantification sur la grille, fusion des micro-ajustements, détection des intentions (« fondu vers le bleu sur le refrain »), proposition de cues nommés.
- **Critères** : la timeline rejouée est jugée fidèle par l'opérateur sur 4 répétitions sur 5.
- Estimation : 4 semaines.

---

## Phase 3 — Vision par ordinateur et calibration automatique (T3 2027)

Objectif : supprimer les heures de patch et de focus à la main grâce à une simple webcam ou un smartphone.

### 3.1 IA — Auto-localisation des projecteurs par caméra

> **État au 17/10/2026** : implémenté, avec webcam et smartphone (une photo par image via la télécommande, car les navigateurs n'ouvrent la caméra qu'en HTTPS). Codage binaire avec images inverses (2 + 2⌈log₂(n+1)⌉ images, la lecture de chaque bit résiste à la lumière ambiante), plus un mode un par un. Calibration par les 4 coins du plateau (homographie, focale, pose, puis Levenberg–Marquardt). Calcul à 1 vue + hauteur connue, ou triangulation à 2 vues. Diagnostic du patch et croisement RDM. Sur scène synthétique de 10 m (40 projecteurs, bruit, lumière ambiante, clics à ±1,5 px) : erreur maximale de 9 cm à 1 vue et 10 cm en 3D à 2 vues ; séquence de 14 images en ≈ 9 s, décodage en 0,3 s. Écarts : rotations non mesurées (reportées à 3.2) ; projecteurs dont la lentille n'est pas visible de la caméra non détectés. **Reste à valider sur un vrai plateau.**
- L'utilisateur pose une caméra (webcam USB, ou smartphone via le contrôle à distance 0.7) face au plateau.
- L'application allume **chaque projecteur à tour de rôle** (ou par codage binaire spatio-temporel pour aller vite : *n* projecteurs identifiés en log₂(*n*) images) et détecte sa position dans l'image.
- Avec 2 points de vue (ou 1 vue + la hauteur de truss connue), triangulation des positions 3D et mise à jour des positions/hauteurs/rotations du patch.
- Détection des erreurs de patch : projecteur qui ne répond pas, qui répond à la mauvaise adresse, adresses inversées (« ce que vous appelez Lyre 3 est en réalité à jardin »).
- Couplé à RDM (0.4) : identification croisée modèle/adresse/position.
- **Sécurité** : séquence lancée uniquement sur confirmation, intensité limitée, pas de strobe.
- **Critères** : position estimée à ± 30 cm sur un plateau de 10 m ; 40 projecteurs localisés en < 2 min.
- Estimation : 6 semaines.

### 3.2 IA — Focus automatique (calibration pan/tilt)
- Pour chaque lyre : balayage pan/tilt, détection de la tache au sol dans l'image, ajustement d'un **modèle géométrique** (position, orientation de montage, inversion pan/tilt, décalage d'origine, plage réelle en degrés).
- Résultat : chaque lyre sait viser un **point 3D** de la scène (cinématique inverse), ce que le visualiseur (`core/visualizer/beam.ts`) sait déjà calculer dans l'autre sens.
- Nouvelles actions IA typées : `focusOn { target, point: {x, y, z} | markerName }`, palettes de position définies par **points de scène** (« chanteur », « batteur », « centre avant-scène ») partagées par toutes les lyres.
- Gros gain technique : une palette « sur le chanteur » reste valide même si on change de lyre ou de salle (recalibrage = 2 min).
- **Critères** : erreur de visée < 20 cm à 8 m après calibration.
- Estimation : 5 semaines.

### 3.3 IA — Suivi d'artiste (follow spot automatique)
- Détection et suivi de personnes dans le flux caméra (modèle de pose léger en ONNX, > 25 i/s sur GPU intégré).
- Assignation d'une ou plusieurs lyres à une personne ; la cinématique inverse (3.2) convertit la position en pan/tilt, avec lissage (filtre prédictif) pour éviter les à-coups.
- Gestion des pertes de suivi : maintien de la dernière position, puis retour à une palette de repli.
- Source dans la fusion : nouvelle couche « tracking » à priorité configurable, toujours sous le programmeur.
- Option matérielle future : balises UWB pour les plateaux où la caméra est inadaptée (fumée dense, contre-jour).
- **Critères** : latence caméra → mouvement < 120 ms, aucune saute de cible entre deux personnes proches dans 95 % des cas du jeu de test.
- Estimation : 6 semaines.

### 3.4 Visualiseur : réalité mixte
- Superposer le rendu 3D au flux caméra (même calibration) pour comparer prévisualisation et réalité ; mise en évidence des écarts de focus.
- Estimation : 2 semaines.

---

## Phase 4 — Design assisté et apprentissage du style (T4 2027)

Objectif : un **assistant de conception** qui comprend une intention visuelle et le style de son utilisateur.

### 4.1 IA — Moodboard → looks
- Glisser une image (photo de concert, tableau, affiche, capture de clip) : extraction de la palette de couleurs dominante, du contraste, de la direction de lumière perçue, de la « température » de l'ambiance.
- Extraction locale (quantification de couleurs + modèle de description d'image léger) ; option modèle multimodal distant via OpenRouter pour une lecture plus fine (« contre-jour bleu, douche chaude sur le centre »).
- Sortie : 3 à 5 looks proposés en scènes, avec aperçu 3D côte à côte avec l'image source.
- Estimation : 3 semaines.

### 4.2 IA — Apprentissage du style de l'éclairagiste
- Représentation vectorielle des looks (couleurs, intensités par zone, mouvements, densité d'effets) et des enchaînements de l'utilisateur, calculée localement à partir de ses projets.
- Usage : classer les propositions de l'IA par proximité avec le style de l'utilisateur, proposer des « variations dans mon style », et alimenter le copilote (2.1).
- Profils de style exportables/partageables (fichier JSON, sans données personnelles).
- **Toutes les données restent locales** ; aucun entraînement distant.
- Estimation : 4 semaines.

### 4.3 IA — Auto-critique visuelle (boucle rendu → évaluation)
- Après génération d'un look, l'application **rend une image du visualiseur 3D** (caméra Régie et Face) et la soumet à un évaluateur :
  - règles locales mesurables : équilibre jardin/cour, zones mortes (personne à l'emplacement d'un point de scène non éclairé), éblouissement du public (faisceaux de lyres pointés vers la salle), surexposition ;
  - option modèle multimodal : cohérence avec l'intention demandée.
- L'IA corrige sa proposition (2 itérations max) et **explique** les corrections dans le rapport.
- **Critères** : réduction mesurée des retouches manuelles après génération (cf. §13).
- Estimation : 4 semaines.

### 4.4 IA — Exploration évolutive de looks
- Mode « atelier » : l'IA génère 8 variations, l'utilisateur garde celles qu'il aime, l'IA croise et mute les gagnantes (algorithme génétique sur l'espace des paramètres de scène), en quelques secondes et sans LLM.
- Estimation : 2 semaines.

### 4.5 IA — Recherche sémantique dans le show
- « Retrouve la scène bleue calme du 2ᵉ acte », « quelles cues utilisent le strobe ? » : index local des scènes, cues et effets (descripteurs + texte), requêtes en langage naturel.
- Estimation : 2 semaines.

### 4.6 Rendu vidéo de prévisualisation
- Export MP4 de la vue 3D synchronisée sur l'audio (Song-to-Show 1.3) pour faire valider un programme par un client ou un artiste avant la date.
- Estimation : 2 semaines.

---

## Phase 5 — Maintenance prédictive et exploitation (2028)

Objectif : mettre l'IA au service de **la technique et du parc matériel**.

### 5.1 IA — Maintenance prédictive
- Collecte via RDM (0.4) : heures de fonctionnement, heures lampe/LED, températures, erreurs, cycles d'allumage ; enrichie par les statistiques de sorties (erreurs, reconnexions) déjà suivies par `OutputManager`.
- Détection d'anomalies (modèle statistique local, puis modèle appris sur l'historique du parc) : dérive de température, ventilateur défaillant, projecteur qui décroche du signal.
- Alertes avant le show (« Lyre 4 : température +12 °C par rapport à son historique à charge équivalente ») et rapport de parc exportable.
- Estimation : 5 semaines.

### 5.2 IA — Import de manuels PDF → profils
- Glisser le manuel PDF d'un projecteur : extraction des tableaux de canaux DMX par mode (lecture de tableaux + LLM), production d'un profil Luma.
- **Validation obligatoire** : le profil est présenté en différence face au tableau source, plages `dangerous` (reset, lampe) mises en évidence pour confirmation manuelle, test « identify » par canal sur le matériel si connecté.
- Rapprochement automatique avec l'Open Fixture Library quand le modèle y existe.
- **Critères** : > 90 % des canaux corrects sans retouche sur 30 manuels de test ; aucune plage dangereuse non signalée.
- Estimation : 4 semaines.

### 5.3 IA — Diagnostic conversationnel
- « Pourquoi la barre LED 2 ne s'allume pas ? » : l'assistant interroge l'état de l'application (patch, priorités en cours, programmeur, blackout, sortie armée, dernière trame transmise, RDM) et répond avec la cause probable et la correction proposée.
- S'appuie sur des **outils en lecture seule** exposés à l'IA (nouvelles actions de type requête, pas d'écriture).
- Estimation : 3 semaines.

### 5.4 IA — Optimisation énergétique et thermique
- Estimation de la consommation par look (puissance des profils × intensités) ; proposition de variantes à rendu visuel équivalent consommant moins (ex. lumière blanche par canal W plutôt que RGB plein).
- Plafond de puissance par circuit électrique avec alerte.
- Estimation : 2 semaines.

### 5.5 Mode multi-opérateurs et réseau de consoles
- Plusieurs postes sur le même show (un sur la lumière face, un sur les effets), synchronisation du projet, verrouillage par groupe.
- Bascule de secours (« tracking backup ») : une seconde machine reprend l'émission si la première tombe.
- Estimation : 6 semaines.

---

## 11. Chantiers transverses

### 11.1 Infrastructure IA locale
- **ONNX Runtime** comme socle commun d'inférence locale (audio, voix, vision) : CPU par défaut, WebGPU/DirectML si disponible.
- Modèles téléchargés à la demande dans le dossier utilisateur, **vérifiés par empreinte SHA-256** signée, jamais exécutés depuis une source non vérifiée.
- Fournisseur LLM local optionnel (serveur compatible OpenAI sur `localhost`, ex. llama.cpp/Ollama) branché sur le même contrat que `providers/openrouter.ts`, pour un mode LLM 100 % hors ligne.
- Budget d'inférence par fonctionnalité et ordonnanceur : le moteur DMX (worker 0.2) n'est jamais concurrencé par l'IA.

### 11.2 Contrat d'actions IA versionné
- Version du schéma `aiActionSchema` ; nouvelles actions prévues : `focusOn`, `armOnPrediction`, `setEnvelope`, `generateTimeline`, `query*` (lecture seule).
- Tests de propriété (génération aléatoire d'actions valides et invalides) sur `director.ts`.

### 11.3 Performance
| Cible | Aujourd'hui | Objectif |
|---|---|---|
| Cadence DMX | 37–40 Hz (consigne 40) | 44 Hz stables, gigue p99 < 2 ms |
| Taille de show | 1 000 projecteurs ≈ 30 % de période | 5 000 projecteurs < 50 % |
| Vue 3D | ≈ 37 i/s (machine de dev) | 60 i/s pour 200 projecteurs, LOD des faisceaux au-delà |
| IA locale (règles) | — | proposition < 200 ms |
| Commande vocale directe | — | < 300 ms fin de parole → DMX |
| Copilote | — | décision < 50 ms |

### 11.4 Qualité et tests
- Corpus versionnés hors dépôt principal (audio, images de calibration, manuels PDF) avec licences vérifiées.
- Tests e2e sur matériel virtuel + campagne trimestrielle sur matériel réel.
- Tests de non-régression visuelle du visualiseur 3D (captures de référence avec tolérance).

### 11.5 Plateformes et distribution
- Build et tests macOS et Linux (configurés mais jamais construits aujourd'hui).
- Signature de l'installateur Windows (suppression de l'avertissement SmartScreen), mises à jour automatiques signées.

### 11.6 Documentation et formation
- Guide « premier show en 30 minutes », tutoriels vidéo par phase, documentation de chaque garde-fou de sécurité et de ses limites.

---

## 12. Évaluation de l'IA

Mis en place en Phase 0, enrichi à chaque phase.

| Banc | Contenu | Métriques |
|---|---|---|
| Prompts de référence | 300 demandes FR/EN annotées (intention, cibles, contraintes) sur 5 kits types | Actions valides %, cibles correctes %, respect des contraintes (strobe, groupes) %, latence |
| Sécurité | 100 demandes adverses (« strobe maximum sur le public », injection dans un nom de scène) | 0 action hors règles (bloquant) |
| Musique | 50 titres annotés (downbeats, sections, drops) | F-mesure frontières, précision/rappel drops, erreurs d'octave BPM |
| Voix | 1 000 énoncés enregistrés, au calme et avec bruit de concert | Taux d'erreur de commande |
| Vision | Captures de plateaux réels et synthétiques (rendus 3D) | Erreur de position (cm), erreur de visée |
| Profils PDF | 30 manuels | Canaux corrects %, plages dangereuses détectées % |

- Exécution automatique en CI pour les bancs locaux (règles, sécurité, musique) ; les bancs avec LLM distant sont lancés manuellement avec budget plafonné.
- Toute modification d'une invite système ou d'un modèle par défaut doit présenter le résultat du banc avant fusion.

---

## 13. Indicateurs de succès

| Indicateur | Mesure | Cible fin 2027 |
|---|---|---|
| Temps de préparation | Patch + focus + programmation d'un set de 10 titres, kit de 24 projecteurs | ÷ 4 par rapport à une programmation manuelle |
| Acceptation des propositions IA | Propositions appliquées sans modification / total | > 50 % |
| Retouches après génération | Actions manuelles dans les 2 min suivant une application IA | – 40 % après l'auto-critique (4.3) |
| Fiabilité live | Incidents de sortie par 100 h d'utilisation | < 1 |
| Sécurité | Actions IA hors enveloppe ou hors règles | 0 |
| Fonctionnement hors ligne | Fonctions IA disponibles sans réseau | 100 % des fonctions live |

---

## 14. Risques et parades

| Risque | Impact | Parade |
|---|---|---|
| Comportement inattendu sur du vrai matériel | Bloquant | Phase 0 avant tout le reste, campagne matérielle trimestrielle |
| IA qui surprend l'opérateur en live | Très élevé | Enveloppes, modes explicites, annulation en un geste, manuel prioritaire, journal |
| Flashs dangereux générés | Très élevé | Flash Guard (0.5) en validation et en temps réel, strobe interdit par défaut |
| Latence ou indisponibilité du LLM distant | Élevé | Chemin critique 100 % local, LLM hors chemin critique, bascule déjà en place |
| Coût des appels LLM | Moyen | Contexte compact (structure symbolique), cache, mode local par défaut, budget affiché |
| Fuite de données (projets, audio, images) | Élevé | Audio et vidéo jamais envoyés ; liste explicite des données transmises ; option 100 % locale |
| Modèles locaux trop lourds pour un PC de régie | Moyen | Modèles quantifiés, détection des capacités, désactivation propre |
| Corpus d'entraînement et licences | Moyen | Corpus aux licences vérifiées, données synthétiques depuis le visualiseur 3D |
| Dispersion fonctionnelle | Moyen | Une phase = un thème ; critères d'acceptation chiffrés avant de commencer |

---

## 15. Backlog et idées non planifiées

À réévaluer à chaque fin de phase :
- Génération procédurale de gobos et d'effets pixel-mapping à partir d'une description.
- Pixel mapping vidéo vers barres LED et matrices (entrée NDI / capture d'écran).
- Synchronisation avec les consoles son (lecture des scènes de la console audio pour adapter la lumière à l'orateur actif).
- Prise en compte de la météo et de la lumière du jour pour les événements en extérieur.
- Mode « théâtre » : conduite par texte (le script de la pièce aligné sur la reconnaissance vocale des comédiens déclenche les cues).
- Mode « installation » permanente : programmation horaire, réaction aux capteurs (présence, son ambiant), supervision à distance.
- Simulation photométrique réelle (ombres, atténuation, éclairement en lux) pour le design architectural.
- Place de marché de profils de style et de looks partagés par la communauté.
