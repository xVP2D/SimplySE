use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    pub master_addr: String,
    pub agent_id: String,
    pub audit_log_path: PathBuf,
    /// "file" (default), "netlink", or "auto" — see collector::AuditSource.
    /// Kept as a raw string here rather than the enum so config stays
    /// independent of the collector module; parsed at the call site.
    pub audit_source: String,
    pub buffer_path: PathBuf,
    pub tls_ca: PathBuf,
    pub tls_cert: PathBuf,
    pub tls_key: PathBuf,
    pub tls_domain: String,
    pub heartbeat_interval_secs: u64,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            master_addr: env_or("MASTER_ADDR", "https://localhost:8443"),
            agent_id: env_or("AGENT_ID", &hostname()),
            audit_log_path: PathBuf::from(env_or("AUDIT_LOG_PATH", "/var/log/audit/audit.log")),
            audit_source: env_or("AUDIT_SOURCE", "file"),
            buffer_path: PathBuf::from(env_or(
                "BUFFER_PATH",
                "/var/lib/console-selinux-agent/buffer.jsonl",
            )),
            tls_ca: PathBuf::from(env_or("TLS_CA_FILE", "deploy/certs/ca.crt")),
            tls_cert: PathBuf::from(env_or("TLS_CERT_FILE", "deploy/certs/agent-dev.crt")),
            tls_key: PathBuf::from(env_or("TLS_KEY_FILE", "deploy/certs/agent-dev.key")),
            tls_domain: env_or("TLS_DOMAIN", "master"),
            heartbeat_interval_secs: env_or("HEARTBEAT_INTERVAL_SECS", "10")
                .parse()
                .unwrap_or(10),
        }
    }
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

pub fn hostname() -> String {
    std::fs::read_to_string("/etc/hostname")
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "unknown-host".to_string())
}

pub fn os_release() -> String {
    let Ok(contents) = std::fs::read_to_string("/etc/os-release") else {
        return "unknown".to_string();
    };
    for line in contents.lines() {
        if let Some(value) = line.strip_prefix("PRETTY_NAME=") {
            return value.trim_matches('"').to_string();
        }
    }
    "unknown".to_string()
}

pub fn kernel_version() -> String {
    std::fs::read_to_string("/proc/sys/kernel/osrelease")
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string())
}
