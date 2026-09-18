mod action;
mod buffer;
mod collector;
mod config;
mod grpc;
mod permissive;
mod selinux_access;
mod selinux_info;

pub mod pb {
    tonic::include_proto!("selinux.v1");
}

use buffer::DiskBuffer;
use config::Config;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("info".parse().unwrap()),
        )
        .init();

    let config = Config::from_env();
    tracing::info!(agent_id = %config.agent_id, master = %config.master_addr, "starting selinux-agent");

    let buffer = match DiskBuffer::new(config.buffer_path.clone()) {
        Ok(b) => b,
        Err(err) => {
            tracing::error!(error = %err, "failed to initialize disk buffer");
            std::process::exit(1);
        }
    };

    // Close (or re-arm) any permissive collection window left over from
    // before this process started — the way back never depends on the
    // master, nor on the agent having stayed up.
    permissive::recover().await;

    let (avc_tx, avc_rx) = tokio::sync::mpsc::channel(256);
    let audit_log_path = config.audit_log_path.clone();
    let audit_source = collector::AuditSource::parse(&config.audit_source);

    tokio::spawn(async move {
        collector::run(audit_source, audit_log_path, avc_tx).await;
    });

    grpc::run(config, avc_rx, buffer).await;
}
