# Bosch Alarm (Mode 2) pour Gladys

Cette intégration relie une centrale d'alarme **Bosch** à Gladys Assistant,
**en local** sur votre réseau, par le protocole d'automatisation
**« Mode 2 »** de Bosch : Solution 2000, 3000, 4000 (et 2100, 3100, 4100),
AMAX 2100, 3000, 4000, série B (B3512, B4512, B5512, B6512), série G
(B8512G, B9512G) et D7412GV4 / D9412GV4.

> **Jamais testé avec un vrai appareil.** Le protocole vient de la
> bibliothèque [bosch-alarm-mode2](https://github.com/mag1024/bosch-alarm-mode2)
> 0.4.11 (celle de l'intégration Bosch Alarm de Home Assistant), portée en
> JavaScript et vérifiée seulement contre une centrale simulée. Faites vos
> premiers essais en présence, centrale désarmée, et signalez ce qui ne va
> pas.
>
> Intégration non officielle, sans lien avec Bosch.

## Avant de commencer

- La centrale reliée à votre réseau (module réseau intégré ou B426 / B450 /
  module IP de la centrale), joignable depuis Gladys : donnez-lui une adresse
  fixe dans votre box.
- **L'automatisation (Mode 2) activée** sur la centrale par votre
  installateur (A-Link Plus, RPS ou Installer Services), avec son port (7700
  par défaut) et :
  - séries B, G et GV4 : un **code d'automatisation** ;
  - AMAX : un **code d'automatisation** et le **code installateur** ;
  - Solution : le **code d'un utilisateur** (pas de code d'automatisation).
- La centrale accepte un nombre limité de connexions d'automatisation : si un
  autre logiciel les prend toutes (Home Assistant, un autre Gladys…),
  l'intégration le dit et réessaie au plus tôt une minute plus tard.

## Ce que vous obtenez

Les secteurs, points et sorties sont ceux que la centrale déclare, avec leurs
noms.

- **Centrale Bosch** : connectée ou non, défaut en cours, coupure secteur,
  batterie faible ou absente (modèle, version et numéro de série en
  paramètres).
- **Un secteur par appareil** :
  - **État** en lecture seule : désarmé, armement en cours (temporisation de
    sortie), temporisation d'entrée, armé (total), armé (partiel) ;
  - **Armé**, **Prêt à armer** (centrales avec abonnement), **Alarme en
    cours** (secteur armé avec une alarme intrusion, gaz ou incendie en
    mémoire), **Mémoire alarme incendie** (jusqu'à son effacement au
    clavier) ;
  - trois **boutons** : armement total, armement partiel, désarmer.
- **Un point par appareil** : ouvert ou fermé (ouverture, mouvement, fumée
  ou fuite selon le type choisi).
- **Une sortie par appareil** : active ou non, et deux **boutons** : activer,
  désactiver.
- **Déclencheurs de scène** : alarme déclenchée (avec le point si la
  centrale le donne, et si c'est un incendie), secteur armé (mode, demandé par
  Gladys ou non), secteur désarmé.
- **Actions de scène** : armer (total ou partiel), désarmer.

Aucune commande n'est un interrupteur : un « éteins tout » d'un assistant
vocal, de HomeKit ou d'une scène ne peut ni désarmer l'alarme ni actionner
une sortie. Les états sont en lecture seule, les commandes sont des boutons.

## Configuration

1. **Adresse de la centrale** : l'adresse IP de son module réseau.
2. **Port d'automatisation** : 7700, sauf changement par votre installateur.
3. **Code d'automatisation** : séries B, G, GV4 et AMAX (inutile pour
   Solution).
4. **Code utilisateur (Solution) ou code installateur (AMAX)** : 8 chiffres
   au plus. Inutile pour les séries B et G. Pour Solution, créez un
   utilisateur dédié avec seulement les droits utiles à Gladys.
