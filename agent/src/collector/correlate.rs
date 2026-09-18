//! Attaches the full path of the denied file to its AVC record.
//!
//! An AVC record for a file access usually carries only the file's *base
//! name* (`name="sshd_probe.conf" dev=... ino=12345`); the full path lives in
//! a separate `type=PATH` record of the same audit event (same serial),
//! linked to the AVC by inode. Without it a denial can't be tied back to a
//! file, so a relabel (chcon/restorecon) could never be recognised as having
//! fixed it. Records of one event arrive in order — AVC, SYSCALL, CWD, PATH,
//! ..., EOE — so an AVC that needs a path is held until its EOE (or a short
//! timeout) and then released with the path filled in.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use regex::Regex;

use super::parser::{AvcDenial, parse_avc_line};

/// Bound on events held at once, so a flood of denials with no EOE can't
/// grow memory without limit; the oldest is released as-is when exceeded.
const MAX_PENDING: usize = 2048;

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("static, tested pattern"))
}

fn serial_of(line: &str) -> Option<u64> {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"msg=audit\(\d+\.\d+:(\d+)\)")
        .captures(line)?
        .get(1)?
        .as_str()
        .parse()
        .ok()
}

fn record_type(line: &str) -> &str {
    line.strip_prefix("type=")
        .and_then(|rest| rest.split_whitespace().next())
        .unwrap_or("")
}

/// A field value as auditd writes it: quoted text, or — when it contains
/// spaces, quotes or non-ASCII — uppercase hex without quotes.
fn decode_value(raw: &str) -> Option<String> {
    if let Some(quoted) = raw.strip_prefix('"') {
        return Some(quoted.strip_suffix('"').unwrap_or(quoted).to_string());
    }
    if raw == "(null)" || raw.is_empty() {
        return None;
    }
    if raw.len() % 2 == 0 && raw.bytes().all(|b| b.is_ascii_hexdigit()) {
        let bytes: Option<Vec<u8>> = (0..raw.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&raw[i..i + 2], 16).ok())
            .collect();
        return String::from_utf8(bytes?).ok();
    }
    None
}

fn field<'a>(line: &'a str, name: &str) -> Option<&'a str> {
    let key = format!(" {name}=");
    let start = line.find(&key)? + key.len();
    let rest = &line[start..];
    if rest.starts_with('"') {
        let end = rest[1..].find('"')? + 2;
        Some(&rest[..end])
    } else {
        Some(rest.split_whitespace().next().unwrap_or(""))
    }
}

struct Pending {
    started: Instant,
    denials: Vec<(AvcDenial, Option<String>)>, // (denial, ino from the AVC)
    paths: Vec<(String, String)>,              // (inode, name) from PATH records
    cwd: Option<String>,
}

#[derive(Default)]
pub struct Correlator {
    pending: HashMap<u64, Pending>,
}

impl Correlator {
    /// Feeds one audit line; returns the denials that are ready to send.
    pub fn feed(&mut self, line: &str, now: Instant) -> Vec<AvcDenial> {
        match record_type(line) {
            "AVC" | "USER_AVC" | "SELINUX_ERR" => {
                let Some(denial) = parse_avc_line(line) else {
                    return Vec::new();
                };
                let ino = field(line, "ino").map(str::to_string);
                let serial = serial_of(line);
                // Nothing to add, or nothing to correlate with: send now.
                let (Some(serial), Some(ino)) = (serial, ino) else {
                    return vec![denial];
                };
                if !denial.path.is_empty() {
                    return vec![denial];
                }
                let mut out = Vec::new();
                if self.pending.len() >= MAX_PENDING
                    && !self.pending.contains_key(&serial)
                    && let Some(oldest) = self.pending.iter().min_by_key(|(_, p)| p.started).map(|(k, _)| *k)
                {
                    out.extend(self.finish(oldest));
                }
                self.pending
                    .entry(serial)
                    .or_insert_with(|| Pending { started: now, denials: Vec::new(), paths: Vec::new(), cwd: None })
                    .denials
                    .push((denial, Some(ino)));
                out
            }
            "CWD" => {
                if let (Some(serial), Some(cwd)) = (serial_of(line), field(line, "cwd").and_then(decode_value))
                    && let Some(p) = self.pending.get_mut(&serial)
                {
                    p.cwd = Some(cwd);
                }
                Vec::new()
            }
            "PATH" => {
                if let Some(serial) = serial_of(line)
                    && let Some(p) = self.pending.get_mut(&serial)
                    && let (Some(inode), Some(name)) =
                        (field(line, "inode"), field(line, "name").and_then(decode_value))
                {
                    p.paths.push((inode.to_string(), name));
                }
                Vec::new()
            }
            "EOE" => serial_of(line).map(|s| self.finish(s)).unwrap_or_default().into_iter().collect(),
            _ => Vec::new(),
        }
    }

    /// Releases events whose EOE never came (records lost, or an auditd that
    /// doesn't emit one) so a denial is never held back for long.
    pub fn flush_stale(&mut self, now: Instant, max_age: Duration) -> Vec<AvcDenial> {
        let stale: Vec<u64> = self
            .pending
            .iter()
            .filter(|(_, p)| now.duration_since(p.started) >= max_age)
            .map(|(k, _)| *k)
            .collect();
        stale.into_iter().flat_map(|k| self.finish(k)).collect()
    }

