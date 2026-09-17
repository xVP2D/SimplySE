use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::collector::AvcDenial;

/// A simple disk-backed queue for AVC events collected while the master is
/// unreachable. Not transactional across process crashes mid-write, but
/// good enough to survive short network blips without losing denials.
pub struct DiskBuffer {
    path: PathBuf,
}

impl DiskBuffer {
    pub fn new(path: PathBuf) -> std::io::Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        Ok(Self { path })
    }

    pub fn push(&self, event: &AvcDenial) {
        let Ok(line) = serde_json::to_string(event) else {
            tracing::warn!("failed to serialize AVC event for buffering, dropping it");
            return;
        };
        if let Err(err) = append_line(&self.path, &line) {
            tracing::error!(error = %err, "failed to write to disk buffer, dropping event");
        }
    }

    /// Attempts to deliver every buffered event via `try_send`. Events that
    /// fail to send (e.g. the connection drops mid-flush) are written back
    /// to the buffer so nothing is lost.
    pub fn drain(&self, mut try_send: impl FnMut(AvcDenial) -> bool) {
        let content = fs::read_to_string(&self.path).unwrap_or_default();
        if content.is_empty() {
            return;
        }

        let mut remaining = Vec::new();
        let mut delivering = true;
        for line in content.lines() {
            if !delivering {
                remaining.push(line);
                continue;
            }
            // unparsable lines are dropped rather than blocking the buffer forever
            if let Ok(event) = serde_json::from_str::<AvcDenial>(line)
                && !try_send(event)
            {
                delivering = false;
                remaining.push(line);
            }
        }

        if let Err(err) = fs::write(&self.path, remaining.join("\n")) {
            tracing::error!(error = %err, "failed to rewrite disk buffer after drain");
        }
    }
}

fn append_line(path: &Path, line: &str) -> std::io::Result<()> {
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(file, "{line}")
}
