# Luma AI DMX

Logiciel desktop de contrôle d'éclairage DMX assisté par IA, construit avec Electron, React et TypeScript. Il réunit une console DMX manuelle, un environnement de programmation (scènes, cues, effets, timeline) et un assistant « Lighting Director » qui produit des actions structurées et validées.

Le nom et la marque sont centralisés dans [`src/shared/brand.ts`](src/shared/brand.ts).

> **État du projet.** Le noyau est fonctionnel et testé en sortie virtuelle et en émission UDP réelle en boucle locale. Aucun test n'a été réalisé sur un projecteur ou une interface DMX physique. Voir [Limites matérielles](#limites-matérielles).

## Sommaire
- [Prérequis](#prérequis)
- [Installation et démarrage](#installation-et-démarrage)
- [Compilation, tests et packaging](#compilation-tests-et-packaging)
- [Prise en main](#prise-en-main)
- [Configuration DMX](#configuration-dmx)
- [Mode virtuel](#mode-virtuel)
- [Configuration de l'IA](#configuration-de-lia)
- [Sécurité](#sécurité)
- [Limites matérielles](#limites-matérielles)
- [Problèmes connus](#problèmes-connus)
- Documentation : [architecture](docs/ARCHITECTURE.md), [format de projet](docs/PROJECT_FORMAT.md), [format de profil](docs/PROFILE_FORMAT.md), [test avec du matériel réel](docs/HARDWARE.md), [roadmap](ROADMAP.md)

## Prérequis
- Node.js 22 ou plus récent (développé avec Node 24.16) et npm.
- Windows 10/11 x64 : c'est la plateforme où le build et les tests ont été exécutés. macOS et Linux sont configurés dans `electron-builder.yml`, mais **n'ont pas été construits ni testés**.
- Facultatif : une clé API OpenRouter pour utiliser un modèle de langage externe.

## Installation et démarrage
```bash
npm install
```
```bash
npm run dev
```
`npm run dev` démarre Electron avec rechargement à chaud. Pour lancer le build de production sans installateur :
```bash
npm run build
```
```bash
npm start
```

## Compilation, tests et packaging
| Commande | Rôle |
|---|---|
| `npm run typecheck` | TypeScript strict (`strict`, `noUncheckedIndexedAccess`) |
| `npm run lint` | ESLint (typescript-eslint + règles des hooks React) |
| `npm test` | Vitest : tests unitaires, d'intégration et de composants |
| `npm run eval` | Banc d'évaluation de l'IA locale (`tests/eval/cases.json`) : scores, latence, 0 violation de sécurité exigée ; rapport `test-results/ai-eval.json` |
| `npm run test:perf` | Mesures temps réel (cadence et gigue de l'ordonnanceur, charge de 1 000 projecteurs), exécutées seules pour ne pas être faussées par les autres tests |
| `npm run test:e2e` | Build puis Playwright, qui pilote l'application Electron réelle |
| `npm run check` | typecheck + lint + tests + tests de performance |
| `npm run package` | Installateur Windows NSIS dans `release/` |
| `npm run package:dir` | Application décompressée, sans installateur |

## Prise en main
0. **Premier lancement** : un écran d'accueil propose une **visite guidée** en 18 étapes. Elle met en surbrillance chaque zone de l'interface et ouvre les pages qu'elle décrit (←/→ pour avancer, Échap pour quitter). L'accueil donne aussi accès aux **10 projets de démonstration fictifs** : club électro, concert pop, théâtre, mariage, conférence, club de jazz, festival sur 2 univers, défilé de mode, concert en église, gala de danse. Chacun est livré avec patch, groupes, scènes, cues, effets et parfois une timeline, jouable en sortie virtuelle et en 3D. Sur le Dashboard, la liste **« Premiers pas »** se coche d'elle-même au fil de votre progression. Le bouton **?** de la barre supérieure relance la visite, ouvre la galerie de démos ou réaffiche la liste. Les démos s'ouvrent comme des copies non enregistrées (Ctrl+S pour les conserver) ; lieux, artistes et événements sont inventés.
1. **Créer un projet** : icône « + » de la barre supérieure ou `Ctrl+N`.
2. **Patcher des projecteurs** : *Fixtures › Ajouter*. Choisissez un profil, un mode, un univers et une quantité. L'adresse est automatique ou manuelle. Les chevauchements et les dépassements de 512 sont refusés. Les profils inclus sont **fictifs** (« Luma Demo ») et servent aux tests : ils ne décrivent aucun modèle commercial. Pour vos projecteurs, utilisez *Fixtures › Open Fixture Library* (catalogue en ligne ou fichier OFL) ou importez un profil au format Luma (voir [docs/PROFILE_FORMAT.md](docs/PROFILE_FORMAT.md)).
   - **Localiser par caméra** (*Fixtures › Localiser par caméra*) : posez une webcam face au plateau, ou utilisez un smartphone qui envoie une photo par étape via la télécommande. L'application allume les projecteurs selon un codage binaire : 14 images pour 40 projecteurs, en 10 s environ. Le mode « un par un » est aussi disponible. Cliquez ensuite les 4 coins du plateau : les positions sont calculées à hauteur connue, ou triangulées en 3D avec 2 vues, puis appliquées au patch après validation. L'assistant signale les projecteurs muets, les adresses en double, les réponses incohérentes (adresse décalée, mode différent) et les projecteurs inversés (« ce que vous appelez Lyre 3 est en réalité à jardin »). Avec une sortie Art-Net, il compare aussi modèle, mode et adresse via RDM. **Sécurité** : confirmation obligatoire, intensité limitée à 60 %, lumière blanche, aucun strobe. Le programmeur est relâché et les autres sources sont masquées pendant la séquence. Les rotations ne sont pas mesurées. Précision validée sur scène synthétique (≤ 10 cm sur un plateau de 10 m), **pas encore sur un vrai plateau**.
3. **Piloter en manuel** : dans la *Live Console*, sélectionnez des projecteurs ou un groupe. Les contrôles sont générés à partir des fonctions du profil : dimmer, couleur (RGB, RGBW ou roue), pan/tilt 16 bits, shutter, gobo, couleur par cellule pour les barres LED… Le manuel est **toujours prioritaire**. `Échap` le relâche.
4. **Enregistrer une scène** : *Live Console › Enregistrer scène* (à partir des valeurs du programmeur).
5. **Créer des cues** : *Cues & Sequences*. Chaque cue référence une scène, avec un fondu, un délai, une courbe et un déclenchement manuel ou enchaîné. Commandes : `Espace` = GO, `Maj+Espace` = BACK, `P` = pause/reprise.
6. **Effets et timeline** : *Effects* (10 types, synchronisation BPM, graine aléatoire) et *Timeline* (scènes, effets et cues sur une ligne de temps, avec annuler/rétablir).
7. **Visualiseur** : *Stage Visualizer*, vue 2D de dessus ou vue 3D (three.js).
   - Faisceaux volumétriques dans une brume réglable, avec halo (glow).
   - Taches de lumière et gobos au sol et sur le cyclorama.
   - Lyres articulées (base, lyre, tête suivant pan/tilt), facettes de prisme, flashs de strobe, zoom.
   - Un faisceau par cellule pour les barres LED.
   - Truss générés à partir du kit, avec pieds ; décor complet (plateau, cyclorama, coulisses, salle).
   - 5 caméras (Régie, Face, Dessus, Jardin, Cour), infobulle au survol, panneau du projecteur sélectionné (hauteur et rotation modifiables), noms, plein écran, compteur d'images/s.
   - Un projecteur à moins de 1 m de hauteur est considéré posé au sol : son faisceau part vers le haut.
8. **Musique (Song-to-Show)** : *Musique › Importer un morceau* (WAV, MP3, FLAC…). L'analyse se fait sur la machine (≈ 2 s pour 4 min) : tempo, premiers temps, sections étiquetées (intro, couplet, pré-refrain, montée, refrain, drop, break, pont, outro), tonalité, impacts et montées. Seule l'analyse est enregistrée dans le projet, avec l'empreinte SHA-256 du fichier : le son ne l'est jamais. Décrivez l'intention (« sobre sur les couplets, explosion sur les refrains, pas de strobe »), puis *Générer le show* : une timeline complète calée sur les sections, avec scènes, effets synchronisés au tempo et à la mesure, mouvements et accents sur les impacts. Chaque section peut être corrigée (étiquette), retouchée (« plus chaud », « en rouge »), régénérée ou verrouillée ; *Variante* propose une autre version des sections non verrouillées. *Lecture synchronisée* joue le morceau : la timeline suit la position de lecture, et l'analyseur live écoute la sortie du lecteur (prédiction de drop exacte).
9. **Assistant IA** : *AI Lighting Director*. Décrivez l'ambiance souhaitée, vérifiez la proposition (cibles, avertissements, aperçu), modifiez ou excluez des actions, puis appliquez. Un rapport indique les actions exécutées, celles qui ont été ignorées et la vérification de l'état calculé.
10. **Enregistrer** : `Ctrl+S`. Au moment de quitter, l'application signale les modifications non enregistrées.

## Configuration DMX
Dans *DMX Output › Sorties* :
- **Art-Net** : destination IPv4 (nœud ou broadcast, par exemple `2.255.255.255`), interface locale, correspondance univers local → Port-Address (0–32767), séquence 1–255.
- **sACN / E1.31** : multicast (`239.255.hi.lo`) ou unicast, priorité 0–200, CID persistant. À l'arrêt, l'application envoie 3 paquets « stream terminated ».
- **USB-DMX (Enttec DMX USB Pro)** : choix du port série. La détection signale les puces FTDI, ce qui **ne confirme pas** qu'il s'agit d'une Enttec.
- **USB-DMX (Open DMX / FTDI sans microcontrôleur)** : le logiciel génère lui-même le break DMX puis la trame (250 000 bauds, 8N2). Cadence par défaut : 30 images/s.
- **Sortie virtuelle** : aucune émission matérielle.

Les sorties réelles **démarrent toujours désarmées**. Pour émettre, cliquez sur *Armer* puis confirmez. Le badge **SIMULATION / LIVE** de la barre supérieure indique en permanence si une sortie réelle est armée. Le bouton **STOP** (`Maj+Échap`) coupe immédiatement toutes les émissions réelles.

Le moniteur 512 canaux affiche séparément **l'état calculé** par le moteur et **la dernière trame transmise** par chaque sortie. Une trame transmise ne prouve pas que le projecteur l'a reçue.

## Mode virtuel
La sortie virtuelle (univers 1 à 4 par défaut) enregistre les trames reçues, l'historique des changements par canal (2 000 derniers) et des statistiques. Elle accepte aussi l'injection de défauts (*DMX Output › Diagnostics*) : erreurs d'envoi ou déconnexion simulée, pour vérifier les alertes et la reconnexion automatique (délai de 1 s à 10 s). Toute la programmation fonctionne sans matériel.

## Configuration de l'IA
- **Mode local déterministe (par défaut)** : règles et modèles intégrés, en français et en partie en anglais, sans réseau. Il comprend notamment les ambiances (lounge, club…), les couleurs, les durées, les intensités, les cibles (« les quatre lyres », noms de groupes), les effets (chase, vague, arc-en-ciel, pulse, mouvements, strobe si autorisé), les drops, les shows de N minutes, les variantes et les ajustements (« plus chaud et moins agressif »). Ce mode est signalé comme tel et ne se présente jamais comme un modèle de langage. Une demande non reconnue est déclarée comme telle.
- **OpenRouter** : *Settings › IA et fournisseurs* : fournisseur « OpenRouter », puis choix du modèle. *Charger la liste des modèles* affiche le catalogue OpenRouter avec recherche, contexte, prix par million de jetons et format pris en charge. On peut aussi saisir un identifiant `fournisseur/modèle` ; `openrouter/auto` laisse OpenRouter choisir. La clé API (`sk-or-v1-…`) est chiffrée par le système (Electron `safeStorage`) dans le processus principal. Elle n'est jamais renvoyée à l'interface ni écrite dans un projet. Le format JSON est imposé selon les capacités du modèle : sortie structurée (`json_schema`), sinon mode JSON, sinon consigne seule. La réponse est ensuite **revalidée** par le schéma strict de l'application. L'effort de raisonnement n'est transmis qu'aux modèles qui le prennent en charge. Si le fournisseur est indisponible (réseau, clé, crédits, modèle), l'application bascule sur le mode local et le signale. Données envoyées : la demande et une description du kit (noms, types, capacités, groupes, scènes).
- L'IA ne produit **que** des actions typées (`setIntensity`, `setColor`, `setPosition`, `startEffect`, `stopEffect`, `createScene`, `applyScene`, `createCue`, `createSequence`, `setBpm`, `releaseAi`). Elle n'envoie jamais de DMX, n'exécute aucun code et n'a pas accès aux fonctions spéciales (reset, lampe). Le strobe exige l'autorisation explicite *Autoriser l'IA à proposer des effets strobe*.

## Sécurité
- Electron : `contextIsolation`, `sandbox`, `nodeIntegration: false`, CSP stricte, navigation bloquée, nouvelles fenêtres limitées à la vue 3D détachée, seules les permissions micro (audio réactif, LTC) et MIDI sont accordées. Le renderer ne reçoit qu'une API à deux fonctions (`invoke` et `on`). Chaque commande IPC est validée par Zod dans le processus principal ; les origines inconnues sont refusées.
- Priorités : le manuel est toujours prioritaire. À priorité égale : HTP pour l'intensité, LTP pour le reste. Une priorité supérieure remplace. Détails dans [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- Fonctions spéciales : les plages marquées `dangerous` dans les profils (reset, extinction de lampe) ne sont émises qu'après confirmation manuelle. Toute autre source est ramenée à la valeur par défaut du canal.
- Blackout configurable (*Settings › Moteur & sécurité*) : intensités seules, intensités + shutter fermé (par défaut), ou tous les canaux à 0. **Le blackout n'est pas un état universellement sûr** : vérifiez le comportement de vos appareils.
- Strobe : fréquence plafonnée (10 Hz par défaut, réglable).
- Protection contre les boucles : un seul enchaînement automatique de cue par tick, applications IA limitées à une toutes les 300 ms, au plus 50 actions par proposition et 64 cues par séquence.
- Garde-fou photosensible (*Settings › Moteur & sécurité*) : estimation des flashs vus par le public (> 3 flashs/s ou strobe rapide sur une part importante du kit, logique des tests Harding / ITU-R BT.1702). *Avertir* (par défaut) affiche une alerte ; *Limiter* borne la vitesse de variation des intensités et couleurs et ouvre les strobes rapides, sauf sur ce que tient le programmeur. Les effets IA qui dépasseraient la limite sont refusés à la validation (simulation de 3 s). **Estimation à partir d'un modèle approximatif, pas une certification.**
- Contrôle externe (*Settings › Contrôle externe*, tout désactivé par défaut) : MIDI (apprentissage de touches et faders), OSC sur UDP (127.0.0.1 par défaut), timecode MTC ou LTC (la timeline suit), télécommande tablette sur le réseau local protégée par jeton. Aucune de ces entrées ne peut armer une sortie ni reprendre les émissions.
- RDM via Art-Net (*DMX Output › RDM*) : découverte, lecture (modèle, adresse, heures, capteurs), identify et changement d'adresse sur confirmation. Testé contre un nœud simulé uniquement ; RDM via Enttec non implémenté.
- STOP OUTPUT : arrêt des émissions. Ensuite, **chaque projecteur applique son propre comportement en cas de perte de signal DMX** (maintien de la dernière valeur ou extinction selon le modèle). Consultez la documentation de vos appareils.

## Limites matérielles
- **Aucun matériel DMX n'a été testé.** Art-Net et sACN sont implémentés d'après les spécifications. Le format des paquets et l'émission UDP sont vérifiés par des tests en boucle locale (`127.0.0.1`), mais pas avec un nœud ou un projecteur réel.
- Les pilotes USB-DMX (Enttec DMX USB Pro « label 6 » et Open DMX FTDI) n'ont pas été vérifiés sur matériel. En Open DMX, le break est généré par des appels système : il dure environ 1 ms ou plus, avec une gigue qui dépend du système et du pilote FTDI. Certains récepteurs sensibles au timing peuvent mal le tolérer.
- La fréquence d'émission est **mesurée**, pas garantie. L'ordonnanceur calibre la résolution des timers de la machine et termine l'attente par de courtes boucles `setImmediate` : en test, 40 et 44 Hz sont tenus à ± 0,5 Hz avec une gigue p95 < 2 ms (valeur affichée dans la barre d'état). Ces boucles coûtent un peu de CPU (jusqu'à environ 16 ms d'attente active par période si les timers du système sont grossiers). Les latences réseau et d'interface ne sont pas mesurées.
- Les visualiseurs 2D et 3D sont des représentations approximatives, pas des simulations photométriques : pas d'atténuation réelle, ni de gobos, ni d'ombres.
- Audio en direct : le tempo est suivi par autocorrélation dans la plage de tempo du genre (*Audio Reactive › Analyse*), avec un filtre de Kalman. En test, il se verrouille en moins de 4 s, sans erreur d'octave de 80 à 170 BPM. Le premier temps se déduit des accents de basse, et *Recaler sur le 1* le corrige d'un tap. La **prédiction de drop/refrain** combine creux de basse, montée des aigus et fins de phrase de 4 mesures avec des poids réglés à la main : c'est une estimation, pas un modèle entraîné. Le GO sur drop prédit ne part que s'il est **armé** explicitement, une seule fois, et il n'est jamais armé au démarrage.
- Analyse de morceau : les étiquettes de sections viennent de règles (répétitions, énergie, basses), validées sur des morceaux synthétiques seulement. Corrigez-les si besoin. Sans modèle entraîné, la voix n'est pas détectée.

## Problèmes connus
- Projecteurs multi-cellules : les effets Rainbow et Color cycle se répartissent par cellule ; les autres effets (chase, pulse…) agissent sur le projecteur entier.
- Import OFL : conversion automatique à vérifier avec le manuel. Les canaux non représentables (24 bits, fonctions sans équivalent) deviennent des canaux génériques, adresses conservées. Les ordres de pixels autres que XYZ sont approximés. Le catalogue en ligne passe par l'API GitHub (limite d'environ 60 requêtes/heure sans authentification).
- Dans une liste de cues, les attributs non-intensité absents du cue suivant sont **maintenus** (tracking), alors que les intensités absentes retombent à 0.
- Quand une proposition IA contient plusieurs actions immédiates avec des fondus différents, le fondu le plus long s'applique à l'ensemble.
- Raccourcis : configurables dans *Settings › Raccourcis* ; annuler/rétablir de la timeline restent fixés à Ctrl+Z / Ctrl+Y.
- OpenRouter n'a été testé qu'avec des réponses simulées : aucun appel facturé n'a été effectué. La liste réelle des modèles a, elle, été récupérée avec succès.
- L'installateur n'est pas signé (avertissement SmartScreen possible).
