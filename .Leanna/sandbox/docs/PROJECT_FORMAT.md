# Format de projet (`*.luma.json`)

JSON UTF-8, indenté. Il est validé à l'ouverture par `projectSchema` ([src/core/model/schemas.ts](../src/core/model/schemas.ts)), qui fait foi.

```json
{
  "format": "luma-ai-dmx-project",
  "version": 3,
  "id": "uuid",
  "meta": { "name": "Concert", "show": "", "createdAt": "2026-10-17T10:00:00.000Z", "modifiedAt": "…", "notes": "" },
  "show": { "bpm": 120, "universes": 1 },
  "profiles": [],
  "patch": [{ "id": "…", "name": "PAR 1", "profileId": "demo-par-rgbw", "mode": "6ch DRGBW+Strobe", "universe": 1, "address": 1, "tags": [], "position": { "x": 0, "y": 2 }, "rotation": 0, "notes": "" }],
  "groups": [{ "id": "…", "name": "Face", "color": "#8B5CF6", "fixtureIds": ["…"] }],
  "palettes": [{ "id": "…", "name": "Violet", "kind": "color", "color": "#8B00FF", "values": {} }],
  "scenes": [{ "id": "…", "name": "Lounge", "notes": "", "origin": "user", "values": { "<fixtureId>": { "dimmer": 0.55, "red": 0.54, "blue": 1 } } }],
  "cueLists": [{ "id": "…", "name": "Liste", "priority": 50, "loop": false, "cues": [{ "id": "…", "number": 1, "name": "Intro", "sceneId": "…", "fade": 2, "delay": 0, "curve": "linear", "trigger": { "type": "manual" }, "effectIds": [] }] }],
  "effects": [],
  "timelines": [],
  "audio": { "sensitivity": 1, "smoothing": 0.6, "onsetThreshold": 1.5, "reactions": { "…": "…" } },
  "visualizer": { "stageWidth": 12, "stageDepth": 8 },
  "ai": { "notes": "", "recentPrompts": [] }
}
```

- Les valeurs d'attributs sont **normalisées de 0 à 1**. La conversion en DMX (8 ou 16 bits) se fait au rendu, selon le profil.
- Les profils intégrés sont référencés par leur `id`. Les profils importés sont **embarqués** dans `profiles`, ce qui garde le projet autonome.
- **Aucune clé API ni aucun secret** n'est stocké dans un projet (vérifié par un test).

## Versions et migrations
| Version | Contenu |
|---|---|
| 1 | Format interne initial : patch sous la clé `fixtures`, sans sections `audio` ni `visualizer`. |
| 2 | Clé `patch`, sections `audio` et `visualizer`. |
| 3 | Format actuel : section `music` (morceaux analysés, plans Song-to-Show, objets générés). Le son n'est jamais stocké, seulement l'analyse et l'empreinte SHA-256 du fichier. Les événements de timeline acceptent `fadeOut`. |

Les migrations sont appliquées en chaîne (`MIGRATIONS` dans [src/core/project/format.ts](../src/core/project/format.ts)), puis le résultat est validé. Un fichier d'une version **plus récente** que le logiciel est refusé avec un message explicite.

## Écriture et récupération
- **Écriture atomique** : écriture dans `fichier.tmp`, copie de l'ancien fichier en `fichier.bak`, puis renommage.
- **Sauvegarde automatique de récupération** : toutes les N minutes (2 par défaut), dans `<userData>/autosave/<id>.luma.json`, si des modifications ne sont pas enregistrées. Elle n'écrase jamais votre fichier.
- **Fichier corrompu** : JSON illisible, mauvais format ou données invalides. Le message indique la cause et les champs fautifs. Les copies `.bak` et autosave peuvent être ouvertes depuis *Settings › Sauvegardes*.
- **Export** : *Settings › Sauvegardes › Exporter une copie* écrit une copie sans changer le fichier courant. **Import** : ouvrir le fichier.
