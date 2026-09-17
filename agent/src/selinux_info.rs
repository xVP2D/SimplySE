use tokio::process::Command;

use crate::pb;

/// Snapshots the local SELinux booleans and loaded policy modules by
/// shelling out to the standard userspace tools, same approach as
/// `action::execute` — simpler and more robust than binding
/// libselinux/libsemanage via FFI. Never fails: a missing/failing tool
/// just yields an empty list for that half of the snapshot (logged), so a
/// host without SELinux tooling still connects and heartbeats normally.
pub async fn collect() -> (Vec<pb::SelinuxBoolean>, Vec<pb::SelinuxModule>) {
    (collect_booleans().await, collect_modules().await)
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
