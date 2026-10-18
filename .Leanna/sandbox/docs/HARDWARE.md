# Tester avec de vrais projecteurs

Ces étapes n'ont **pas** été réalisées pendant le développement : aucun matériel n'était disponible.

## Préparation
1. Créez un profil exact pour chaque modèle (à partir du manuel DMX du fabricant) et importez-le (voir [PROFILE_FORMAT.md](PROFILE_FORMAT.md)). Marquez `dangerous` les plages reset et lampe. Vérifiez la valeur « shutter ouvert » et les valeurs par défaut de pan/tilt.
2. Patchez chaque projecteur avec **le même mode et la même adresse** que ceux réglés sur l'appareil.
3. Réglez la politique de blackout adaptée à vos appareils (*Settings › Moteur & sécurité*).
4. Personne ne doit être exposé aux faisceaux, au strobe ou aux mouvements pendant les essais.

## Art-Net
1. Placez le PC sur le réseau du nœud (souvent `2.x.x.x` ou `10.x.x.x`, masque `255.0.0.0`).
2. *DMX Output › + Art-Net* : destination = IP du nœud (unicast recommandé) ou broadcast du sous-réseau, interface locale = IP du PC. Indiquez la correspondance univers local → Port-Address configurée sur le nœud.
3. *Armer* et confirmer. Vérifiez sur le nœud la LED ou la page d'état de réception, puis dans *Diagnostics* la cadence mesurée et l'absence d'erreurs.

## sACN / E1.31
1. *DMX Output › + sACN* : multicast (le commutateur doit transmettre le multicast, éventuellement avec IGMP snooping configuré) ou unicast vers l'IP du récepteur. Univers 1–63999, priorité 100 par défaut.
2. Après *Armer*, vérifiez la source affichée par le récepteur (nom « Luma AI DMX », CID visible dans *Settings › Réseau / DMX*).

## USB-DMX (Enttec DMX USB Pro uniquement)
1. Installez le pilote FTDI VCP, branchez l'interface, puis *DMX Output › Interfaces USB-DMX détectées › Rechercher*.
2. *+ USB-DMX* : choisissez le port (puce FTDI détectée = compatible possible, **non confirmé**), puis armez.
3. Débranchez le câble pendant l'émission : la sortie doit passer en **Erreur**, une alerte doit apparaître et la reconnexion doit être tentée.

## USB-DMX « Open DMX » (FTDI sans microcontrôleur)
1. Installez le pilote FTDI VCP. Le pilote doit accepter 250 000 bauds, ce qui est le cas du FT232R.
2. *DMX Output › + USB-DMX (Open DMX / FTDI)* : choisissez le port, gardez 30 images/s, puis armez.
3. Le break est généré par le logiciel (environ 1 ms, avec gigue). Si un récepteur clignote ou perd le signal, baissez la cadence ou utilisez une interface avec microcontrôleur (Enttec Pro, nœud Art-Net/sACN).

## Vérifications à faire
- Contrôlez canal par canal sur l'appareil (ou avec un testeur DMX) : moniteur « Transmis » = valeurs reçues.
- 16 bits : pan/tilt fins, dans le bon sens.
- STOP OUTPUT et blackout : observez le comportement **réel** de chaque appareil en cas de perte de signal.
- Mesurez la latence de bout en bout si elle est critique pour votre usage : l'application ne la mesure pas.
