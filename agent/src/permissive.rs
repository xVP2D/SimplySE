//! Temporary "collect every denial of this domain" mode.
//!
//! Fixing a denial reveals the next one (search, then addname, then create,
//! then open...), because SELinux only reports the first refusal of each
//! operation. Making the domain permissive for a while logs all of them at
//! once, without blocking anything, so a single module can cover the lot.
//!
//! That is a real, if temporary, loosening of one domain, so the way back
//! must never depend on anyone remembering — or on the master being alive:
//!  * the deadline is written to a state file and enforced by a timer *in
//!    this process*, and re-armed (or executed, if already past) when the
//!    agent starts again;
//!  * a domain that was already permissive before is never touched, start
//!    and stop alike, and one that isn't ours (no state entry) is left alone
//!    on stop;
//!  * duration is bounded, and domain names are validated before they reach
//!    `semanage`'s argument list.

use std::collections::{BTreeMap, HashSet};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tokio::sync::Mutex;

const DEFAULT_STATE_FILE: &str = "/var/lib/selinux-fleet-manager/permissive.json";
pub const MIN_SECS: u64 = 30;
pub const MAX_SECS: u64 = 3600;

/// Domains too central to loosen for a "collect" run: every process would
/// lose its confinement, so the resulting denials would say nothing useful.
const REFUSED_DOMAINS: &[&str] = &["kernel_t", "init_t"];

/// Whether `domain` is one this tool refuses to make permissive, regardless
/// of who asks — shared with the active-domain scan (selinux_info) so the
/// two never drift apart.
pub fn is_refused(domain: &str) -> bool {
    REFUSED_DOMAINS.contains(&domain)
}

