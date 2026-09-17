//! Reads AVC denials straight from the kernel's audit netlink multicast
//! group (`AUDIT_NLGRP_READLOG`), the same channel auditd itself listens
//! on to produce `/var/log/audit/audit.log`. Advantages over tailing the
//! log file: works even without auditd running, and is real-time (no
//! waiting on log I/O). Requires `CAP_AUDIT_READ` (Linux 3.16+); when the
//! agent doesn't have it, [`try_open`] fails and the caller falls back to
//! [`super::tail`].
//!
//! Binding to the multicast group is a passive, read-only subscription —
//! unlike registering as *the* auditd (unicast, `nlmsg_pid` claimed), it
//! does not conflict with an auditd already running on the host.

use std::io;
use std::mem;
use std::os::fd::RawFd;

use tokio::sync::mpsc::Sender;

const NETLINK_AUDIT: i32 = 9; // linux/netlink.h
const AUDIT_NLGRP_READLOG_MASK: u32 = 1; // linux/audit.h: group 1 -> bit 0
const AUDIT_AVC: u16 = 1400; // linux/audit.h

/// Opens and binds the audit netlink socket. Returns an error (typically
/// EPERM without `CAP_AUDIT_READ`, or ENOSYS/EAFNOSUPPORT under a sandbox
/// that blocks `AF_NETLINK`) rather than panicking, so callers can fall
/// back to tailing the log file.
pub fn try_open() -> io::Result<RawFd> {
    // SAFETY: standard socket(2)/bind(2) sequence for a netlink multicast
    // subscription; sockaddr_nl is fully zero-initialized before use, and
    // the fd is closed on any failure path so we never leak it.
    unsafe {
        let fd = libc::socket(libc::AF_NETLINK, libc::SOCK_RAW, NETLINK_AUDIT);
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }

        let mut addr: libc::sockaddr_nl = mem::zeroed();
        addr.nl_family = libc::AF_NETLINK as u16;
        addr.nl_groups = AUDIT_NLGRP_READLOG_MASK;

        let ret = libc::bind(
            fd,
            &addr as *const libc::sockaddr_nl as *const libc::sockaddr,
            mem::size_of::<libc::sockaddr_nl>() as u32,
        );
        if ret < 0 {
            let err = io::Error::last_os_error();
            libc::close(fd);
            return Err(err);
        }
        Ok(fd)
    }
}

/// Opens the socket and serves it, or logs and returns if unavailable.
/// Used for `AUDIT_SOURCE=netlink` (no fallback); `auto` mode instead
/// calls [`try_open`] itself so it can fall back to tailing on failure.
pub async fn run(tx: Sender<String>) {
    match try_open() {
        Ok(fd) => serve(fd, tx).await,
        Err(err) => {
            tracing::warn!(error = %err, "cannot open audit netlink socket (needs CAP_AUDIT_READ)")
        }
    }
}

/// Serves an already-opened socket until the receiver drops or a read
/// error occurs. The actual `recv` loop is blocking libc I/O, so it runs
/// on a blocking-pool thread rather than the async runtime.
pub async fn serve(fd: RawFd, tx: Sender<String>) {
    if tokio::task::spawn_blocking(move || recv_loop(fd, tx))
        .await
        .is_err()
    {
        tracing::error!("audit netlink receive loop panicked");
    }
}

fn recv_loop(fd: RawFd, tx: Sender<String>) {
    let mut buf = [0u8; 8192];
    loop {
        // SAFETY: buf is a valid, appropriately-sized buffer for the
        // duration of the call; recv(2) never writes more than buf.len().
        let n = unsafe { libc::recv(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len(), 0) };
        if n <= 0 {
            tracing::warn!(error = %io::Error::last_os_error(), "audit netlink recv failed, stopping netlink collector");
            break;
        }

        for (nlmsg_type, payload) in parse_netlink_messages(&buf[..n as usize]) {
            if let Some(line) = format_line(nlmsg_type, payload)
                && tx.blocking_send(line).is_err()
            {
                // downstream shut down
                unsafe { libc::close(fd) };
                return;
            }
        }
    }
    unsafe { libc::close(fd) };
}

