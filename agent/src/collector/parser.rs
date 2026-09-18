use regex::Regex;
use std::sync::OnceLock;

/// A parsed `type=AVC ... denied` line from /var/log/audit/audit.log.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AvcDenial {
    pub ts_unix: i64,
    pub perms: Vec<String>,
    pub pid: String,
    pub comm: String,
    pub path: String,
    pub scontext: String,
    pub tcontext: String,
    pub tclass: String,
    pub raw_line: String,
}

// Matches both `type=AVC` (kernel-generated) and `type=USER_AVC`
// (userspace object managers — dbus, polkit, ...) records. The two differ
// in what comes between the timestamp and the actual "avc: denied { ... }"
// text: AVC has it immediately (only whitespace), USER_AVC wraps it inside
// a quoted `msg='avc: ...'` field preceded by pid=/uid=/subj=/etc, so `.*?`
// (lazy, so it still finds the *nearest* match for a plain AVC line) is
// used instead of `\s*` to allow for that either way.
fn avc_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(concat!(
            r#"type=(?:AVC|USER_AVC) msg=audit\((?P<ts>\d+)\.\d+:\d+\):.*?avc:\s*denied\s*\{\s*(?P<perms>[^}]+)\}"#,
            r#".*?pid=(?P<pid>\d+)"#,
            // Optional: kernel AVC records always have comm=, but
            // USER_AVC records from userspace object managers commonly
            // don't (they carry exe= instead) — don't fail the whole
            // match over a field that's genuinely absent there.
            r#"(?:.*?comm="(?P<comm>[^"]*)")?"#,
            r#"(?:.*?path="(?P<path>[^"]*)")?"#,
            r#".*?scontext=(?P<scontext>\S+)"#,
            r#".*?tcontext=(?P<tcontext>\S+)"#,
            r#".*?tclass=(?P<tclass>\S+)"#,
        ))
        .expect("AVC regex is a static, tested pattern")
    })
}

fn parse_avc_or_user_avc_line(line: &str) -> Option<AvcDenial> {
    let caps = avc_regex().captures(line)?;

    let ts_unix = caps.name("ts")?.as_str().parse().ok()?;
    let perms = caps
        .name("perms")?
        .as_str()
        .split_whitespace()
        .map(str::to_string)
        .collect();

    Some(AvcDenial {
        ts_unix,
        perms,
        pid: caps
            .name("pid")
            .map(|m| m.as_str())
            .unwrap_or_default()
            .to_string(),
        comm: caps
            .name("comm")
            .map(|m| m.as_str())
            .unwrap_or_default()
            .to_string(),
        path: caps
            .name("path")
            .map(|m| m.as_str())
            .unwrap_or_default()
            .to_string(),
        scontext: caps.name("scontext")?.as_str().to_string(),
        tcontext: caps.name("tcontext")?.as_str().to_string(),
        tclass: caps.name("tclass")?.as_str().to_string(),
        raw_line: line.to_string(),
    })
}

// `type=SELINUX_ERR` records are policy-level errors (e.g. a bounded
// domain transition being rejected) rather than a kernel access check —
// no `avc: denied { perms }` text at all. Shape instead:
// `type=SELINUX_ERR msg=audit(...): op=... scontext=... tcontext=... tclass=... perms=...`
// (a single perm, not a `{ }`-delimited set). Still worth surfacing as a
// denial-shaped record: it means SELinux refused something.
fn selinux_err_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(concat!(
            r#"type=SELINUX_ERR msg=audit\((?P<ts>\d+)\.\d+:\d+\):"#,
            r#".*?op=(?P<op>\S+)"#,
            r#".*?scontext=(?P<scontext>\S+)"#,
            r#".*?tcontext=(?P<tcontext>\S+)"#,
            r#".*?tclass=(?P<tclass>\S+)"#,
            r#"(?:.*?perms?=(?P<perms>\S+))?"#,
        ))
        .expect("SELINUX_ERR regex is a static, tested pattern")
    })
}