/// Serializes read-modify-write of the state file and the semanage calls.
static LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
struct State {
    domains: BTreeMap<String, Entry>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Entry {
    until_unix: i64,
    /// Already permissive before we were asked: never removed by us.
    preexisting: bool,
}

fn state_path() -> String {
    std::env::var("PERMISSIVE_STATE_PATH").unwrap_or_else(|_| DEFAULT_STATE_FILE.to_string())
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// A domain type name, as passed to `semanage permissive`: lowercase
/// identifier ending in `_t`, no option-like or path-like characters.
pub fn valid_domain(domain: &str) -> bool {
    domain.len() >= 3
        && domain.len() <= 64
        && domain.ends_with("_t")
        && domain.starts_with(|c: char| c.is_ascii_lowercase())
        && domain
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// Type names listed by `semanage permissive -l` (both the "Builtin" and
/// "Customized" sections — either way the domain is already permissive).
fn parse_permissive_list(output: &str) -> HashSet<String> {
    output
        .lines()
        .map(str::trim)
        .filter(|l| valid_domain(l))
        .map(str::to_string)
        .collect()
}

fn read_state() -> State {
    std::fs::read_to_string(state_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_state(state: &State) -> Result<(), String> {
    let path = state_path();
    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    // Write next to it then rename, so a crash never leaves a half-written
    // file that would make us forget a domain we must put back.
    let tmp = format!("{path}.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("write {tmp}: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename {tmp}: {e}"))
}

async fn semanage(args: &[&str]) -> Result<String, String> {
    match Command::new("semanage").args(args).output().await {
        Ok(o) if o.status.success() => Ok(String::from_utf8_lossy(&o.stdout).to_string()),
        Ok(o) => Err(format!(
            "semanage {} exited with {}: {}",
            args.join(" "),
            o.status,
            String::from_utf8_lossy(&o.stderr).trim()
        )),
        Err(err) => Err(format!("failed to run semanage: {err}")),
    }
}

async fn currently_permissive() -> Result<HashSet<String>, String> {
    Ok(parse_permissive_list(&semanage(&["permissive", "-l"]).await?))
}

#[derive(Deserialize)]
struct StartPayload {
    domain: String,
    duration_secs: u64,
}

#[derive(Deserialize)]
struct StopPayload {
    domain: String,
}

pub async fn start(payload_json: &str) -> (bool, String) {
    let payload: StartPayload = match serde_json::from_str(payload_json) {
        Ok(p) => p,
        Err(err) => return (false, format!("invalid payload: {err}")),
    };
    if !valid_domain(&payload.domain) {
        return (false, format!("invalid domain {:?}", payload.domain));
    }
    if REFUSED_DOMAINS.contains(&payload.domain.as_str()) {
        return (false, format!("refusing to make {} permissive", payload.domain));
    }
    if !(MIN_SECS..=MAX_SECS).contains(&payload.duration_secs) {
        return (
            false,
            format!("duration must be between {MIN_SECS} and {MAX_SECS} seconds"),
        );
    }

    let _guard = LOCK.lock().await;
    let mut state = read_state();
    let until = now_unix() + payload.duration_secs as i64;

    // Ours already (a second request extends the window): don't add again.
    if let Some(entry) = state.domains.get_mut(&payload.domain) {
        if !entry.preexisting {
            entry.until_unix = until;
            if let Err(err) = write_state(&state) {
                return (false, err);
            }
            arm_timer(payload.domain.clone(), payload.duration_secs);
            return (true, format!("{} already collecting; window extended", payload.domain));
        }
    }

    let already = match currently_permissive().await {
        Ok(set) => set.contains(&payload.domain),
        Err(err) => return (false, err),
    };
    if already {
        state
            .domains
            .insert(payload.domain.clone(), Entry { until_unix: until, preexisting: true });
        let _ = write_state(&state);
        return (
            true,
            format!("{} was already permissive; left exactly as it is", payload.domain),
        );
    }

    if let Err(err) = semanage(&["permissive", "-a", &payload.domain]).await {
        return (false, err);
    }
    state
        .domains
        .insert(payload.domain.clone(), Entry { until_unix: until, preexisting: false });
    if let Err(err) = write_state(&state) {
        // Without the record nothing would ever put it back: undo now.
        let _ = semanage(&["permissive", "-d", &payload.domain]).await;
        return (false, format!("{err}; permissive mode was rolled back"));
    }
    arm_timer(payload.domain.clone(), payload.duration_secs);
    (true, format!("{} is permissive for {}s", payload.domain, payload.duration_secs))
}

pub async fn stop(payload_json: &str) -> (bool, String) {
    let payload: StopPayload = match serde_json::from_str(payload_json) {
        Ok(p) => p,
        Err(err) => return (false, format!("invalid payload: {err}")),
    };
    if !valid_domain(&payload.domain) {
        return (false, format!("invalid domain {:?}", payload.domain));
    }
    let _guard = LOCK.lock().await;
    stop_locked(&payload.domain).await
}

async fn stop_locked(domain: &str) -> (bool, String) {
    let mut state = read_state();
    match state.domains.get(domain).cloned() {
        Some(entry) if entry.preexisting => {
            state.domains.remove(domain);
            let _ = write_state(&state);
            (true, format!("{domain} was permissive before: left as it was"))
        }
        Some(_) => match semanage(&["permissive", "-d", domain]).await {
            Ok(_) => finish_removal(&mut state, domain, "back to enforced"),
            // Already gone (removed by hand?) is the outcome we wanted.
            Err(err) => match currently_permissive().await {
                Ok(set) if !set.contains(domain) => finish_removal(&mut state, domain, "already not permissive"),
                _ => (false, err),
            },
        },
        // Not ours: never remove a permissive domain someone else set.
        None => (true, format!("{domain} was not made permissive by this tool: left as is")),
    }
}

fn finish_removal(state: &mut State, domain: &str, what: &str) -> (bool, String) {
    state.domains.remove(domain);
    match write_state(state) {
        Ok(()) => (true, format!("{domain}: {what}")),
        Err(err) => (true, format!("{domain}: {what} (state file not updated: {err})")),
    }
}

/// The agent's own deadline: puts the domain back even if the master never
/// says so.
fn arm_timer(domain: String, secs: u64) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(secs)).await;
        expire(domain).await;
    });
}

type BoxFuture<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

/// Removes `domain` if its recorded deadline has passed (a later extension
/// moves the deadline, so an earlier timer firing then does nothing).
///
/// Returns an explicitly type-erased future (`dyn Future`, not a plain
/// `async fn`): this function calls itself (on retry), and a recursive
/// `async fn` has no finite size on its own — only boxing behind `dyn`
/// breaks the recursion for the compiler.
fn expire(domain: String) -> BoxFuture<'static, ()> {
    Box::pin(async move {
        let _guard = LOCK.lock().await;
        let state = read_state();
        let Some(entry) = state.domains.get(&domain) else {
            return;
        };
        if entry.until_unix > now_unix() + 1 {
            return;
        }
        let (ok, message) = stop_locked(&domain).await;
        if ok {
            tracing::info!(domain = %domain, message = %message, "permissive collection window ended");
        } else {
            tracing::error!(domain = %domain, message = %message, "could not end the permissive collection window; will retry");
            // Try again shortly rather than leave a domain permissive.
            let retry = domain.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(30)).await;
                expire(retry).await;
            });
        }
    })
}

