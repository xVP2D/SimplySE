use base64::Engine;
use serde::Deserialize;
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
