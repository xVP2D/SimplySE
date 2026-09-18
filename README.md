# Console SELinux

Outil de gestion et de supervision SELinux distribué, sur le principe d'un
agent (façon Wazuh) : un agent Rust déployé sur chaque machine surveillée
collecte les logs SELinux (AVC denials) et applique les actions reçues
(mode enforcing/permissive, booléens, modules de policy) ; un serveur master
en Go centralise les événements et expose un dashboard web pour piloter la
flotte.

Voir `proto/selinux/v1/agent.proto` pour le contrat gRPC entre agent et
master, et le schéma d'architecture fourni en amont pour la vue d'ensemble.

## Arborescence

- `proto/` — contrat gRPC partagé (agent ⇄ master).
- `master/` — serveur Go : gRPC mTLS, NATS JetStream, Postgres, OpenSearch,
  API HTTP/JSON pour le dashboard.
- `agent/` — agent Rust : collecte des AVC (netlink audit ou tail
  d'audit.log), parsing, client gRPC mTLS, exécution des commandes
  (`setenforce`/`setsebool`/`semodule`/`chcon`).
- `frontend/` — dashboard React + Vite, sur le design system "Nocturne"
  (`frontend/public/styles.css`). Le mockup cliquable d'origine est conservé
  dans `frontend/design-reference/` à titre de référence UX.
- `deploy/` — `docker-compose.yml` (infra de dev) et le script de
  génération des certificats mTLS de dev.

## Prérequis

- Go ≥ 1.25, Rust (via `rustup`), Node ≥ 20, `protoc` avec
  `protoc-gen-go`/`protoc-gen-go-grpc` (`go install
  google.golang.org/protobuf/cmd/protoc-gen-go@latest` et
  `google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest`), Docker + Compose.

## Ports utilisés

| Service                 | Port par défaut | Variable de surcharge |
| ------------------------ | ---------------- | ---------------------- |
| Master — gRPC (mTLS)     | 8443             | `GRPC_ADDR` |
| Master — HTTP API        | 8080             | `HTTP_ADDR` |
| Postgres (docker)        | 5432             | `POSTGRES_HOST_PORT` (docker compose) + `POSTGRES_DSN` (master) |
| OpenSearch               | 9200             | `OPENSEARCH_PORT` (docker compose) + `OPENSEARCH_URL` (master) |
| NATS (client / monitor)  | 4222 / 8222      | `NATS_CLIENT_PORT` / `NATS_MONITOR_PORT` (docker compose) + `NATS_URL` (master) |
| Frontend (Vite dev)      | 5173             | `VITE_DEV_PORT` |

Si l'un de ces ports est déjà pris sur votre machine (c'était le cas sur la
machine de développement d'origine), passez la variable correspondante au
lieu de modifier les fichiers — par exemple
`POSTGRES_HOST_PORT=5433 docker compose -f deploy/docker-compose.yml up -d`
puis `GRPC_ADDR=:18443 HTTP_ADDR=:18080 POSTGRES_DSN=postgres://selinux:selinux@localhost:5433/selinux?sslmode=disable make master-run`.

## Installation en 2 commandes (machine cible réelle)

Pour un vrai déploiement (pas du dev local), voir
[`scripts/install-master.sh`](scripts/install-master.sh) et
[`scripts/install-agent.sh`](scripts/install-agent.sh) — chacun s'installe
en téléchargeant le script puis en l'exécutant :

```sh
# Sur la machine master :
curl -fsSLO https://raw.githubusercontent.com/xVP2D/SimplySE/main/scripts/install-master.sh
bash install-master.sh

# Sur chaque machine surveillée (agent) : install-master.sh affiche à la
# fin la commande ci-dessous déjà complétée (MASTER_ADDR + ENROLL_TOKEN) —
# les 3 certificats sont récupérés automatiquement depuis le master, sans
# copie manuelle :
curl -fsSLO https://raw.githubusercontent.com/xVP2D/SimplySE/main/scripts/install-agent.sh
MASTER_ADDR=https://<host-du-master>:8443 ENROLL_TOKEN=<jeton-affiché-par-install-master.sh> bash install-agent.sh
```

**Enrôlement automatique** : le master expose `GET /api/enroll/{ca.crt,agent.crt,agent.key}`
(texte brut, un fichier par requête — pas de JSON à parser côté script),
protégé par un jeton (`ENROLL_TOKEN`) généré aléatoirement à l'installation
du master et stocké dans `secrets.env` comme les autres secrets.
`install-agent.sh` dérive l'URL d'enrôlement depuis l'hôte de
`MASTER_ADDR` (port HTTP de l'API, 8080 par défaut — surchargeable via
`ENROLL_URL`/`ENROLL_HTTP_PORT`) et écrit les 3 fichiers reçus dans
`CERT_DIR` avec les permissions correctes. Si les certificats sont déjà
présents dans `CERT_DIR` (copiés à la main, ou script relancé), ils sont
réutilisés tels quels et `ENROLL_TOKEN` n'est pas nécessaire. Limite
connue : le jeton donne accès à une identité mTLS **partagée** par tous les
agents qui le présentent — ce n'est pas un enrôlement par agent individuel.

Dépôt : [github.com/xVP2D/SimplySE](https://github.com/xVP2D/SimplySE)
(public). `REPO_URL` dans les deux scripts pointe vers cette adresse par
défaut ; surchargez la variable d'environnement `REPO_URL` si vous
déployez depuis un fork ou un miroir interne.

Ces scripts détectent la distribution (apt/dnf/yum/zypper/pacman/apk),
installent Go/Rust si absents, compilent depuis les sources, installent un
service systemd (`selinux-fleet-master` / `selinux-fleet-agent`), et pour le
master démarrent l'infra via Docker Compose. Détails et limites connues
dans les en-têtes de chaque script.

**Prompts interactifs** : lancés depuis un vrai terminal, ils posent
quelques questions (répertoire d'install, ports — seulement si un port par
défaut semble déjà pris, adresse du master, id de l'agent, source des AVC,
confirmation avant d'installer Docker...). Toute question est court-circuitée
si la variable d'environnement correspondante est déjà positionnée, et
remplacée par sa valeur par défaut (ou une erreur explicite pour
`MASTER_ADDR`, qui n'a pas de défaut sûr) si l'entrée standard n'est pas un
terminal — donc toujours utilisable en automatisation/CI via
`VAR=... bash install-*.sh`.

**Résilience au crash/redémarrage de la VM** : les services systemd
(`selinux-fleet-master`/`selinux-fleet-agent`) utilisent `Restart=always` +
`StartLimitIntervalSec=0` (tentatives de redémarrage illimitées — sans ça,
le budget par défaut de systemd, 5 essais / 10 s, peut s'épuiser avant
qu'OpenSearch ait fini de démarrer et laisser le service en échec
permanent) ; les conteneurs Docker (Postgres/OpenSearch/NATS) ont
`restart: unless-stopped`, et NATS JetStream persiste maintenant sur un
volume nommé (`natsdata`, comme `pgdata`/`osdata`) — testé en conditions
réelles : un message publié avant suppression forcée du conteneur NATS
(pas juste un restart) est bien retrouvé après recréation. Ceci couvre la
reprise après crash sur **une seule VM**, pas une vraie haute
disponibilité multi-nœuds (plusieurs masters, réplication Postgres,
cluster NATS/OpenSearch) — un chantier d'architecture distinct.

**Gestion des secrets** : `install-master.sh` génère aléatoirement les mots
de passe Postgres et OpenSearch (`openssl rand`) — jamais de valeur fixe
committée, jamais demandés à l'opérateur, jamais affichés à l'écran ni dans
les logs. Ils sont écrits une seule fois dans
`/etc/selinux-fleet-manager/secrets.env` (mode `600`, root uniquement) et
réutilisés tels quels si le script est relancé. Les clés privées TLS
générées par `deploy/scripts/gen-certs.sh` sont maintenant systématiquement
passées en `chmod 600` ; `install-agent.sh` retightene aussi les
permissions des certificats copiés depuis le master, au cas où le transfert
(scp, partage réseau...) les aurait desserrées.

## Démarrage rapide (dev local, depuis un clone)

```sh
# 1. Certificats mTLS de dev (une seule fois)
make certs

# 2. Infra : NATS JetStream, Postgres, OpenSearch
make infra-up

# 3. Master (depuis la racine du repo : les chemins par défaut, certs et
#    schéma SQL embarqué, sont relatifs à la racine)
make master-run

# 4. Agent — sur la machine surveillée réelle (VM SELinux), ou en local
#    pour tester la plomberie avec un audit.log de test :
AUDIT_LOG_PATH=/tmp/audit.log \
BUFFER_PATH=/tmp/selinux-agent-buffer.jsonl \
MASTER_ADDR=https://<host-du-master>:8443 \
AGENT_ID=<identifiant-unique> \
make agent-run

# 5. Frontend
make frontend-install   # une fois
make frontend-dev       # http://localhost:5173
```

## Ce qui fonctionne dans ce vertical slice

- Un agent s'enrôle auprès du master via un flux gRPC bidirectionnel mTLS
  unique (`AgentLink.Session`), envoie heartbeat + événements AVC, reçoit des
  commandes et les acquitte.
- **Collecte des AVC** : `AUDIT_SOURCE` choisit la source —
  `file` (défaut, tail de `/var/log/audit/audit.log`),
  `netlink` (lecture directe du groupe multicast `AUDIT_NLGRP_READLOG` du
  socket audit du noyau — temps réel, fonctionne sans auditd, nécessite
  `CAP_AUDIT_READ`), ou `auto` (essaie netlink puis se rabat sur le fichier
  si le socket ne peut pas être ouvert, ex. capacité manquante ou
  environnement restreint). Les deux sources produisent le même format de
  ligne, parsé par le même analyseur (`agent/src/collector/parser.rs`).
- Le master relaie heartbeats/AVC via NATS JetStream vers Postgres (agents,
  règles, commandes) et OpenSearch (événements AVC bruts).
- Dashboard : agents en ligne/hors ligne, mode enforcing/permissive/disabled,
  signatures AVC les plus fréquentes (compteur en mémoire), déploiements
  récents, alertes ouvertes.
- Page Agents : inventaire, sélection multiple, "Passer en permissive"
  groupé, dialogue de déploiement de règle (mode, booléen, ou contexte de
  fichier via `chcon` — type seul ou `-R` récursif).
- Page détail agent : infos, denials récents (OpenSearch).
- Page Denials : recherche plein texte (OpenSearch `multi_match`), filtre par
  agent, pagination.
- Page Déploiements : historique des commandes, filtre par agent/statut,
  pagination.
- Page Alertes : le moteur de règles détecte deux conditions simples sur les
  signatures AVC observées — signature jamais vue (`new_signature`) et
  franchissement d'un seuil d'occurrences fixe 10/50/100/500 (`threshold`) —
  et les persiste en base ; acquittement depuis l'UI (`POST
  /api/alerts/{id}/ack`).
- Page Conformité : score de conformité par agent et pour la flotte, calculé
  côté frontend (`frontend/src/lib/compliance.ts`) à partir de ce que le
  master sait déjà — mode enforcing, joignabilité, politique `targeted`,
  absence d'alerte ouverte. Volontairement présenté comme des
  "vérifications de base", pas un référentiel type CIS.
- **Idempotence de `POST /api/rules/deploy`** : un header `Idempotency-Key`
  (optionnel) fait rejouer la réponse d'origine plutôt que de redéployer une
  règle en cas de retry (timeout réseau, etc.), et rejette (`409`) une même
  clé réutilisée avec un corps différent ou déjà en cours de traitement
  ailleurs (voir `postgres.BeginIdempotentRequest` / table
  `idempotency_keys`). Le frontend génère une clé stable par tentative
  (`crypto.randomUUID()`), régénérée dès qu'un champ du formulaire change.
- Reconnexion automatique de l'agent avec tampon disque si le master est
  injoignable.

## Corrélation avec un SIEM/EDR/supervision externe (optionnel)

Plutôt que de dupliquer la collecte de logs applicatifs/auth dans l'agent
(ce qui alourdirait le stockage/l'indexation pour des données que ces
outils collectent déjà, souvent avec une bien plus grande rétention), le
**master** peut interroger à la demande un SIEM/EDR/outil de supervision déjà
déployé — jamais en ingestion continue, uniquement pour la fenêtre de temps
d'un denial précis qu'un opérateur consulte (voir `master/internal/correlate`).
Rien de ce qui est lu n'est réécrit dans Postgres/OpenSearch : c'est une
requête à la volée, affichée puis oubliée.

Deux connecteurs, tous deux optionnels, **configurés depuis le dashboard**
(page **Paramètres**, `/settings`) plutôt que par variables d'environnement :
un formulaire par connecteur (URL, identifiants, options), un bouton
« Tester la connexion » (utilise la méthode `Ping()` du connecteur avant
d'enregistrer quoi que ce soit), et un bouton « Enregistrer ». La
configuration est stockée côté master dans Postgres (`integration_settings`,
en clair — même compromis que `/etc/selinux-fleet-manager/secrets.env`) et
appliquée à chaud : `correlate.Registry.SetSources` est rappelé juste après
chaque sauvegarde, donc un changement prend effet immédiatement, sans
redémarrer `selinux-fleet-master`. Le mot de passe/jeton n'est jamais
renvoyé par `GET /api/integrations` (seulement `password_set`/`token_set`) ;
le laisser vide en enregistrant conserve la valeur déjà stockée.

- **SIEM / EDR (OpenSearch-compatible)** : connecteur générique compatible
  OpenSearch/Elasticsearch. C'est ce qui permet d'atteindre **Wazuh**
  directement (son indexeur est OpenSearch/Elasticsearch depuis la 4.x —
  pointer l'index sur `wazuh-alerts-*`) et tout aussi bien une pile
  **Suricata** dont le `eve.json` est expédié vers une stack ELK/OpenSearch —
  même code, juste un index et un nom de champ différents. Mécanisme vérifié
  en conditions réelles contre un vrai cluster OpenSearch avec un document au
  format Wazuh (`agent.ip`, `@timestamp`, `rule.description`, `rule.level`).
- **LibreNMS** : connecteur REST (`/api/v0/alerts`, filtré côté master par
  hôte et fenêtre de temps). Implémenté d'après l'API documentée, non testé
  contre une instance LibreNMS réelle (aucune disponible dans cet
  environnement) — à valider avant un usage en production.

Le dashboard expose ceci sur la page détail d'un agent : chaque denial
peut être déplié pour voir, en plus de sa ligne brute, les événements
externes survenus dans les ±60s autour de lui (`GET
/api/agents/{id}/correlate?around=<unix>&window=<secondes>`) — de quoi
distinguer un vrai comportement malveillant (repéré côté SIEM/EDR au même
moment) d'un faux positif de politique (une appli légitime qui a juste
besoin d'un booléen SELinux). Le bouton reste caché si aucun connecteur
n'est configuré (`GET /api/correlate/sources`).

Pour ajouter un autre outil (LibreNMS mis à part, quasiment tout ce qui
expose une recherche compatible OpenSearch/Elasticsearch passe déjà par le
connecteur générique) : implémenter l'interface `correlate.Source`
(`Query(ctx, ip, hostname, around, window) ([]Event, error)`) et
l'enregistrer dans `cmd/master/main.go`.

## Un denial disparaît dès qu'une règle l'autorise

Quand une règle rend un denial autorisé, ce denial **et ses occurrences**
disparaissent de la page Denials, de la Matrice, de la Tendance et du
tableau « Signatures les plus fréquentes » du dashboard — quelle que soit la
façon dont la règle est arrivée : règle déployée depuis le dashboard
(booléen, module, contexte de fichier), suggestion approuvée, ou
modification faite **à la main sur la machine** (`setsebool`, `semodule`,
`chcon`, `semanage`…).

Le master ne devine pas : il **demande à l'agent** si le denial serait encore
refusé maintenant (messages gRPC `CheckDenials` / `DenialsChecked`). L'agent
répond d'après la politique **réellement chargée dans le noyau** de la machine
(interface `selinuxfs` `access`, sans `sesearch` ni outil externe), donc en
tenant compte des modules, de l'état des booléens et de l'**étiquette actuelle**
du fichier concerné. Déclencheurs : immédiatement après l'accusé d'un
`set_boolean` / `install_module` / `chcon` (≈ 3 s), et un balayage toutes les
30 s pour tout ce qui est fait hors de l'outil (≈ 20-30 s).

- **Regroupement** : les événements identiques (source, cible, classe,
  permissions, chemin) partagent une signature `sig` ; une seule question par
  signature et par agent, quel que soit le nombre d'occurrences (un orage de
  23 000 denials = une sonde). Au plus 300 signatures par agent et par balayage,
  les plus récentes d'abord.
- **Résolu = masqué, pas supprimé** : les événements reçoivent `resolved:true`
  (comme la quarantaine, ils sont exclus de tous les affichages). Si la règle
  est retirée plus tard et que l'accès est de nouveau refusé, ce sont de
  **nouveaux** événements, qui s'affichent normalement.
- **Chemin du fichier** : un AVC de lecture ne porte que le nom de base ; l'agent
  attache le chemin complet en corrélant l'AVC avec l'enregistrement `PATH` du
  même événement d'audit (même numéro de série, même inode). C'est ce qui permet
  de reconnaître qu'un `chcon`/`restorecon` a réparé un denial.
- **Limites** : un denial sans chemin ni inode ne peut pas être reconnu comme
  réparé par un simple changement d'étiquette (seuls les changements de
  politique — module, booléen — comptent) ; une machine hors ligne n'est
  interrogée qu'à sa reconnexion ; les agents antérieurs à cette fonction
  ignorent la question (leurs denials restent affichés) — les mettre à jour.

## Collecter tous les denials d'un domaine

Corriger un denial n'en révèle souvent qu'un autre : SELinux ne signale que
le premier refus de chaque opération, donc un domaine bloqué à plusieurs
endroits demande une approbation à la fois, au compte-gouttes (`search`,
puis `addname`, puis `create`, puis `open`...).

Sur chaque denial, le bouton **Collecter ce domaine** (avec un préréglage de
durée : 5/10/30/60 min) rend le domaine **temporairement permissif** sur
cette seule machine : plus rien n'est bloqué le temps de la fenêtre, tout est
journalisé, puis une **seule** suggestion couvre tout ce qui a été observé et
le domaine revient à enforced. Confirmation obligatoire avant de lancer
(l'action affecte une vraie machine, même temporairement) ; une page agent
affiche les collectes en cours (avec arrêt anticipé) et terminées (lien vers
la suggestion).

Le retour à enforced **ne dépend jamais du master** : l'agent garde sa propre
échéance sur disque
(`/var/lib/selinux-fleet-manager/permissive.json`) et la fait respecter
lui-même, y compris après son propre redémarrage — même si le master est
injoignable entre-temps. Un domaine déjà permissif avant la collecte n'est
jamais touché, ni au démarrage ni à l'arrêt. Domaines refusés d'office :
`kernel_t`, `init_t` (toute la machine perdrait son confinement). Pendant la
fenêtre, les suggestions automatiques par permission sont mises en pause
pour ce domaine — la collecte les remplace par une seule suggestion globale.

## Supprimer une règle appliquée (annulation réelle)

Le bouton **Supprimer** d'une ligne de « Règles appliquées » (page agent) ou
de la page Déploiements **annule réellement la règle sur la machine**, puis
retire la ligne une fois que l'agent l'a confirmé (`POST
/api/commands/{id}/revert`, asynchrone : 202). Ce qui est exécuté :

| Règle | Annulation | Remarque |
| --- | --- | --- |
| `install_module` | `semodule -r <nom>` | seulement si le module n'était pas déjà installé avant (sinon on supprimerait un module existant au lieu de restaurer l'ancien) |
| `chcon` | `restorecon [-R] <chemin>` | remet le contexte **par défaut de la politique**, pas forcément celui d'avant le `chcon` |
| `set_boolean` | `setsebool -P <nom> <valeur d'avant>` | valeur lue dans le dernier inventaire de l'agent (≤ 60 s) |
| `set_mode` | `setenforce <mode d'avant>` | mode d'avant lu au dernier heartbeat |

La valeur « d'avant » est mémorisée par le master au moment du déploiement
(colonne `commands.undo_json`) ; les règles appliquées avant cette
fonctionnalité n'en ont pas : seuls les `chcon` et les modules générés
(`suggested_*`) restent annulables, les anciens `set_mode`/`set_boolean`
apparaissent avec un bouton grisé et l'explication en infobulle. Cas gérés :
commande jamais appliquée (`failed`/`pending`) → simple retrait de la ligne ;
agent hors ligne → refusé (409) ; annulation déjà en cours → refusé (409,
garde SQL d'unicité) ; annulation échouée → la règle et l'erreur restent
visibles, on peut réessayer ; agent sans réponse → l'annulation expire au
bout de 2 min et peut être relancée. Côté agent l'annulation est idempotente
(module déjà retiré / chemin disparu = succès). Deux nouveaux types de
commande gRPC : `REMOVE_MODULE` et `RESTORECON`.

## Quarantaine et suppression de denials

Sur la page **Denials**, chaque ligne a un bouton **Quarantaine** et un bouton
**Supprimer**. Un denial mis en quarantaine (champ `quarantined: true` sur son
document OpenSearch) disparaît de la liste, de la Matrice et de la Tendance et
apparaît sur la page **Quarantaine**, d'où on peut le **Restaurer** ou le
**Supprimer** définitivement. Endpoints : `POST /api/denials/quarantine` et
`/restore` (corps `{index, id}`), `DELETE /api/denials/{index}/{id}`. L'index
et l'id sont validés (seuls les documents `avc_events[-YYYY.MM.dd]` sont
atteignables). Ne touche pas le compteur « signatures les plus fréquentes » du
dashboard, qui vient des compteurs en mémoire du moteur de règles.

## Volumétrie : dimensionner pour un gros volume de denials

Le composant qui détermine la capacité réelle du système, c'est
**OpenSearch** (où vivent les événements AVC bruts) — le master, Postgres et
NATS restent légers quel que soit la taille de la flotte.

- **Mémoire (heap JVM)** : `OPENSEARCH_JAVA_OPTS` dans
  `deploy/docker-compose.yml` prend désormais `OPENSEARCH_HEAP_SIZE`
  (défaut `1536m`, dimensionné pour une petite VM de lab). Règle de
  dimensionnement d'OpenSearch : heap ≈ 50 % de la RAM du nœud, plafonné à
  ~32 Go (au-delà, la JVM perd le bénéfice des "compressed oops" et plus de
  heap devient contre-productif). Sur un nœud dédié à un gros volume,
  augmenter cette variable plutôt que modifier le fichier.
- **Rétention automatique** : les événements AVC sont désormais indexés
  dans un index quotidien (`avc_events-YYYY.MM.dd`, voir
  `internal/store/opensearch`) plutôt qu'un unique index qui grossissait
  indéfiniment. Au démarrage, le master applique automatiquement (de façon
  idempotente, à chaque redémarrage) une politique ISM
  (`avc-events-retention`) qui supprime chaque index quotidien une fois
  qu'il dépasse `OPENSEARCH_AVC_RETENTION_DAYS` jours (défaut **30**) — plus
  besoin de purge manuelle ni de job de nettoyage externe. Les anciennes
  données déjà présentes dans l'index fixe historique `avc_events` restent
  lisibles (Denials/Matrice/Trend interrogent les deux), mais cet index
  n'est plus jamais écrit et n'est pas concerné par la politique de
  rétention (à purger manuellement si besoin). Détail ISM à connaître :
  le `ism_template` d'une politique ne s'applique qu'aux index créés
  *après* sa dernière mise à jour, et le master la réécrit à chaque
  démarrage — il attache donc aussi explicitement la politique aux index
  `avc_events-*` déjà existants (sinon un index créé peu avant un
  redémarrage ne serait jamais géré). La découverte d'un nouvel index par
  ISM prend jusqu'à ~15 min (balayage toutes les 10 min, index de ≥ 5 min).
- **Disque** : prévoir large — l'indexation est intensive en écritures
  aléatoires, du SSD/NVMe est recommandé dès que le volume de denials
  monte. Le besoin dépend directement de
  `volume quotidien de denials × OPENSEARCH_AVC_RETENTION_DAYS`.
- **Nœud unique vs cluster** : `discovery.type: single-node` reste adapté
  tant qu'un seul nœud suffit en CPU/IO. Le template d'index créé par
  `EnsureRetentionPolicy` fixe `number_of_replicas: 0` (une réplique sur un
  seul nœud reste indéfiniment non assignée et bloque la santé du cluster
  en "yellow") — à revoir en même temps qu'un vrai passage multi-nœuds.

La corrélation SIEM/EDR/LibreNMS (section précédente) n'ajoute rien à ce
budget : elle interroge à la demande, jamais en ingestion continue.

## Simplifications connues (itérations suivantes)

- **Enrôlement** : un seul certificat client mTLS partagé
  (`deploy/certs/agent-dev.{crt,key}`) pour tous les agents en dev — pas
  encore de flux d'émission de certificat par agent.
- **Moteur de règles** : le compteur de signatures qui alimente
  "Signatures les plus fréquentes" et les alertes est en mémoire (perdu au
  redémarrage du master) ; les alertes déjà créées, elles, sont persistées en
  Postgres. Pas de détection statistique (baseline, écart-type) — seuils fixes
  uniquement.
- **Conformité** : les 4 vérifications sont dérivées de données déjà
  disponibles côté master ; aucun vrai référentiel (CIS ou autre) n'est
  implémenté, et l'agent ne collecte pas encore de faits supplémentaires
  (paquets installés, permissions fichiers, etc.) qu'un vrai bench
  demanderait.
- **Reprise de commandes** : une commande créée pendant qu'un agent est
  déconnecté reste `pending` en base ; rien ne la renvoie automatiquement à
  la reconnexion pour l'instant.

## Tester le round-trip commande (sans risque)

Pour valider agent ⇄ master sans toucher au mode SELinux réel de la machine
de test, déployez un booléen inexistant (échoue proprement, sans effet de
bord) :

```sh
curl -X POST http://localhost:8080/api/rules/deploy \
  -H "Content-Type: application/json" \
  -d '{"name":"test","type":"set_boolean","payload_json":"{\"name\":\"a_boolean_that_does_not_exist\",\"value\":true}","agent_ids":["<agent_id>"]}'
```
