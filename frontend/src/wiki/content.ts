import type { Locale } from "../i18n";

export type WikiBlock =
  | { type: "p"; text: string }
  | { type: "h3"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "dl"; items: [string, string][] } // term, definition
  | { type: "code"; text: string };

export interface WikiSection {
  id: string;
  title: string;
  blocks: WikiBlock[];
}

const fr: WikiSection[] = [
  {
    id: "overview",
    title: "Vue d'ensemble",
    blocks: [
      {
        type: "p",
        text: "Cet outil est un gestionnaire de flotte SELinux dans l'esprit de Wazuh : un petit agent (écrit en Rust) tourne sur chaque machine surveillée, collecte les refus SELinux («denials») et applique des actions reçues du master ; un serveur central (le master, en Go) centralise tout et pilote ce dashboard.",
      },
      {
        type: "p",
        text: "Architecture : agent ↔ (gRPC + mTLS, une connexion persistante par agent) ↔ master ↔ Postgres (agents, règles, commandes, alertes) + OpenSearch (journal brut des denials, fort volume) + NATS JetStream (file d'attente interne entre réception et traitement).",
      },
      {
        type: "p",
        text: "Principe de sécurité central, qui vaut pour tout le reste de ce wiki : aucune action n'est jamais appliquée sur un agent sans une commande explicite envoyée par le master. Les suggestions de règles générées automatiquement (voir «Déployer des règles») ne sont jamais installées seules — il faut toujours une validation humaine explicite dans le dashboard.",
      },
    ],
  },
  {
    id: "glossary",
    title: "Glossaire SELinux",
    blocks: [
      {
        type: "dl",
        items: [
          [
            "Contexte SELinux",
            "L'étiquette de sécurité appliquée à un processus ou un fichier, sous la forme utilisateur:rôle:type:niveau (ex. system_u:system_r:httpd_t:s0). C'est ce que SELinux utilise pour décider si une action est autorisée — pas les permissions Unix classiques (rwx).",
          ],
          [
            "Type (le champ le plus utile au quotidien)",
            "Le 3e champ du contexte (ex. httpd_t pour le serveur web, user_home_t pour un fichier personnel). Presque toutes les règles de policy s'écrivent en termes de types, pas de fichiers ou processus précis.",
          ],
          [
            "AVC / denial",
            "«Access Vector Cache» — le mécanisme noyau qui décide d'autoriser ou refuser une action, et journalise chaque refus («denial»). C'est ce que cet outil collecte en continu.",
          ],
          [
            "tclass (classe d'objet)",
            "Le type de la cible visée : file, dir, process, tcp_socket, dbus, filesystem… Une même paire de types peut donner lieu à des règles différentes selon la classe.",
          ],
          [
            "perms (permissions)",
            "L'action précise refusée pour cette classe : read, write, execute, entrypoint, connectto… Une denial peut lister plusieurs permissions à la fois.",
          ],
          [
            "Booléen SELinux",
            "Un interrupteur on/off qui active ou désactive toute une famille de règles déjà présentes dans la policy, sans avoir besoin de compiler quoi que ce soit (ex. httpd_can_network_connect). Toujours préférable à un module personnalisé quand un booléen existe déjà pour le besoin.",
          ],
          [
            "Module de policy (.te / .pp)",
            ".te est le texte source lisible d'un module de policy ; .pp est sa version compilée, installable avec semodule -i. C'est ce que génère audit2allow et ce que ce dashboard déploie une fois approuvé.",
          ],
          [
            "enforcing / permissive / disabled",
            "enforcing bloque réellement les actions refusées ; permissive les autorise quand même mais les journalise (utile pour tester) ; disabled coupe SELinux entièrement — à éviter, y compris temporairement, car cela supprime toute protection, pas seulement pour l'action en cause.",
          ],
          [
            "Politique targeted",
            "La policy standard sur la plupart des distributions : seuls certains services sensibles sont confinés dans un type dédié, le reste tourne en unconfined_t (largement non restreint).",
          ],
          [
            "semanage fcontext",
            "Associe un chemin de fichier (avec motif) à un contexte par défaut, de façon persistante — ce que restorecon applique ensuite sur le disque. Utile après avoir déplacé des fichiers en dehors de leur emplacement standard.",
          ],
          [
            "restorecon",
            "Réapplique aux fichiers sur disque les contextes définis par semanage fcontext. À exécuter après toute modification de fcontext, ou pour corriger un contexte qui a dérivé.",
          ],
          [
            "audit2allow",
            "Outil qui lit des lignes de log AVC et génère une règle de policy minimale qui les aurait autorisées. Un excellent point de départ, jamais une vérité absolue — toujours relire la règle générée avant de l'installer.",
          ],
        ],
      },
    ],
  },
  {
    id: "pages",
    title: "Guide des pages du dashboard",
    blocks: [
      {
        type: "dl",
        items: [
          ["Dashboard", "Vue d'ensemble du parc : agents en ligne/hors ligne, répartition enforcing/permissive/disabled, signatures de denials les plus fréquentes, déploiements récents, alertes ouvertes, score de conformité."],
          ["Agents", "Inventaire complet, sélection multiple, actions groupées («Passer en permissive», déployer une règle sur plusieurs machines à la fois)."],
          ["Détail d'un agent", "Infos système, bascule enforcing/permissive en un clic, règles déjà appliquées, booléens et modules SELinux (avec bascule directe d'un booléen), fichiers surveillés pour la détection de dérive, et les denials récents — chacune avec son explication en langage clair et, si un SIEM externe est configuré, les événements corrélés survenus dans la même fenêtre de temps."],
          ["Denials", "Recherche plein texte sur tout l'historique des refus SELinux (commande, chemin, contexte…), filtrable par agent."],
          ["Matrice", "Vue agrégée sur tout le parc, groupée par signature (source → cible, classe). Le nombre d'hôtes touchés par une même signature est la donnée clé : si plusieurs machines partagent le même problème, une seule règle bien ciblée suffit — pas besoin de traiter au cas par cas."],
          ["Déploiements", "Historique de toutes les commandes envoyées aux agents (mode, booléen, contexte de fichier, module), avec leur statut."],
          ["Suggestions", "Règles générées automatiquement par audit2allow dès qu'une nouvelle signature de denial apparaît — à relire puis approuver (avec déploiement immédiat sur les hôtes choisis) ou rejeter."],
          ["Alertes", "Nouvelle signature jamais vue, fréquence anormale, passage en permissive, ou dérive de configuration détectée."],
          ["Conformité", "Score basique par agent et pour la flotte (mode enforcing, agent joignable, politique targeted, absence d'alerte ouverte) — volontairement présenté comme des vérifications de base, pas un référentiel type CIS."],
        ],
      },
    ],
  },
  {
    id: "deploying",
    title: "Déployer des règles depuis ce dashboard",
    blocks: [
      { type: "h3", text: "Mode SELinux (enforcing / permissive)" },
      { type: "p", text: "Bascule instantanée depuis la page détail d'un agent, ou en masse depuis la page Agents. Utile pour diagnostiquer un problème (repasser temporairement en permissive) — à réactiver en enforcing dès le diagnostic terminé : le dashboard vous alertera de toute façon si un hôte reste en permissive." },
      { type: "h3", text: "Booléen" },
      { type: "p", text: "On/off, appliqué de façon persistante (équivalent à setsebool -P). Ne nécessite aucune compilation — toujours l'option la plus simple quand un booléen existant couvre le besoin." },
      { type: "h3", text: "Contexte de fichier (chcon)" },
      { type: "p", text: "Applique un type seul ou un contexte complet à un chemin, avec option récursive. Pour un changement permanent qui doit survivre à un restorecon, préférez ajouter la règle via semanage fcontext directement sur l'hôte." },
      { type: "h3", text: "Module de policy (via les suggestions audit2allow)" },
      {
        type: "p",
        text: "Dès qu'une signature de denial jamais vue apparaît, le master demande automatiquement à l'agent concerné de faire tourner audit2allow dessus — jamais appliqué seul. La suggestion apparaît sur la page Suggestions avec le texte .te lisible. L'opérateur la relit, choisit les machines cibles, puis «Approuver et déployer» pousse le module compilé (.pp) exactement via la même commande qu'un déploiement manuel de module. «Rejeter» ne déploie rien.",
      },
    ],
  },
  {
    id: "alerts",
    title: "Alertes, sévérité et dérive de configuration",
    blocks: [
      { type: "p", text: "Chaque denial reçoit une sévérité (basse/moyenne/haute) — haute si elle touche un service considéré critique (SSH, serveur web, sudo, bases de données…), sans que cela signifie automatiquement une attaque : une simple mise à jour logicielle explique très souvent une nouvelle denial sur un service sensible." },
      {
        type: "dl",
        items: [
          ["Nouvelle signature", "La première fois qu'une combinaison source → cible → classe est observée sur tout le parc."],
          ["Fréquence anormale", "Une même signature dépasse un seuil d'occurrences fixe (10, 50, 100, puis 500)."],
          ["Passage en permissive", "Un agent vient de quitter le mode enforcing — perte réelle d'application des règles sur cet hôte, à traiter rapidement."],
          ["Dérive de configuration", "Un fichier surveillé (/etc/selinux/config, ou les contextes de fichiers ajoutés localement) a changé en dehors d'un déploiement de ce master — signe d'une intervention manuelle non tracée, ou d'une restauration de sauvegarde qui a ramené une configuration plus ancienne."],
        ],
      },
    ],
  },
  {
    id: "best-practices",
    title: "Bonnes pratiques",
    blocks: [
      {
        type: "ul",
        items: [
          "Préférez toujours un booléen existant à un module de policy personnalisé quand c'est possible — plus simple à auditer, à retirer, et à comprendre pour la personne suivante.",
          "Ne désactivez jamais complètement SELinux, même temporairement face à un grand nombre de denials — passez en permissive le temps de diagnostiquer, puis revenez en enforcing.",
          "Relisez toujours le texte .te d'un module suggéré avant de l'approuver, comme vous relieriez un diff de code : il décrit exactement ce qui sera désormais autorisé, de façon permanente.",
          "Avant de corriger une denial au cas par cas sur une seule machine, vérifiez la Matrice : si plusieurs hôtes partagent la même signature, une seule règle bien ciblée, déployée partout où c'est nécessaire, vaut mieux que des correctifs dispersés.",
          "Si un SIEM/EDR est configuré (voir la section correspondante dans le README du projet), utilisez la corrélation disponible sur chaque denial pour distinguer un vrai comportement suspect d'un simple manque de règle de policy.",
        ],
      },
    ],
  },
];