    fn finish(&mut self, serial: u64) -> Vec<AvcDenial> {
        let Some(p) = self.pending.remove(&serial) else {
            return Vec::new();
        };
        p.denials
            .into_iter()
            .map(|(mut denial, ino)| {
                if let Some(ino) = ino
                    && let Some((_, name)) = p.paths.iter().find(|(inode, _)| *inode == ino)
                    && let Some(path) = absolute(name, p.cwd.as_deref())
                {
                    denial.path = path;
                }
                denial
            })
            .collect()
    }
}

/// The record's name made absolute, or `None` if that isn't possible — a
/// relative path with no known working directory can't be looked up later.
fn absolute(name: &str, cwd: Option<&str>) -> Option<String> {
    if name.starts_with('/') {
        return Some(name.to_string());
    }
    let cwd = cwd.filter(|c| c.starts_with('/'))?;
    let name = name.strip_prefix("./").unwrap_or(name);
    Some(format!("{}/{}", cwd.trim_end_matches('/'), name))
}

#[cfg(test)]
mod tests {
    use super::*;

    const AVC: &str = r#"type=AVC msg=audit(1789750000.123:5001): avc:  denied  { read } for  pid=1 comm="sshd" name="sshd_probe.conf" dev="sda3" ino=12345 scontext=system_u:system_r:sshd_t:s0-s0:c0.c1023 tcontext=unconfined_u:object_r:var_t:s0 tclass=file permissive=0"#;
    const CWD: &str = r#"type=CWD msg=audit(1789750000.123:5001): cwd="/root""#;
    const PATH: &str = r#"type=PATH msg=audit(1789750000.123:5001): item=0 name="/srv/sshd_probe.conf" inode=12345 dev=08:03 mode=0100644 ouid=0 ogid=0 rdev=00:00 obj=unconfined_u:object_r:var_t:s0 nametype=NORMAL"#;
    const EOE: &str = "type=EOE msg=audit(1789750000.123:5001): ";

    fn feed_all(c: &mut Correlator, lines: &[&str]) -> Vec<AvcDenial> {
        let now = Instant::now();
        lines.iter().flat_map(|l| c.feed(l, now)).collect()
    }

    #[test]
    fn attaches_the_path_record_matching_the_avc_inode() {
        let mut c = Correlator::default();
        let out = feed_all(&mut c, &[AVC, CWD, PATH, EOE]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].path, "/srv/sshd_probe.conf");
    }

    #[test]
    fn holds_the_avc_until_the_event_ends() {
        let mut c = Correlator::default();
        assert!(feed_all(&mut c, &[AVC, CWD, PATH]).is_empty(), "must wait for EOE");
        assert_eq!(c.feed(EOE, Instant::now()).len(), 1);
    }

    #[test]
    fn a_path_record_for_another_inode_is_not_used() {
        let other = PATH.replace("inode=12345", "inode=999");
        let mut c = Correlator::default();
        let out = feed_all(&mut c, &[AVC, CWD, &other, EOE]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].path, "");
    }

    #[test]
    fn a_denial_that_already_has_a_path_is_sent_immediately() {
        let with_path = AVC.replace(r#"name="sshd_probe.conf""#, r#"path="/usr/bin/cat""#);
        let mut c = Correlator::default();
        let out = c.feed(&with_path, Instant::now());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].path, "/usr/bin/cat");
    }

    #[test]
    fn a_denial_without_an_inode_is_sent_immediately() {
        let no_ino = AVC.replace("ino=12345 ", "");
        let mut c = Correlator::default();
        assert_eq!(c.feed(&no_ino, Instant::now()).len(), 1);
    }

    #[test]
    fn stale_events_are_released_without_a_path() {
        let mut c = Correlator::default();
        let start = Instant::now();
        assert!(c.feed(AVC, start).is_empty());
        assert!(c.flush_stale(start, Duration::from_secs(2)).is_empty());
        let out = c.flush_stale(start + Duration::from_secs(3), Duration::from_secs(2));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].path, "");
    }

    #[test]
    fn relative_names_use_the_working_directory_or_are_dropped() {
        let relative = PATH.replace("name=\"/srv/sshd_probe.conf\"", "name=\"sshd_probe.conf\"");
        let mut c = Correlator::default();
        assert_eq!(feed_all(&mut c, &[AVC, CWD, &relative, EOE])[0].path, "/root/sshd_probe.conf");

        let mut c = Correlator::default();
        assert_eq!(feed_all(&mut c, &[AVC, &relative, EOE])[0].path, "", "no cwd: can't be made absolute");
    }

    #[test]
    fn hex_encoded_names_are_decoded() {
        // "/srv/a b" contains a space, so auditd writes it as hex.
        let hexed = PATH.replace("name=\"/srv/sshd_probe.conf\"", "name=2F7372762F612062");
        let mut c = Correlator::default();
        assert_eq!(feed_all(&mut c, &[AVC, CWD, &hexed, EOE])[0].path, "/srv/a b");
    }

    #[test]
    fn unrelated_records_and_other_serials_are_ignored() {
        let mut c = Correlator::default();
        let other_serial = PATH.replace(":5001)", ":9999)");
        let out = feed_all(&mut c, &[AVC, "type=SYSCALL msg=audit(1789750000.123:5001): arch=c000003e", &other_serial, EOE]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].path, "");
    }

    #[test]
    fn memory_is_bounded() {
        let mut c = Correlator::default();
        let now = Instant::now();
        let mut released = 0;
        for i in 0..(MAX_PENDING + 50) {
            let line = AVC.replace(":5001)", &format!(":{})", 10_000 + i));
            released += c.feed(&line, now).len();
        }
        assert!(c.pending.len() <= MAX_PENDING);
        assert!(released >= 50, "overflow must release the oldest events, not drop them");
    }
}