/// Splits one recv(2) buffer into (nlmsg_type, payload text) pairs.
/// Netlink packs multiple messages per datagram, each padded to a 4-byte
/// boundary (`NLMSG_ALIGN`); a 16-byte `nlmsghdr` precedes each payload.
fn parse_netlink_messages(buf: &[u8]) -> Vec<(u16, &str)> {
    const HDR_LEN: usize = 16;
    let mut out = Vec::new();
    let mut offset = 0usize;

    while offset + HDR_LEN <= buf.len() {
        let nlmsg_len = u32::from_ne_bytes(buf[offset..offset + 4].try_into().unwrap()) as usize;
        let nlmsg_type = u16::from_ne_bytes(buf[offset + 4..offset + 6].try_into().unwrap());
        if nlmsg_len < HDR_LEN || offset + nlmsg_len > buf.len() {
            break; // truncated or malformed: stop rather than misread the rest
        }

        let payload = &buf[offset + HDR_LEN..offset + nlmsg_len];
        let text = std::str::from_utf8(payload)
            .unwrap_or_default()
            .trim_end_matches('\0')
            .trim();
        if !text.is_empty() {
            out.push((nlmsg_type, text));
        }

        offset += (nlmsg_len + 3) & !3; // NLMSG_ALIGN to 4 bytes
    }
    out
}

/// Reconstructs the same `type=AVC msg=audit(...): avc: ...` text that
/// auditd would write to the log, from the raw netlink record — the
/// kernel's payload for AVC records already starts with `audit(ts:serial):
/// avc: ...`; only the `type=AVC msg=` prefix is auditd's own addition, so
/// prepending it lets the existing text parser (see
/// [`super::parser::parse_avc_line`]) handle both sources identically.
fn format_line(nlmsg_type: u16, payload: &str) -> Option<String> {
    if nlmsg_type != AUDIT_AVC {
        return None;
    }
    Some(format!("type=AVC msg={payload}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_an_avc_record_into_a_line_the_text_parser_accepts() {
        let payload = r#"audit(1699999999.123:456): avc:  denied  { read write } for  pid=1234 comm="httpd" path="/var/www/html/index.html" scontext=system_u:system_r:httpd_t:s0 tcontext=unconfined_u:object_r:user_home_t:s0 tclass=file permissive=0"#;
        let line = format_line(AUDIT_AVC, payload).expect("AVC records must format");
        let denial =
            super::super::parser::parse_avc_line(&line).expect("should parse like a log line");
        assert_eq!(denial.scontext, "system_u:system_r:httpd_t:s0");
    }

    #[test]
    fn ignores_non_avc_record_types() {
        assert!(format_line(1300, "audit(1699999999.123:456): arch=c000003e").is_none());
    }

    #[test]
    fn parses_two_messages_packed_in_one_buffer() {
        let mut buf = Vec::new();
        for payload in [b"first".as_slice(), b"second".as_slice()] {
            let nlmsg_len = (16 + payload.len()) as u32;
            buf.extend_from_slice(&nlmsg_len.to_ne_bytes());
            buf.extend_from_slice(&AUDIT_AVC.to_ne_bytes());
            buf.extend_from_slice(&0u16.to_ne_bytes()); // nlmsg_flags
            buf.extend_from_slice(&0u32.to_ne_bytes()); // nlmsg_seq
            buf.extend_from_slice(&0u32.to_ne_bytes()); // nlmsg_pid
            buf.extend_from_slice(payload);
            while buf.len() % 4 != 0 {
                buf.push(0);
            }
        }

        let messages = parse_netlink_messages(&buf);
        assert_eq!(messages, vec![(AUDIT_AVC, "first"), (AUDIT_AVC, "second")]);
    }
}