const en: WikiSection[] = [
  {
    id: "overview",
    title: "Overview",
    blocks: [
      {
        type: "p",
        text: "This tool is a SELinux fleet manager in the spirit of Wazuh: a small agent (written in Rust) runs on each monitored machine, collects SELinux denials, and applies actions received from the master; a central server (the master, in Go) centralizes everything and drives this dashboard.",
      },
      {
        type: "p",
        text: "Architecture: agent ↔ (gRPC + mTLS, one persistent connection per agent) ↔ master ↔ Postgres (agents, rules, commands, alerts) + OpenSearch (raw high-volume denial log) + NATS JetStream (internal queue between ingestion and processing).",
      },
      {
        type: "p",
        text: "The central security principle behind everything else in this wiki: no action is ever applied on an agent without an explicit command sent by the master. Automatically-generated rule suggestions (see «Deploying rules») are never installed on their own — an explicit human approval in the dashboard is always required.",
      },
    ],
  },
  {
    id: "glossary",
    title: "SELinux glossary",
    blocks: [
      {
        type: "dl",
        items: [
          [
            "SELinux context",
            "The security label applied to a process or file, shaped as user:role:type:level (e.g. system_u:system_r:httpd_t:s0). This is what SELinux uses to decide whether an action is allowed — not classic Unix permissions (rwx).",
          ],
          [
            "Type (the field that matters day to day)",
            "The 3rd field of the context (e.g. httpd_t for the web server, user_home_t for a personal file). Almost every policy rule is written in terms of types, not specific files or processes.",
          ],
          [
            "AVC / denial",
            "«Access Vector Cache» — the kernel mechanism that decides to allow or deny an action, and logs every denial. This is what this tool continuously collects.",
          ],
          [
            "tclass (object class)",
            "The kind of the target: file, dir, process, tcp_socket, dbus, filesystem… The same pair of types can lead to different rules depending on the class.",
          ],
          [
            "perms (permissions)",
            "The precise action that was denied for that class: read, write, execute, entrypoint, connectto… A single denial can list several permissions at once.",
          ],
          [
            "SELinux boolean",
            "An on/off switch that enables or disables a whole family of rules already present in the policy, with no compilation needed (e.g. httpd_can_network_connect). Always prefer an existing boolean over a custom module when one already covers the need.",
          ],
          [
            "Policy module (.te / .pp)",
            ".te is the human-readable source of a policy module; .pp is its compiled form, installable with semodule -i. This is what audit2allow generates and what this dashboard deploys once approved.",
          ],
          [
            "enforcing / permissive / disabled",
            "enforcing actually blocks denied actions; permissive still allows them but logs them (useful for testing); disabled turns SELinux off entirely — avoid this, even temporarily, since it removes all protection, not just for the action at hand.",
          ],
          [
            "Targeted policy",
            "The standard policy on most distributions: only certain sensitive services are confined to a dedicated type, everything else runs as unconfined_t (largely unrestricted).",
          ],
          [
            "semanage fcontext",
            "Persistently associates a file path (with a pattern) with a default context — what restorecon later applies on disk. Useful after moving files outside their standard location.",
          ],
          [
            "restorecon",
            "Re-applies the contexts defined by semanage fcontext to files on disk. Run it after any fcontext change, or to fix a context that has drifted.",
          ],
          [
            "audit2allow",
            "A tool that reads AVC log lines and generates a minimal policy rule that would have allowed them. A great starting point, never an absolute truth — always review the generated rule before installing it.",
          ],
        ],
      },
    ],
  },
  {
    id: "pages",
    title: "Dashboard pages guide",
    blocks: [
      {
        type: "dl",
        items: [
          ["Dashboard", "Fleet overview: online/offline agents, enforcing/permissive/disabled breakdown, most frequent denial signatures, recent deployments, open alerts, compliance score."],
          ["Agents", "Full inventory, multi-select, bulk actions («Set to permissive», deploy a rule to several machines at once)."],
          ["Agent detail", "System info, one-click enforcing/permissive toggle, rules already applied, SELinux booleans and modules (with a direct boolean toggle), watched files for drift detection, and recent denials — each with a plain-language explanation and, if an external SIEM is configured, correlated events from the same time window."],
          ["Denials", "Full-text search across the entire denial history (command, path, context…), filterable by agent."],
          ["Matrix", "Fleet-wide aggregated view, grouped by signature (source → target, class). How many hosts share the same signature is the key data point: if several machines share the same problem, one well-targeted rule is enough — no need to fix it case by case."],
          ["Deployments", "History of every command sent to agents (mode, boolean, file context, module), with its status."],
          ["Suggestions", "Rules auto-generated by audit2allow the moment a new denial signature appears — review, then approve (with immediate deployment to the chosen hosts) or reject."],
          ["Alerts", "Never-seen signature, abnormal frequency, a host switching to permissive, or detected configuration drift."],
          ["Compliance", "A basic per-agent and fleet-wide score (enforcing mode, agent reachable, targeted policy, no open alert) — deliberately presented as basic checks, not a CIS-style benchmark."],
        ],
      },
    ],
  },
  {
    id: "deploying",
    title: "Deploying rules from this dashboard",
    blocks: [
      { type: "h3", text: "SELinux mode (enforcing / permissive)" },
      { type: "p", text: "Instant toggle from the agent detail page, or in bulk from the Agents page. Useful to diagnose an issue (temporarily switch to permissive) — switch back to enforcing as soon as you're done: the dashboard will alert you anyway if a host stays permissive." },
      { type: "h3", text: "Boolean" },
      { type: "p", text: "On/off, applied persistently (equivalent to setsebool -P). Needs no compilation — always the simplest option when an existing boolean covers the need." },
      { type: "h3", text: "File context (chcon)" },
      { type: "p", text: "Applies a bare type or a full context to a path, with a recursive option. For a permanent change that must survive a restorecon, prefer adding the rule via semanage fcontext directly on the host." },
      { type: "h3", text: "Policy module (via audit2allow suggestions)" },
      {
        type: "p",
        text: "The moment a never-seen denial signature appears, the master automatically asks the affected agent to run audit2allow on it — never applied on its own. The suggestion shows up on the Suggestions page with the readable .te text. The operator reviews it, picks target hosts, then «Approve & deploy» pushes the compiled module (.pp) through the exact same command as a manual module deployment. «Reject» deploys nothing.",
      },
    ],
  },
  {
    id: "alerts",
    title: "Alerts, severity and configuration drift",
    blocks: [
      { type: "p", text: "Every denial gets a severity (low/medium/high) — high if it touches a service considered critical (SSH, web server, sudo, databases…), without automatically meaning an attack: a simple software update very often explains a new denial on a sensitive service." },
      {
        type: "dl",
        items: [
          ["New signature", "The first time a source → target → class combination is observed fleet-wide."],
          ["Abnormal frequency", "The same signature crosses a fixed occurrence threshold (10, 50, 100, then 500)."],
          ["Switched to permissive", "An agent just left enforcing mode — a real loss of enforcement on that host, worth addressing promptly."],
          ["Configuration drift", "A watched file (/etc/selinux/config, or locally-added file contexts) changed outside a deployment from this master — a sign of an untracked manual change, or a backup restore that brought back an older configuration."],
        ],
      },
    ],
  },
  {
    id: "best-practices",
    title: "Best practices",
    blocks: [
      {
        type: "ul",
        items: [
          "Always prefer an existing boolean over a custom policy module when possible — easier to audit, remove, and understand for whoever comes next.",
          "Never fully disable SELinux, even temporarily in the face of many denials — switch to permissive to diagnose, then switch back to enforcing.",
          "Always review a suggested module's .te text before approving it, the way you'd review a code diff: it describes exactly what will now be permanently allowed.",
          "Before fixing a denial case by case on a single machine, check the Matrix: if several hosts share the same signature, one well-targeted rule deployed everywhere it's needed beats scattered fixes.",
          "If a SIEM/EDR is configured (see the corresponding section in the project's README), use the correlation available on each denial to tell a genuinely suspicious behavior apart from a simple missing policy rule.",
        ],
      },
    ],
  },
];

