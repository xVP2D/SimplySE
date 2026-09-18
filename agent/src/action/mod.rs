use base64::Engine;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::pb;

/// Executes a command received from the master and returns (success, message).
///
/// Applies changes by shelling out to the standard SELinux userspace tools
/// (`setenforce`, `setsebool`, `semodule`) rather than binding
/// libselinux/libsemanage via FFI — simpler and more robust to start with;
/// revisit if a future need (e.g. richer policy introspection) requires it.
pub async fn execute(cmd: &pb::Command) -> (bool, String) {
    let command_type =
        pb::CommandType::try_from(cmd.r#type).unwrap_or(pb::CommandType::Unspecified);

    match command_type {
        pb::CommandType::SetMode => set_mode(&cmd.payload_json).await,
        pb::CommandType::SetBoolean => set_boolean(&cmd.payload_json).await,
        pb::CommandType::InstallModule => install_module(&cmd.payload_json).await,
        pb::CommandType::Chcon => chcon(&cmd.payload_json).await,
        pb::CommandType::SuggestModule => suggest_module(&cmd.payload_json).await,
        pb::CommandType::RemoveModule => remove_module(&cmd.payload_json).await,
        pb::CommandType::Restorecon => restorecon(&cmd.payload_json).await,
        pb::CommandType::Unspecified => (false, "unknown command type".to_string()),
    }
}

#[derive(Deserialize)]
struct SetModePayload {
    mode: String,
}

async fn set_mode(payload_json: &str) -> (bool, String) {
    let payload: SetModePayload = match serde_json::from_str(payload_json) {
        Ok(p) => p,
        Err(err) => return (false, format!("invalid payload: {err}")),
    };
    let arg = match payload.mode.as_str() {
        "enforcing" => "1",
        "permissive" => "0",
        other => return (false, format!("unknown mode {other:?}")),
    };
    run_and_report("setenforce", &[arg]).await
}

#[derive(Deserialize)]
struct SetBooleanPayload {
    name: String,
    value: bool,
}

async fn set_boolean(payload_json: &str) -> (bool, String) {
    let payload: SetBooleanPayload = match serde_json::from_str(payload_json) {
        Ok(p) => p,
        Err(err) => return (false, format!("invalid payload: {err}")),
    };
    let value = if payload.value { "on" } else { "off" };
    run_and_report("setsebool", &["-P", &payload.name, value]).await
}

#[derive(Deserialize)]
struct InstallModulePayload {
    name: String,
    content_base64: String,
}

async fn install_module(payload_json: &str) -> (bool, String) {
    let payload: InstallModulePayload = match serde_json::from_str(payload_json) {
        Ok(p) => p,
        Err(err) => return (false, format!("invalid payload: {err}")),
    };
    let bytes = match base64::engine::general_purpose::STANDARD.decode(payload.content_base64) {
        Ok(b) => b,
        Err(err) => return (false, format!("invalid base64 module content: {err}")),
    };

    let tmp_path = std::env::temp_dir().join(format!("{}.pp", payload.name));
    if let Err(err) = tokio::fs::write(&tmp_path, &bytes).await {
        return (false, format!("failed to write module to disk: {err}"));
    }

    let result = run_and_report("semodule", &["-i", &tmp_path.to_string_lossy()]).await;
    let _ = tokio::fs::remove_file(&tmp_path).await;
    result
}

#[derive(Deserialize)]
struct ChconPayload {
    path: String,
    #[serde(default, rename = "type")]
    context_type: Option<String>,
    #[serde(default)]
    context: Option<String>,
    #[serde(default)]
    recursive: bool,
}

/// `context` (a full `user:role:type:level` context) takes precedence over
/// `type` (a bare type, applied via `chcon -t`) when both are set.
async fn chcon(payload_json: &str) -> (bool, String) {
    let payload: ChconPayload = match serde_json::from_str(payload_json) {
        Ok(p) => p,
        Err(err) => return (false, format!("invalid payload: {err}")),
    };

    let mut args: Vec<String> = Vec::new();
    if payload.recursive {
        args.push("-R".to_string());
    }
    if let Some(context) = payload.context {
        args.push(context);
    } else if let Some(context_type) = payload.context_type {
        args.push("-t".to_string());
        args.push(context_type);
    } else {
        return (
            false,
            "payload must set \"context\" or \"type\"".to_string(),
        );
    }
    args.push(payload.path);

    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_and_report("chcon", &arg_refs).await
}

#[derive(Deserialize)]
struct RemoveModulePayload {
    name: String,
}

/// A module name goes to `semodule -r` as a bare argument, so it must not be
/// able to look like an option (leading `-`) or carry anything but the
/// characters real module names use.
fn is_safe_module_name(name: &str) -> bool {
    let mut chars = name.chars();
    let starts_ok = matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric() || c == '_');
    starts_ok
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

/// Undo of an INSTALL_MODULE, only ever sent when an operator deletes an
/// applied rule (see master/internal/server/revert.go).
async fn remove_module(payload_json: &str) -> (bool, String) {
    let payload: RemoveModulePayload = match serde_json::from_str(payload_json) {
        Ok(p) => p,
        Err(err) => return (false, format!("invalid payload: {err}")),
    };
    if !is_safe_module_name(&payload.name) {
        return (false, format!("refusing unsafe module name {:?}", payload.name));
    }
    // Idempotent: the goal is "this module is not installed", so a module
    // that is already gone (removed by hand since) counts as success —
    // otherwise its entry could never be deleted from the list.
    match Command::new("semodule").arg("-l").output().await {
        Ok(output) if output.status.success() => {
            let installed = String::from_utf8_lossy(&output.stdout)
                .lines()
                .any(|line| line.split_whitespace().next() == Some(payload.name.as_str()));
            if !installed {
                return (true, "module was not installed, nothing to remove".to_string());
            }
        }
        // Can't list modules: fall through and let `semodule -r` decide.
        _ => {}
    }
    run_and_report("semodule", &["-r", &payload.name]).await
}

#[derive(Deserialize)]
struct RestoreconPayload {
    path: String,
    #[serde(default)]
    recursive: bool,
}

/// Undo of a CHCON: resets the path to the policy's default context (not
/// necessarily the label it had before the chcon).
async fn restorecon(payload_json: &str) -> (bool, String) {
    let payload: RestoreconPayload = match serde_json::from_str(payload_json) {
        Ok(p) => p,
        Err(err) => return (false, format!("invalid payload: {err}")),
    };
    // Absolute only: a relative path could resolve against the agent's own
    // working directory, and a leading `-` would read as an option.
    if !payload.path.starts_with('/') {
        return (false, format!("refusing non-absolute path {:?}", payload.path));
    }

    // Idempotent for the same reason as remove_module: a path that no longer
    // exists has nothing left to restore.
    if let Err(err) = tokio::fs::symlink_metadata(&payload.path).await {
        if err.kind() == std::io::ErrorKind::NotFound {
            return (true, "path no longer exists, nothing to restore".to_string());
        }
    }

    let mut args: Vec<&str> = vec!["-v"];
    if payload.recursive {
        args.push("-R");
    }
    args.push("--");
    args.push(&payload.path);

    match Command::new("restorecon").args(&args).output().await {
        Ok(output) if output.status.success() => {
            let relabeled = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if relabeled.is_empty() {
                (true, "already the policy default context, nothing to change".to_string())
            } else {
                (true, relabeled)
            }
        }
        Ok(output) => (
            false,
            format!(
                "restorecon exited with {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ),
        Err(err) => (false, format!("failed to run restorecon: {err}")),
    }
}

#[derive(Deserialize)]
struct SuggestModulePayload {
    raw_lines: Vec<String>,
    module_name: String,
}

#[derive(Serialize)]
struct SuggestModuleResult {
    te: String,
    pp_base64: String,
}

/// Runs `audit2allow -M <module_name>` against the given raw audit lines
/// and returns the suggested `.te` text plus the compiled `.pp` module
/// (base64), JSON-encoded into the command ack's message. Generation
/// only: this never runs `semodule -i` or touches the live policy —
/// installing a suggestion is a fully separate COMMAND_TYPE_INSTALL_MODULE
/// that only ever happens once a human approves it in the dashboard.
async fn suggest_module(payload_json: &str) -> (bool, String) {
    let payload: SuggestModulePayload = match serde_json::from_str(payload_json) {
        Ok(p) => p,
        Err(err) => return (false, format!("invalid payload: {err}")),
    };

    // audit2allow -M writes <name>.te/.pp into the cwd — keep the name to
    // exactly this charset so it can't escape the temp dir or smuggle
    // extra arguments/flags into audit2allow's argv.
    if payload.module_name.is_empty()
        || !payload
            .module_name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return (false, "invalid module_name (expected [A-Za-z0-9_]+)".to_string());
    }
    if payload.raw_lines.is_empty() {
        return (false, "raw_lines must not be empty".to_string());
    }

    let tmp_dir = std::env::temp_dir().join(format!("audit2allow-{}", payload.module_name));
    if let Err(err) = tokio::fs::create_dir_all(&tmp_dir).await {
        return (false, format!("failed to create temp dir: {err}"));
    }
    let result = run_audit2allow(&tmp_dir, &payload.module_name, &payload.raw_lines).await;
    let _ = tokio::fs::remove_dir_all(&tmp_dir).await;

    match result {
        Ok(r) => match serde_json::to_string(&r) {
            Ok(json) => (true, json),
            Err(err) => (false, format!("failed to encode result: {err}")),
        },
        Err(err) => (false, err),
    }
}

async fn run_audit2allow(
    tmp_dir: &std::path::Path,
    module_name: &str,
    raw_lines: &[String],
) -> Result<SuggestModuleResult, String> {
    let mut child = Command::new("audit2allow")
        .arg("-M")
        .arg(module_name)
        .current_dir(tmp_dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|err| format!("failed to run audit2allow: {err}"))?;

    let mut stdin = child.stdin.take().ok_or("failed to open audit2allow stdin")?;
    let input = raw_lines.join("\n");
    stdin
        .write_all(input.as_bytes())
        .await
        .map_err(|err| format!("failed to write to audit2allow stdin: {err}"))?;
    drop(stdin); // EOF, so audit2allow stops reading and proceeds

    let output = child
        .wait_with_output()
        .await
        .map_err(|err| format!("failed to wait for audit2allow: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "audit2allow exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let te = tokio::fs::read_to_string(tmp_dir.join(format!("{module_name}.te")))
        .await
        .map_err(|err| format!("failed to read generated .te: {err}"))?;
    let pp_bytes = tokio::fs::read(tmp_dir.join(format!("{module_name}.pp")))
        .await
        .map_err(|err| format!("failed to read generated .pp: {err}"))?;

    Ok(SuggestModuleResult {
        te,
        pp_base64: base64::engine::general_purpose::STANDARD.encode(pp_bytes),
    })
}

async fn run_and_report(program: &str, args: &[&str]) -> (bool, String) {
    match Command::new(program).args(args).output().await {
        Ok(output) if output.status.success() => (true, String::new()),
        Ok(output) => (
            false,
            format!(
                "{program} exited with {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ),
        Err(err) => (false, format!("failed to run {program}: {err}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn module_names_must_not_look_like_options_or_carry_odd_characters() {
        assert!(is_safe_module_name("suggested_namedt_bint_file"));
        assert!(is_safe_module_name("my-mod.v2"));
        assert!(!is_safe_module_name(""));
        assert!(!is_safe_module_name("-r"));
        assert!(!is_safe_module_name("--help"));
        assert!(!is_safe_module_name("a b"));
        assert!(!is_safe_module_name("a;rm"));
        assert!(!is_safe_module_name("../x"));
        assert!(!is_safe_module_name(&"a".repeat(65)));
    }

    #[tokio::test]
    async fn restorecon_refuses_relative_and_option_like_paths() {
        for path in ["relative/path", "-R", ""] {
            let payload = format!(r#"{{"path":{path:?},"recursive":false}}"#);
            let (ok, message) = restorecon(&payload).await;
            assert!(!ok, "{path:?} must be refused");
            assert!(message.contains("non-absolute"), "{message}");
        }
    }

    #[tokio::test]
    async fn remove_module_refuses_unsafe_names_before_running_anything() {
        let (ok, message) = remove_module(r#"{"name":"-r"}"#).await;
        assert!(!ok);
        assert!(message.contains("unsafe"), "{message}");
    }
}
