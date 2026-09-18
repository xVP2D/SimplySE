import type { Locale } from "../i18n";

// A small, curated set of the SELinux types an operator runs into most
// often — enough to make the common case readable without pretending to
// cover the thousands of types a real policy defines. Anything missing
// falls back to a humanized version of the raw type name (strip the
// trailing "_t", turn underscores into spaces) rather than showing
// nothing or the raw identifier.
const FRIENDLY_TYPES: Record<string, Record<Locale, string>> = {
  httpd_t: { en: "the web server (Apache/httpd)", fr: "le serveur web (Apache/httpd)", es: "el servidor web (Apache/httpd)" },
  httpd_sys_content_t: { en: "a website content file", fr: "un fichier de contenu web", es: "un archivo de contenido web" },
  sshd_t: { en: "the SSH service", fr: "le service SSH", es: "el servicio SSH" },
  sudo_t: { en: "a command run via sudo", fr: "une commande lancée via sudo", es: "un comando ejecutado vía sudo" },
  su_t: { en: "a command run via su", fr: "une commande lancée via su", es: "un comando ejecutado vía su" },
  crond_t: { en: "a scheduled task (cron)", fr: "une tâche planifiée (cron)", es: "una tarea programada (cron)" },
  init_t: { en: "systemd (the init process)", fr: "systemd (le processus d'initialisation)", es: "systemd (el proceso de inicio)" },
  unconfined_t: { en: "an unconfined (unrestricted) process", fr: "un processus non confiné", es: "un proceso sin confinar" },
  bin_t: { en: "a standard system executable", fr: "un exécutable système standard", es: "un ejecutable estándar del sistema" },
  user_home_t: { en: "a file in a user's home directory", fr: "un fichier du répertoire personnel d'un utilisateur", es: "un archivo del directorio personal de un usuario" },
  etc_t: { en: "a system configuration file (/etc)", fr: "un fichier de configuration système (/etc)", es: "un archivo de configuración del sistema (/etc)" },
  var_log_t: { en: "a system log file", fr: "un fichier de log système", es: "un archivo de log del sistema" },
  tmp_t: { en: "a temporary file", fr: "un fichier temporaire", es: "un archivo temporal" },
  postgresql_t: { en: "PostgreSQL", fr: "PostgreSQL", es: "PostgreSQL" },
  mysqld_t: { en: "MySQL/MariaDB", fr: "MySQL/MariaDB", es: "MySQL/MariaDB" },
  named_t: { en: "the DNS server (BIND)", fr: "le serveur DNS (BIND)", es: "el servidor DNS (BIND)" },
  dhcpd_t: { en: "the DHCP server", fr: "le serveur DHCP", es: "el servidor DHCP" },
  sysadm_t: { en: "an admin session", fr: "une session d'administration", es: "una sesión de administración" },
  auditd_t: { en: "the audit daemon", fr: "le démon d'audit", es: "el demonio de auditoría" },
  policykit_t: { en: "PolicyKit (privilege authorization)", fr: "PolicyKit (autorisation de privilèges)", es: "PolicyKit (autorización de privilegios)" },
  system_dbusd_t: { en: "the D-Bus system daemon", fr: "le démon système D-Bus", es: "el demonio del sistema D-Bus" },
  aide_t: { en: "AIDE (file integrity checker)", fr: "AIDE (vérificateur d'intégrité de fichiers)", es: "AIDE (verificador de integridad de archivos)" },
  dosfs_t: { en: "a FAT/VFAT filesystem", fr: "un système de fichiers FAT/VFAT", es: "un sistema de archivos FAT/VFAT" },
  NetworkManager_t: { en: "NetworkManager", fr: "NetworkManager", es: "NetworkManager" },
};

const CLASS_LABELS: Record<string, Record<Locale, string>> = {
  file: { en: "a file", fr: "un fichier", es: "un archivo" },
  dir: { en: "a directory", fr: "un répertoire", es: "un directorio" },
  process: { en: "a process", fr: "un processus", es: "un proceso" },
  tcp_socket: { en: "a network connection (TCP)", fr: "une connexion réseau (TCP)", es: "una conexión de red (TCP)" },
  udp_socket: { en: "a network connection (UDP)", fr: "une connexion réseau (UDP)", es: "una conexión de red (UDP)" },
  unix_stream_socket: { en: "a local socket", fr: "un socket local", es: "un socket local" },
  dbus: { en: "a D-Bus message", fr: "un message D-Bus", es: "un mensaje D-Bus" },
  filesystem: { en: "a filesystem", fr: "un système de fichiers", es: "un sistema de archivos" },
  capability: { en: "a system capability", fr: "une capability système", es: "una capability del sistema" },
  lnk_file: { en: "a symbolic link", fr: "un lien symbolique", es: "un enlace simbólico" },
  sock_file: { en: "a socket file", fr: "un fichier socket", es: "un archivo de socket" },
  chr_file: { en: "a device file", fr: "un fichier de périphérique", es: "un archivo de dispositivo" },
};

export function typeFromContext(ctx: string): string {
  const parts = ctx.split(":");
  return parts.length >= 3 ? parts[2] : ctx;
}

function humanizeType(rawType: string): string {
  return rawType.replace(/_t$/, "").replace(/_/g, " ");
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

export function friendlyActor(ctx: string, locale: Locale): string {
  const type = typeFromContext(ctx);
  return FRIENDLY_TYPES[type]?.[locale] ?? humanizeType(type);
}

export function friendlyClass(tclass: string, locale: Locale): string {
  return CLASS_LABELS[tclass]?.[locale] ?? tclass;
}

/**
 * One plain-language sentence summarizing an AVC denial, meant to sit
 * alongside (never instead of) the raw technical fields — an operator who
 * doesn't read SELinux contexts fluently still gets "who was blocked
 * doing what to what", while the exact scontext/tcontext/tclass/perms
 * stay available for whoever needs the precise detail.
 */
export function explainDenial(
  d: { scontext: string; tcontext: string; tclass: string; perms: string[] },
  locale: Locale,
): string {
  const actor = friendlyActor(d.scontext, locale);
  const targetType = humanizeType(typeFromContext(d.tcontext));
  const targetClass = friendlyClass(d.tclass, locale);
  const perms = d.perms.join(", ");

  switch (locale) {
    case "en":
      return `${capitalize(actor)} was blocked trying to access ${targetClass} of type "${targetType}" (permissions: ${perms}).`;
    case "es":
      return `${capitalize(actor)} fue bloqueado al intentar acceder a ${targetClass} de tipo «${targetType}» (permisos: ${perms}).`;
    case "fr":
    default:
      return `${capitalize(actor)} a été bloqué en tentant d'accéder à ${targetClass} de type « ${targetType} » (permissions : ${perms}).`;
  }
}