fn parse_selinux_err_line(line: &str) -> Option<AvcDenial> {
    let caps = selinux_err_regex().captures(line)?;

    let ts_unix = caps.name("ts")?.as_str().parse().ok()?;
    let perms = caps
        .name("perms")
        .map(|m| vec![m.as_str().to_string()])
        .unwrap_or_default();

    Some(AvcDenial {
        ts_unix,
        perms,
        pid: String::new(),
        // No comm= field on this record type; op= (e.g.
        // "security_compute_av") is the closest equivalent — "what was
        // being attempted" — so it goes in the same slot the dashboard
        // already renders as "Commande" rather than adding a new column
        // just for this one record type.
        comm: caps
            .name("op")
            .map(|m| m.as_str())
            .unwrap_or_default()
            .to_string(),
        path: String::new(),
        scontext: caps.name("scontext")?.as_str().to_string(),
        tcontext: caps.name("tcontext")?.as_str().to_string(),
        tclass: caps.name("tclass")?.as_str().to_string(),
        raw_line: line.to_string(),
    })
}

/// Returns `None` for any line that isn't an AVC/USER_AVC denial or a
/// SELINUX_ERR policy error (most audit.log lines aren't — syscalls,
/// logins, etc. are ignored).
pub fn parse_avc_line(line: &str) -> Option<AvcDenial> {
    parse_avc_or_user_avc_line(line).or_else(|| parse_selinux_err_line(line))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_typical_avc_denial() {
        let line = r#"type=AVC msg=audit(1699999999.123:456): avc:  denied  { read write } for  pid=1234 comm="httpd" path="/var/www/html/index.html" dev="dm-0" ino=131233 scontext=system_u:system_r:httpd_t:s0 tcontext=unconfined_u:object_r:user_home_t:s0 tclass=file permissive=0"#;
        let d = parse_avc_line(line).expect("should parse");
        assert_eq!(d.ts_unix, 1699999999);
        assert_eq!(d.perms, vec!["read", "write"]);
        assert_eq!(d.pid, "1234");
        assert_eq!(d.comm, "httpd");
        assert_eq!(d.path, "/var/www/html/index.html");
        assert_eq!(d.scontext, "system_u:system_r:httpd_t:s0");
        assert_eq!(d.tcontext, "unconfined_u:object_r:user_home_t:s0");
        assert_eq!(d.tclass, "file");
    }

    #[test]
    fn ignores_unrelated_lines() {
        assert!(
            parse_avc_line("type=SYSCALL msg=audit(1699999999.123:456): arch=c000003e").is_none()
        );
    }

    #[test]
    fn parses_a_user_avc_denial() {
        let line = r#"type=USER_AVC msg=audit(1699999999.123:456): pid=789 uid=81 auid=4294967295 ses=4294967295 subj=system_u:system_r:system_dbusd_t:s0 msg='avc:  denied  { send_msg } for msgtype=method_call interface=org.freedesktop.DBus member=Hello dest=org.freedesktop.DBus spid=1234 tpid=1 scontext=system_u:system_r:polkit_t:s0 tcontext=system_u:system_r:system_dbusd_t:s0 tclass=dbus permissive=0'  exe="/usr/bin/dbus-broker" sauid=81 hostname=? addr=? terminal=?"#;
        let d = parse_avc_line(line).expect("should parse");
        assert_eq!(d.ts_unix, 1699999999);
        assert_eq!(d.perms, vec!["send_msg"]);
        assert_eq!(d.scontext, "system_u:system_r:polkit_t:s0");
        assert_eq!(d.tcontext, "system_u:system_r:system_dbusd_t:s0");
        assert_eq!(d.tclass, "dbus");
    }

    #[test]
    fn parses_a_selinux_err_line() {
        let line = r#"type=SELINUX_ERR msg=audit(1699999999.123:456): op=security_compute_av reason=bounded scontext=system_u:system_r:init_t:s0 tcontext=system_u:system_r:httpd_t:s0 tclass=process perms=transition"#;
        let d = parse_avc_line(line).expect("should parse");
        assert_eq!(d.ts_unix, 1699999999);
        assert_eq!(d.perms, vec!["transition"]);
        assert_eq!(d.comm, "security_compute_av");
        assert_eq!(d.scontext, "system_u:system_r:init_t:s0");
        assert_eq!(d.tcontext, "system_u:system_r:httpd_t:s0");
        assert_eq!(d.tclass, "process");
    }
}
