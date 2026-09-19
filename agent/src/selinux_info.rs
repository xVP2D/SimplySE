use std::collections::{HashMap, HashSet};

use tokio::process::Command;

use crate::pb;
use crate::permissive;

/// Files whose content drifting (outside a `chcon`/`install_module`
/// command this tool itself issued) is worth flagging: the master mode
/// config, and locally-added file-context customizations. Deliberately
/// *not* the full built-in `file_contexts` (thousands of entries that
/// only change via policy package updates, not manual drift — hashing all
/// of it every collection interval would cost real CPU/IO for no signal).
const TRACKED_FILES: &[&str] = &[
    "/etc/selinux/config",
    "/etc/selinux/targeted/contexts/files/file_contexts.local",
];

/// Snapshots the local SELinux booleans, loaded policy modules, and a
/// small set of security-relevant file hashes by shelling out to the
/// standard userspace tools, same approach as `action::execute` —
/// simpler and more robust than binding libselinux/libsemanage via FFI.
/// Never fails: a missing/failing tool just yields an empty/partial
/// result for that part of the snapshot (logged), so a host without
/// SELinux tooling still connects and heartbeats normally.
pub async fn collect() -> (Vec<pb::SelinuxBoolean>, Vec<pb::SelinuxModule>, HashMap<String, String>, Vec<String>) {
    (
        collect_booleans().await,
        collect_modules().await,
        collect_file_hashes().await,
        collect_active_domains().await,
    )
}

/// Distinct confined domains with a process running under them right now —
/// what a "scan every rule on this machine" run can make permissive one at a
/// time (see permissive::start): a domain nothing runs under would produce
/// no denials from being loosened, so it is left out rather than guessed at
/// from the full (much larger, mostly irrelevant) set of types in the policy.
async fn collect_active_domains() -> Vec<String> {
    let output = match Command::new("ps").args(["-eo", "context"]).output().await {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            tracing::warn!(
                status = %output.status,
                stderr = %String::from_utf8_lossy(&output.stderr).trim(),
                "ps -eo context failed"
            );
            return Vec::new();
        }
        Err(err) => {
            tracing::warn!(error = %err, "failed to run ps -eo context");
            return Vec::new();
        }
    };

    parse_active_domains(&String::from_utf8_lossy(&output.stdout))
}

// Each line is a full context (user:role:type:level[:categories]); the
// header line ("CONTEXT") is skipped by valid_domain rejecting it (no colon,
// doesn't end in _t).
fn parse_active_domains(output: &str) -> Vec<String> {
    let mut domains: HashSet<String> = output
        .lines()
        .filter_map(|line| line.trim().split(':').nth(2))
        .filter(|domain| permissive::valid_domain(domain) && !permissive::is_refused(domain))
        .map(str::to_string)
        .collect();
    // unconfined_t runs under full access already: making it "permissive"
    // (a no-op) would just add noise to a scan's domain list.
    domains.remove("unconfined_t");
    let mut domains: Vec<String> = domains.into_iter().collect();
    domains.sort();
    domains
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedupes_confined_domains_and_drops_the_header_kernel_and_unconfined_processes() {
        let out = "CONTEXT\n\
                    system_u:system_r:init_t:s0\n\
                    system_u:system_r:sshd_t:s0\n\
                    system_u:system_r:sshd_t:s0\n\
                    system_u:system_r:httpd_t:s0\n\
                    unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023\n\
                    \n";
        assert_eq!(parse_active_domains(out), vec!["httpd_t".to_string(), "sshd_t".to_string()]);
    }

    #[test]
    fn an_all_kernel_or_unconfined_machine_reports_no_domains() {
        let out = "CONTEXT\nsystem_u:system_r:kernel_t:s0\nunconfined_u:unconfined_r:unconfined_t:s0\n";
        assert_eq!(parse_active_domains(out), Vec::<String>::new());
    }
}

async fn collect_file_hashes() -> HashMap<String, String> {
    let mut hashes = HashMap::new();
    for path in TRACKED_FILES {
        // sha256sum rather than a hashing crate: consistent with this
        // module's overall approach (shell out to standard tools), and
        // every target distro already ships coreutils.
        let output = match Command::new("sha256sum").arg(path).output().await {
            Ok(output) if output.status.success() => output,
            // Most common case: file_contexts.local simply doesn't exist
            // yet (no local customizations were ever made) — not worth a
            // warning, just omit it from the map.
            Ok(_) => continue,
            Err(err) => {
                tracing::warn!(path, error = %err, "failed to run sha256sum");
                continue;
            }
        };
        if let Some(hash) = String::from_utf8_lossy(&output.stdout).split_whitespace().next() {
            hashes.insert(path.to_string(), hash.to_string());
        }
    }
    hashes
}

async fn collect_booleans() -> Vec<pb::SelinuxBoolean> {
    let output = match Command::new("getsebool").arg("-a").output().await {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            tracing::warn!(
                status = %output.status,
                stderr = %String::from_utf8_lossy(&output.stderr).trim(),
                "getsebool -a failed"
            );
            return Vec::new();
        }
        Err(err) => {
            tracing::warn!(error = %err, "failed to run getsebool -a");
            return Vec::new();
        }
    };

    // Each line: "boolean_name --> on" or "boolean_name --> off".
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let (name, value) = line.split_once("-->")?;
            Some(pb::SelinuxBoolean {
                name: name.trim().to_string(),
                value: value.trim() == "on",
            })
        })
        .collect()
}

async fn collect_modules() -> Vec<pb::SelinuxModule> {
    let output = match Command::new("semodule").arg("-l").output().await {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            tracing::warn!(
                status = %output.status,
                stderr = %String::from_utf8_lossy(&output.stderr).trim(),
                "semodule -l failed"
            );
            return Vec::new();
        }
        Err(err) => {
            tracing::warn!(error = %err, "failed to run semodule -l");
            return Vec::new();
        }
    };

    // Each line is "name" on current policycoreutils, or "name\tversion"
    // on older ones that still print a version column — handle both.
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let name = parts.next()?.to_string();
            let version = parts.next().unwrap_or("").to_string();
            Some(pb::SelinuxModule { name, version })
        })
        .collect()
}
