use std::io::SeekFrom;
use std::path::Path;
use std::time::Duration;

use tokio::fs::File;
use tokio::io::{AsyncBufReadExt, AsyncSeekExt, BufReader};
use tokio::sync::mpsc::Sender;

/// Tails `path`, sending each new line to `tx` as it appears. Starts at the
/// end of the file (only new events are collected) and re-opens the file if
/// it shrinks (log rotation via truncate) or disappears (rotation via
/// rename, e.g. logrotate `copytruncate` or auditd rotation).
///
/// Runs until `tx` is closed. Errors opening/reading are logged and
/// retried after a short delay rather than propagated, since a missing or
/// momentarily-unreadable audit log should not crash the agent.
pub async fn tail_file(path: &Path, tx: Sender<String>) {
    let mut position: u64 = 0;

    loop {
        match open_at_end(path, &mut position).await {
            Ok(mut reader) => {
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line).await {
                        Ok(0) => {
                            // EOF: check for truncation/rotation, then wait for more data.
                            if file_shrank(path, position).await {
                                tracing::info!(path = %path.display(), "audit log rotated, reopening");
                                break;
                            }
                            tokio::time::sleep(Duration::from_millis(500)).await;
                        }
                        Ok(n) => {
                            position += n as u64;
                            let trimmed = line.trim_end_matches('\n');
                            if !trimmed.is_empty() && tx.send(trimmed.to_string()).await.is_err() {
                                return; // receiver dropped, agent is shutting down
                            }
                        }
                        Err(err) => {
                            tracing::warn!(error = %err, "error reading audit log, will retry");
                            break;
                        }
                    }
                }
            }
            Err(err) => {
                tracing::warn!(path = %path.display(), error = %err, "cannot open audit log, retrying");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
}

async fn open_at_end(path: &Path, position: &mut u64) -> std::io::Result<BufReader<File>> {
    let mut file = File::open(path).await?;
    if *position == 0 {
        *position = file.seek(SeekFrom::End(0)).await?;
    } else {
        let len = file.metadata().await?.len();
        if len < *position {
            *position = 0; // truncated: read from the start
        }
        file.seek(SeekFrom::Start(*position)).await?;
    }
    Ok(BufReader::new(file))
}

async fn file_shrank(path: &Path, position: u64) -> bool {
    match tokio::fs::metadata(path).await {
        Ok(meta) => meta.len() < position,
        Err(_) => true, // file gone (renamed away by rotation): treat as rotated
    }
}