const es: WikiSection[] = [
  {
    id: "overview",
    title: "Visión general",
    blocks: [
      {
        type: "p",
        text: "Esta herramienta es un gestor de flota SELinux al estilo de Wazuh: un pequeño agente (escrito en Rust) se ejecuta en cada máquina supervisada, recopila las denegaciones SELinux y aplica las acciones recibidas del master; un servidor central (el master, en Go) centraliza todo y controla este dashboard.",
      },
      {
        type: "p",
        text: "Arquitectura: agente ↔ (gRPC + mTLS, una conexión persistente por agente) ↔ master ↔ Postgres (agentes, reglas, comandos, alertas) + OpenSearch (log bruto de denegaciones, gran volumen) + NATS JetStream (cola interna entre la recepción y el procesamiento).",
      },
      {
        type: "p",
        text: "Principio de seguridad central, válido para el resto de este wiki: ninguna acción se aplica jamás en un agente sin una orden explícita enviada por el master. Las sugerencias de reglas generadas automáticamente (ver «Desplegar reglas») nunca se instalan solas — siempre se requiere una aprobación humana explícita en el dashboard.",
      },
    ],
  },
  {
    id: "glossary",
    title: "Glosario SELinux",
    blocks: [
      {
        type: "dl",
        items: [
          [
            "Contexto SELinux",
            "La etiqueta de seguridad aplicada a un proceso o archivo, con la forma usuario:rol:tipo:nivel (p. ej. system_u:system_r:httpd_t:s0). Esto es lo que SELinux usa para decidir si se permite una acción — no los permisos Unix clásicos (rwx).",
          ],
          [
            "Tipo (el campo más útil en el día a día)",
            "El 3er campo del contexto (p. ej. httpd_t para el servidor web, user_home_t para un archivo personal). Casi todas las reglas de política se escriben en términos de tipos, no de archivos o procesos concretos.",
          ],
          [
            "AVC / denegación",
            "«Access Vector Cache» — el mecanismo del kernel que decide permitir o denegar una acción, y registra cada denegación. Esto es lo que esta herramienta recopila continuamente.",
          ],
          [
            "tclass (clase de objeto)",
            "El tipo del objetivo: file, dir, process, tcp_socket, dbus, filesystem… El mismo par de tipos puede dar lugar a reglas distintas según la clase.",
          ],
          [
            "perms (permisos)",
            "La acción precisa denegada para esa clase: read, write, execute, entrypoint, connectto… Una denegación puede listar varios permisos a la vez.",
          ],
          [
            "Booleano SELinux",
            "Un interruptor on/off que activa o desactiva toda una familia de reglas ya presentes en la política, sin necesidad de compilar nada (p. ej. httpd_can_network_connect). Siempre preferible a un módulo personalizado cuando ya existe un booleano para la necesidad.",
          ],
          [
            "Módulo de política (.te / .pp)",
            ".te es el texto fuente legible de un módulo de política; .pp es su versión compilada, instalable con semodule -i. Esto es lo que genera audit2allow y lo que este dashboard despliega una vez aprobado.",
          ],
          [
            "enforcing / permissive / disabled",
            "enforcing bloquea realmente las acciones denegadas; permissive las permite igualmente pero las registra (útil para pruebas); disabled desactiva SELinux por completo — evítalo, incluso temporalmente, ya que elimina toda protección, no solo para la acción en cuestión.",
          ],
          [
            "Política targeted",
            "La política estándar en la mayoría de las distribuciones: solo ciertos servicios sensibles están confinados en un tipo dedicado, el resto se ejecuta como unconfined_t (en gran medida sin restricciones).",
          ],
          [
            "semanage fcontext",
            "Asocia de forma persistente una ruta de archivo (con un patrón) a un contexto por defecto — lo que restorecon aplica después en disco. Útil tras mover archivos fuera de su ubicación estándar.",
          ],
          [
            "restorecon",
            "Vuelve a aplicar a los archivos en disco los contextos definidos por semanage fcontext. Ejecútalo tras cualquier cambio de fcontext, o para corregir un contexto que ha derivado.",
          ],
          [
            "audit2allow",
            "Herramienta que lee líneas de log AVC y genera una regla de política mínima que las habría permitido. Un excelente punto de partida, nunca una verdad absoluta — revisa siempre la regla generada antes de instalarla.",
          ],
        ],
      },
    ],
  },
  {
    id: "pages",
    title: "Guía de las páginas del dashboard",
    blocks: [
      {
        type: "dl",
        items: [
          ["Dashboard", "Vista general de la flota: agentes en línea/fuera de línea, reparto enforcing/permissive/disabled, firmas de denegación más frecuentes, despliegues recientes, alertas abiertas, puntuación de cumplimiento."],
          ["Agentes", "Inventario completo, selección múltiple, acciones en lote («Cambiar a permissive», desplegar una regla en varias máquinas a la vez)."],
          ["Detalle de agente", "Información del sistema, cambio enforcing/permissive con un clic, reglas ya aplicadas, booleanos y módulos SELinux (con cambio directo de un booleano), archivos vigilados para la detección de deriva, y las denegaciones recientes — cada una con su explicación en lenguaje claro y, si hay un SIEM externo configurado, los eventos correlacionados en la misma ventana de tiempo."],
          ["Denegaciones", "Búsqueda de texto completo en todo el historial de denegaciones (comando, ruta, contexto…), filtrable por agente."],
          ["Matriz", "Vista agregada de toda la flota, agrupada por firma (origen → destino, clase). El número de hosts afectados por una misma firma es el dato clave: si varias máquinas comparten el mismo problema, basta una sola regla bien dirigida — no hace falta resolverlo caso por caso."],
          ["Despliegues", "Historial de todos los comandos enviados a los agentes (modo, booleano, contexto de archivo, módulo), con su estado."],
          ["Sugerencias", "Reglas generadas automáticamente por audit2allow en cuanto aparece una nueva firma de denegación — revisar y luego aprobar (con despliegue inmediato en los hosts elegidos) o rechazar."],
          ["Alertas", "Firma nunca vista, frecuencia anómala, un host que pasa a permissive, o deriva de configuración detectada."],
          ["Cumplimiento", "Una puntuación básica por agente y de toda la flota (modo enforcing, agente accesible, política targeted, sin alertas abiertas) — presentada deliberadamente como verificaciones básicas, no como un benchmark tipo CIS."],
        ],
      },
    ],
  },
  {
    id: "deploying",
    title: "Desplegar reglas desde este dashboard",
    blocks: [
      { type: "h3", text: "Modo SELinux (enforcing / permissive)" },
      { type: "p", text: "Cambio instantáneo desde la página de detalle de un agente, o en lote desde la página Agentes. Útil para diagnosticar un problema (cambiar temporalmente a permissive) — vuelve a enforcing en cuanto termines: el dashboard te avisará de todos modos si un host se queda en permissive." },
      { type: "h3", text: "Booleano" },
      { type: "p", text: "On/off, aplicado de forma persistente (equivalente a setsebool -P). No requiere compilación — siempre la opción más simple cuando un booleano existente cubre la necesidad." },
      { type: "h3", text: "Contexto de archivo (chcon)" },
      { type: "p", text: "Aplica un tipo solo o un contexto completo a una ruta, con opción recursiva. Para un cambio permanente que deba sobrevivir a un restorecon, es preferible añadir la regla vía semanage fcontext directamente en el host." },
      { type: "h3", text: "Módulo de política (vía sugerencias de audit2allow)" },
      {
        type: "p",
        text: "En cuanto aparece una firma de denegación nunca vista, el master pide automáticamente al agente afectado que ejecute audit2allow sobre ella — nunca se aplica sola. La sugerencia aparece en la página Sugerencias con el texto .te legible. El operador la revisa, elige los hosts destino, y luego «Aprobar y desplegar» envía el módulo compilado (.pp) mediante exactamente el mismo comando que un despliegue manual de módulo. «Rechazar» no despliega nada.",
      },
    ],
  },
  {
    id: "alerts",
    title: "Alertas, severidad y deriva de configuración",
    blocks: [
      { type: "p", text: "Cada denegación recibe una severidad (baja/media/alta) — alta si afecta a un servicio considerado crítico (SSH, servidor web, sudo, bases de datos…), sin que eso signifique automáticamente un ataque: una simple actualización de software explica muy a menudo una nueva denegación en un servicio sensible." },
      {
        type: "dl",
        items: [
          ["Nueva firma", "La primera vez que se observa una combinación origen → destino → clase en toda la flota."],
          ["Frecuencia anómala", "La misma firma supera un umbral fijo de ocurrencias (10, 50, 100, luego 500)."],
          ["Cambio a permissive", "Un agente acaba de salir del modo enforcing — una pérdida real de aplicación de reglas en ese host, que conviene atender con prontitud."],
          ["Deriva de configuración", "Un archivo vigilado (/etc/selinux/config, o los contextos de archivo añadidos localmente) cambió fuera de un despliegue de este master — señal de un cambio manual no rastreado, o de una restauración de copia de seguridad que trajo de vuelta una configuración anterior."],
        ],
      },
    ],
  },
  {
    id: "best-practices",
    title: "Buenas prácticas",
    blocks: [
      {
        type: "ul",
        items: [
          "Prefiere siempre un booleano existente a un módulo de política personalizado cuando sea posible — más fácil de auditar, retirar y entender para quien venga después.",
          "Nunca desactives SELinux por completo, ni siquiera temporalmente ante muchas denegaciones — cambia a permissive para diagnosticar, y vuelve luego a enforcing.",
          "Revisa siempre el texto .te de un módulo sugerido antes de aprobarlo, como revisarías un diff de código: describe exactamente lo que a partir de ahora quedará permitido de forma permanente.",
          "Antes de corregir una denegación caso por caso en una sola máquina, consulta la Matriz: si varios hosts comparten la misma firma, una sola regla bien dirigida desplegada donde haga falta es mejor que arreglos dispersos.",
          "Si hay un SIEM/EDR configurado (ver la sección correspondiente en el README del proyecto), usa la correlación disponible en cada denegación para distinguir un comportamiento realmente sospechoso de una simple regla de política que falta.",
        ],
      },
    ],
  },
];

export const WIKI_CONTENT: Record<Locale, WikiSection[]> = { fr, en, es };
