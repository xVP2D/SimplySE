mod netlink;
mod parser;
mod tail;

pub use parser::AvcDenial;

use std::path::PathBuf;
use tokio::sync::mpsc::Sender;

/// Where to collect AVC denials from. See `AUDIT_SOURCE` in
/// [`crate::config::Config`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditSource {
    /// Tail `/var/log/audit/audit.log` (works everywhere, needs auditd).
    File,
    /// Read the kernel's audit netlink multicast group directly (real-time,
    /// no auditd dependency, needs `CAP_AUDIT_READ`).
    Netlink,
    /// Try netlink first; fall back to tailing the log file if the socket
    /// can't be opened (missing capability, sandboxed environment, ...).
    Auto,
}

impl AuditSource {
    pub fn parse(s: &str) -> Self {
        match s {
            "netlink" => Self::Netlink,
            "auto" => Self::Auto,
            _ => Self::File,
        }
    }
}

/// Collects AVC denials per `source` and forwards every parsed one to
/// `tx`. Lines/records that aren't AVC denials are silently dropped.
pub async fn run(source: AuditSource, audit_log_path: PathBuf, tx: Sender<AvcDenial>) {
    let (line_tx, mut line_rx) = tokio::sync::mpsc::channel::<String>(256);

    let collector_handle = tokio::spawn(async move {
        match source {
            AuditSource::File => tail::tail_file(&audit_log_path, line_tx).await,
            AuditSource::Netlink => netlink::run(line_tx).await,
            AuditSource::Auto => match netlink::try_open() {
                Ok(fd) => {
                    tracing::info!(
                        "audit netlink available (CAP_AUDIT_READ) — using it instead of tailing the log file"
                    );
                    netlink::serve(fd, line_tx).await;
                }
                Err(err) => {
                    tracing::info!(error = %err, "audit netlink unavailable, falling back to tailing audit.log");
                    tail::tail_file(&audit_log_path, line_tx).await;
                }
            },
        }
    });

    while let Some(line) = line_rx.recv().await {
        if let Some(denial) = parser::parse_avc_line(&line)
            && tx.send(denial).await.is_err()
        {
            break; // downstream shut down
        }
    }

    collector_handle.abort();
}
