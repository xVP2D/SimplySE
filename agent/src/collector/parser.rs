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

fn avc_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(concat!(
            r#"type=AVC msg=audit\((?P<ts>\d+)\.\d+:\d+\):\s*avc:\s*denied\s*\{\s*(?P<perms>[^}]+)\}"#,
            r#".*?pid=(?P<pid>\d+)"#,
            r#".*?comm="(?P<comm>[^"]*)""#,
            r#"(?:.*?path="(?P<path>[^"]*)")?"#,
            r#".*?scontext=(?P<scontext>\S+)"#,
            r#".*?tcontext=(?P<tcontext>\S+)"#,
            r#".*?tclass=(?P<tclass>\S+)"#,
        ))
        .expect("AVC regex is a static, tested pattern")
    })
}

/// Returns `None` for any line that is not an AVC denial (most audit.log
/// lines aren't — syscalls, logins, etc. are ignored).
pub fn parse_avc_line(line: &str) -> Option<AvcDenial> {
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
}