5. **Type des points** (facultatif) : par exemple `7:motion, 9-10:smoke,
12:leak`. Types : `opening` (ouverture, par défaut), `motion`
   (mouvement), `smoke` (fumée), `leak` (fuite d'eau). Changer le type d'un
   point déjà créé dans Gladys ajoute une nouvelle fonction et garde
   l'ancienne (et son historique) : supprimez l'ancienne à la main si vous
   n'en voulez plus.
6. **Sécurité** : voir plus bas.
7. **Langue des noms** : français ou anglais.

Les codes sont des champs secrets : gardés par Gladys dans sa base, jamais
réaffichés dans l'interface, envoyés seulement à la centrale. Ils
n'apparaissent jamais dans les journaux ni dans `/data`.

Le bouton **Tester la connexion** se connecte tout de suite si aucune
connexion n'est ouverte (sinon il attend celle en cours) et indique le
modèle, l'état des secteurs et le nombre de points et de sorties. Il ne
devance jamais un nouvel essai déjà prévu (attente après une coupure ou
« plus de connexion libre ») : il indique alors l'état en cours.

Le bouton **Autoriser un nouvel essai du code** lève l'arrêt posé après un
code refusé (voir « Sécurité ») : l'intégration se reconnecte une fois avec
les codes de la configuration.

## Ce qui circule sur le réseau

- La liaison avec la centrale passe par **TLS, sans vérification du
  certificat** de la centrale (comme Home Assistant : la centrale a un
  certificat auto-signé). Un appareil qui se contente d'écouter votre réseau
  ne lit pas les échanges ; un appareil capable de se faire passer pour la
  centrale sur votre réseau local pourrait recevoir les codes.
- Les codes sont envoyés à chaque connexion à la centrale.
- Protégez votre réseau (Wi-Fi invité séparé pour les appareils dont vous
  n'êtes pas sûr) et donnez à Gladys un code aux droits limités.

## Sécurité

- **Armer** est toujours permis, sans option : c'est une commande qui
  protège. Armer alors que quelqu'un est à l'intérieur (une scène mal
  réglée, une erreur) peut déclencher une fausse alarme, les sirènes et un
  appel de votre télésurveillance.
- **Désarmer est désactivé par défaut.** Une fois l'option cochée, **tout
  utilisateur de Gladys, toute scène et l'application mobile Gladys peuvent
  désarmer sans saisir aucun code**. Ne l'autorisez que si votre Gladys est
  bien protégé (comptes, accès à distance). Passer d'armé total à armé
  partiel baisse la protection : cela demande aussi cette option.
- **Les sorties sont désactivées par défaut**, derrière leur propre option :
  une sortie peut commander une sirène, un portail ou une serrure. Vérifiez
  d'abord ce que fait chacune.
- Les options sont relues juste avant chaque envoi : une option décochée
  pendant qu'une commande attend son tour bloque cette commande.
- Avant chaque commande, l'intégration **relit l'état sur la centrale** et
  décide sur cet état, jamais sur ce qu'elle a en mémoire (déjà dans l'état
  demandé : rien n'est envoyé ; temporisation d'entrée en cours : armement
  refusé). Les commandes passent une par une, dans l'ordre. Une commande
  dont le temps s'est épuisé en attendant son tour est refusée, rien n'est
  envoyé. Un armement passe avant les désarmements et sorties en attente,
  et retire un désarmement du même secteur, en attente ou en cours, tant
  qu'il n'est pas parti vers la centrale.
- Une commande qui ne peut pas partir dans les temps (centrale lente, état
  illisible) est refusée avec « rien n'a été envoyé ». Une commande partie
  sans réponse claire (pas de réponse, coupure) est annoncée « envoyée, sans
  confirmation » : la connexion est relancée aussitôt (environ 5 s) et l'état
  relu dès son retour ; elle n'est jamais annoncée « non envoyée ». Seul un
  refus de la centrale est annoncé « refusée » (droits insuffisants,
  armement impossible…).
- **Si la centrale refuse un code à la connexion, l'intégration s'arrête et
  ne le renvoie jamais d'elle-même**, même après un redémarrage (une centrale
  peut compter les codes faux et signaler une fraude au code). Il en va de
  même si la centrale ne répond pas clairement à la connexion deux fois de
  suite (connexion fermée, pas de réponse en 15 s, réponse illisible) : le
  code a pu être refusé. Changez un code dans la configuration, ou cliquez
  sur « Autoriser un nouvel essai du code » (un essai par clic). Le fichier
  `/data/bosch-alarm-state.json` garde seulement la date de l'arrêt, jamais
  un code ; l'arrêt tient même si l'adresse de la centrale change. Un
  fichier illisible compte comme un arrêt ; si l'arrêt ne peut pas être
  écrit, l'état de la connexion le dit.
- Chaque commande, envoyée ou refusée, est écrite dans les journaux de
  l'intégration, jamais les codes.

## Connexion

- Une seule connexion à la fois, jamais deux : au moins 5 secondes entre
  deux connexions.
- Sur une coupure, les nouveaux essais sont espacés : 10 s, 30 s, 1 min,
  2 min, puis toutes les 5 minutes ; au moins une minute quand la centrale
  n'a plus de connexion libre, cinq minutes pour un modèle inconnu. Une
  connexion qui tombe moins d'une minute après son ouverture compte comme
  un échec (les attentes s'allongent). Après une commande sans réponse, la
  connexion revient au bout d'environ 5 s.
- Les centrales qui le permettent envoient elles-mêmes chaque changement
  (abonnement) ; les autres sont relues toutes les 2 secondes. Tout est relu
  toutes les 10 minutes, les défauts chaque minute.
- Une demande toutes les 60 secondes de silence vérifie que la centrale
  répond toujours ; sans rien recevoir pendant 150 s, ou sans réponse à une
  demande, l'intégration se reconnecte.

## Limites connues

- Jamais testé avec un vrai appareil (voir plus haut).
- Pas de journal d'événements, pas de portes (contrôle d'accès des séries
  B et G), pas d'armement instantané, pas de réglage de l'heure dans cette
  version.
- « Prêt à armer » n'existe que sur les centrales qui envoient leurs
  changements (abonnement).
- Les sorties au-delà de 255 sont affichées mais ne peuvent pas être
  pilotées (la commande du protocole ne prend qu'un octet).
- Une alarme déjà en cours au démarrage de l'intégration ne déclenche pas de
  scène (seuls les changements vus le font).
- La mémoire d'alarme reste sur la centrale jusqu'à son effacement au
  clavier : réarmer un secteur dont la mémoire n'est pas effacée déclenche de
  nouveau « Alarme Bosch déclenchée » (comme dans Home Assistant). Effacez la
  mémoire au clavier après une alarme.
- Les trames de plus de 8 Ko sont refusées (connexion relancée).

## Confidentialité

Tout reste sur votre réseau : l'intégration ne parle qu'à la centrale.

## Licence

Apache-2.0. Logique de protocole portée de bosch-alarm-mode2 0.4.11 (MIT,
Michael Grigoriev) : voir `THIRD_PARTY_NOTICES.md`.
