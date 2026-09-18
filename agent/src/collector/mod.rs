mod correlate;
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
/// `tx`, with the denied file's full path attached when the audit event has
/// it. Records that aren't part of an AVC event are silently dropped.
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

    // Denials wait here briefly for the rest of their audit event, so the
    // full path of the denied file can be attached (see correlate.rs).
    let mut correlator = correlate::Correlator::default();
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(500));
    'outer: loop {
        let ready = tokio::select! {
            line = line_rx.recv() => match line {
                Some(line) => correlator.feed(&line, std::time::Instant::now()),
                None => break,
            },
            _ = tick.tick() => correlator.flush_stale(std::time::Instant::now(), std::time::Duration::from_secs(2)),
        };
        for denial in ready {
            if tx.send(denial).await.is_err() {
                break 'outer; // downstream shut down
            }
        }
    }
    for denial in correlator.flush_stale(std::time::Instant::now(), std::time::Duration::ZERO) {
        let _ = tx.send(denial).await;
    }

    collector_handle.abort();
}
