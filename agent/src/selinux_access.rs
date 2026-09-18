//! Answers "would this access still be denied?" from the policy actually
//! loaded in the kernel, through selinuxfs — no external tool (setools /
//! sesearch) needed, and it accounts for everything that shapes the real
//! decision: loaded modules, boolean states and the current label of the
//! object. That is what lets a denial be recognised as fixed no matter how
//! the fix got there (a rule deployed from the dashboard, an approved
//! suggestion, or a change made by hand on the machine).

use std::ffi::CString;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};

use crate::pb;

const SELINUXFS: &str = "/sys/fs/selinux";

/// Class and permission names become path components under selinuxfs, and
/// they come from the master, so refuse anything that isn't a plain
/// identifier (no `/`, no `..`).
fn is_identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn read_number(path: &str) -> Result<u32, String> {
    fs::read_to_string(path)
        .map_err(|err| format!("{path}: {err}"))?
        .trim()
        .parse::<u32>()
        .map_err(|err| format!("{path}: {err}"))
}

/// Kernel class number from `/sys/fs/selinux/class/<class>/index`.
fn class_index(class: &str) -> Result<u32, String> {
    if !is_identifier(class) {
        return Err(format!("invalid class name {class:?}"));
    }
    read_number(&format!("{SELINUXFS}/class/{class}/index"))
}

/// Bitmask of `perms` within `class`: permission N (1-based, from
/// `/sys/fs/selinux/class/<class>/perms/<perm>`) is bit N-1.
fn perm_mask(class: &str, perms: &[String]) -> Result<u32, String> {
    if perms.is_empty() {
        return Err("no permissions to check".to_string());
    }
    let mut mask = 0u32;
    for perm in perms {
        if !is_identifier(perm) {
            return Err(format!("invalid permission name {perm:?}"));
        }
        let value = read_number(&format!("{SELINUXFS}/class/{class}/perms/{perm}"))?;
        if !(1..=32).contains(&value) {
            return Err(format!("permission {perm} has out-of-range value {value}"));
        }
        mask |= 1 << (value - 1);
    }
    Ok(mask)
}

/// The `access` file replies `allowed decided auditallow auditdeny seqno flags`,
/// all hex except the sequence number.
fn parse_access_reply(reply: &str) -> Result<u32, String> {
    let first = reply
        .split_whitespace()
        .next()
        .ok_or_else(|| "empty reply from selinuxfs access".to_string())?;
    u32::from_str_radix(first, 16).map_err(|err| format!("bad access reply {reply:?}: {err}"))
}

/// Asks the kernel which of `mask` the source may perform on the target.
fn compute_allowed(scontext: &str, tcontext: &str, class: u32, mask: u32) -> Result<u32, String> {
    // Contexts are written space-separated: refuse anything that could
    // shift the fields or smuggle a newline.
    for ctx in [scontext, tcontext] {
        if ctx.is_empty() || ctx.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(format!("invalid context {ctx:?}"));
        }
    }
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(format!("{SELINUXFS}/access"))
        .map_err(|err| format!("open selinuxfs access: {err}"))?;
    file.write_all(format!("{scontext} {tcontext} {class} {mask:x}").as_bytes())
        .map_err(|err| format!("query selinuxfs access: {err}"))?;
    let mut reply = String::new();
    file.read_to_string(&mut reply)
        .map_err(|err| format!("read selinuxfs access reply: {err}"))?;
    parse_access_reply(&reply)
}

/// Current SELinux label of `path` (not following a final symlink), if it
/// exists and has one.
fn current_label(path: &str) -> Option<String> {
    let c_path = CString::new(path).ok()?;
    let name = CString::new("security.selinux").ok()?;
    let mut buf = vec![0u8; 512];
    // SAFETY: both strings are valid NUL-terminated C strings and `buf` is a
    // writable buffer of exactly the length passed.
    let len = unsafe {
        libc::lgetxattr(c_path.as_ptr(), name.as_ptr(), buf.as_mut_ptr().cast(), buf.len())
    };
    if len <= 0 {
        return None;
    }
    buf.truncate(len as usize);
    while buf.last() == Some(&0) {
        buf.pop();
    }
    String::from_utf8(buf).ok()
}

/// Evaluates one probe: `(allowed_now, detail)`.
pub fn evaluate(probe: &pb::DenialProbe) -> pb::DenialVerdict {
    let (allowed, detail) = match evaluate_inner(probe) {
        Ok(v) => v,
        Err(err) => (false, err),
    };
    pb::DenialVerdict {
        id: probe.id.clone(),
        allowed,
        detail,
    }
}

fn evaluate_inner(probe: &pb::DenialProbe) -> Result<(bool, String), String> {
    let class = class_index(&probe.tclass)?;
    let mask = perm_mask(&probe.tclass, &probe.perms)?;

    // If the object was relabeled since the denial, the same access is now
    // judged against its new label — that is how a chcon/restorecon fix shows
    // up. Only trust it for absolute paths.
    let mut target = probe.tcontext.clone();
    let mut note = String::new();
    if probe.path.starts_with('/') {
        if let Some(label) = current_label(&probe.path) {
            if label != probe.tcontext {
                note = format!(" (object now labeled {label})");
                target = label;
            }
        }
    }

    let allowed = compute_allowed(&probe.scontext, &target, class, mask)?;
    if allowed & mask == mask {
        Ok((true, format!("allowed by the loaded policy{note}")))
    } else {
        Ok((false, format!("still denied{note}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_reject_anything_path_like() {
        assert!(is_identifier("file"));
        assert!(is_identifier("name_connect"));
        assert!(!is_identifier(""));
        assert!(!is_identifier("../x"));
        assert!(!is_identifier("a/b"));
        assert!(!is_identifier("a b"));
        assert!(!is_identifier(&"a".repeat(65)));
    }

    #[test]
    fn parses_the_first_hex_field_of_the_access_reply() {
        // allowed decided auditallow auditdeny seqno flags
        assert_eq!(parse_access_reply("4cc55 ffffffff 0 ffffffff 12 0\n"), Ok(0x4cc55));
        assert_eq!(parse_access_reply("0 ffffffff 0 ffffffff 3 0"), Ok(0));
        assert!(parse_access_reply("").is_err());
        assert!(parse_access_reply("zz 1 2").is_err());
    }

    #[test]
    fn refuses_contexts_that_could_shift_the_query_fields() {
        for bad in ["", "a b", "a\nb"] {
            assert!(compute_allowed(bad, "x:y:z:s0", 1, 1).is_err(), "{bad:?}");
            assert!(compute_allowed("x:y:z:s0", bad, 1, 1).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn an_unknown_class_or_permission_is_an_error_not_a_pass() {
        let probe = pb::DenialProbe {
            id: "p".into(),
            scontext: "system_u:system_r:sshd_t:s0".into(),
            tcontext: "system_u:object_r:bin_t:s0".into(),
            tclass: "no_such_class_zz".into(),
            perms: vec!["read".into()],
            path: String::new(),
        };
        let verdict = evaluate(&probe);
        assert!(!verdict.allowed, "{}", verdict.detail);
    }

    #[test]
    fn a_path_like_class_never_reaches_the_filesystem() {
        let probe = pb::DenialProbe {
            id: "p".into(),
            scontext: "a:b:c:s0".into(),
            tcontext: "a:b:c:s0".into(),
            tclass: "../../etc".into(),
            perms: vec!["read".into()],
            path: String::new(),
        };
        let verdict = evaluate(&probe);
        assert!(!verdict.allowed);
        assert!(verdict.detail.contains("invalid class name"), "{}", verdict.detail);
    }
}