/// On agent start: finish what was pending when the previous process ended —
/// expired windows are closed right away, live ones get their timer back.
pub async fn recover() {
    let state = read_state();
    let now = now_unix();
    for (domain, entry) in state.domains {
        if entry.until_unix <= now {
            expire(domain).await;
        } else if !entry.preexisting {
            arm_timer(domain, (entry.until_unix - now) as u64);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_names_must_look_like_types_and_nothing_else() {
        for ok in ["syslogd_t", "httpd_sys_script_t", "a_t", "sshd_t", "container_t2_t"] {
            assert!(valid_domain(ok), "{ok}");
        }
        for bad in [
            "", "_t", "t", "Syslogd_t", "syslogd", "-a_t", "a b_t", "a;b_t", "../x_t", "a/b_t",
            "syslogd_t\n", "-d_t", "1abc_t",
        ] {
            assert!(!valid_domain(bad), "{bad:?}");
        }
        assert!(!valid_domain(&format!("{}_t", "a".repeat(64))));
    }

    #[test]
    fn parses_both_sections_of_semanage_permissive_list() {
        let out = "\nBuiltin Permissive Types \n\nsystemd_hibernate_resume_t\nvirtqemud_t\n\nCustomized Permissive Types\n\nsyslogd_t\n";
        let set = parse_permissive_list(out);
        assert!(set.contains("systemd_hibernate_resume_t"));
        assert!(set.contains("virtqemud_t"));
        assert!(set.contains("syslogd_t"));
        assert_eq!(set.len(), 3, "headers must not be read as types: {set:?}");
    }

    #[test]
    fn state_survives_a_round_trip_through_json() {
        let mut s = State::default();
        s.domains.insert("syslogd_t".into(), Entry { until_unix: 1234, preexisting: false });
        s.domains.insert("virtqemud_t".into(), Entry { until_unix: 99, preexisting: true });
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(serde_json::from_str::<State>(&json).unwrap(), s);
    }

    #[tokio::test]
    async fn refuses_central_domains_and_out_of_range_durations_before_touching_anything() {
        let (ok, msg) = start(r#"{"domain":"init_t","duration_secs":60}"#).await;
        assert!(!ok && msg.contains("refusing"), "{msg}");
        let (ok, msg) = start(r#"{"domain":"syslogd_t","duration_secs":5}"#).await;
        assert!(!ok && msg.contains("duration"), "{msg}");
        let (ok, msg) = start(r#"{"domain":"syslogd_t","duration_secs":999999}"#).await;
        assert!(!ok && msg.contains("duration"), "{msg}");
        let (ok, msg) = start(r#"{"domain":"-a_t","duration_secs":60}"#).await;
        assert!(!ok && msg.contains("invalid domain"), "{msg}");
        let (ok, _) = stop(r#"{"domain":"../etc_t"}"#).await;
        assert!(!ok);
    }
}
