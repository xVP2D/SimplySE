use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, anyhow};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::transport::{Certificate, Channel, ClientTlsConfig, Identity};

use crate::action;
use crate::buffer::DiskBuffer;
use crate::collector::AvcDenial;
use crate::config::Config;
use crate::pb;
use crate::selinux_info;

const RECONNECT_DELAY: Duration = Duration::from_secs(3);

pub async fn run(config: Config, mut avc_rx: mpsc::Receiver<AvcDenial>, buffer: DiskBuffer) {
    loop {
        match connect_and_serve(&config, &mut avc_rx, &buffer).await {
            Ok(()) => tracing::info!("stream to master ended, reconnecting"),
            Err(err) => tracing::warn!(error = %err, "lost connection to master, reconnecting"),
        }
        tokio::time::sleep(RECONNECT_DELAY).await;
    }
}

async fn connect_and_serve(
    config: &Config,
    avc_rx: &mut mpsc::Receiver<AvcDenial>,
    buffer: &DiskBuffer,
) -> anyhow::Result<()> {
    let channel = build_channel(config).await?;
    let mut client = pb::agent_link_client::AgentLinkClient::new(channel);

    let (out_tx, out_rx) = mpsc::channel::<pb::AgentMessage>(64);
    out_tx
        .send(enroll_message(config))
        .await
        .map_err(|_| anyhow!("outbound channel closed before enroll"))?;

    let response = client.session(ReceiverStream::new(out_rx)).await?;
    let mut inbound = response.into_inner();
    tracing::info!(master = %config.master_addr, agent_id = %config.agent_id, "connected to master");

    buffer.drain(|event| {
        out_tx
            .try_send(avc_event_message(&config.agent_id, &event))
            .is_ok()
    });

    let mut heartbeat_interval =
        tokio::time::interval(Duration::from_secs(config.heartbeat_interval_secs));
    heartbeat_interval.tick().await; // first tick fires immediately; consume it

    // Unlike heartbeat_interval, this one's first (immediate) tick is
    // *not* consumed: booleans/modules are worth sending right away on
    // (re)connect rather than waiting a full interval, since the previous
    // snapshot on the master could otherwise be stale for that long.
    let mut inventory_interval =
        tokio::time::interval(Duration::from_secs(config.selinux_inventory_interval_secs));

    loop {
        tokio::select! {
            _ = heartbeat_interval.tick() => {
                if out_tx.send(heartbeat_message(config)).await.is_err() {
                    return Err(anyhow!("outbound channel closed"));
                }
            }
            _ = inventory_interval.tick() => {
                let msg = selinux_inventory_message(&config.agent_id).await;
                if out_tx.send(msg).await.is_err() {
                    return Err(anyhow!("outbound channel closed"));
                }
            }
            event = avc_rx.recv() => {
                match event {
                    Some(event) => {
                        if out_tx.send(avc_event_message(&config.agent_id, &event)).await.is_err() {
                            buffer.push(&event);
                            return Err(anyhow!("outbound channel closed while sending avc event"));
                        }
                    }
                    None => return Ok(()), // collector shut down: nothing left to do
                }
            }
            msg = inbound.message() => {
                match msg? {
                    Some(server_msg) => handle_server_message(server_msg, &out_tx).await,
                    None => return Err(anyhow!("server closed the stream")),
                }
            }
        }
    }
}

async fn build_channel(config: &Config) -> anyhow::Result<Channel> {
    let ca = tokio::fs::read(&config.tls_ca)
        .await
        .context("read TLS CA file")?;
    let cert = tokio::fs::read(&config.tls_cert)
        .await
        .context("read TLS client cert")?;
    let key = tokio::fs::read(&config.tls_key)
        .await
        .context("read TLS client key")?;

    let tls = ClientTlsConfig::new()
        .domain_name(config.tls_domain.clone())
        .ca_certificate(Certificate::from_pem(ca))
        .identity(Identity::from_pem(cert, key));

    Channel::from_shared(config.master_addr.clone())
        .context("invalid master address")?
        .tls_config(tls)
        .context("invalid TLS config")?
        .http2_keep_alive_interval(Duration::from_secs(15))
        .keep_alive_timeout(Duration::from_secs(5))
        .keep_alive_while_idle(true)
        .connect()
        .await
        .context("connect to master")
}

async fn handle_server_message(msg: pb::ServerMessage, out_tx: &mpsc::Sender<pb::AgentMessage>) {
    let Some(payload) = msg.payload else { return };
    match payload {
        pb::server_message::Payload::Command(command) => {
            let command_id = command.command_id.clone();
            let (success, message) = action::execute(&command).await;
            tracing::info!(command_id = %command_id, success, message = %message, "executed command");
            let _ = out_tx
                .send(pb::AgentMessage {
                    payload: Some(pb::agent_message::Payload::Ack(pb::CommandAck {
                        command_id,
                        success,
                        message,
                    })),
                })
                .await;
        }
        pb::server_message::Payload::HeartbeatAck(_) => {}
    }
}

fn enroll_message(config: &Config) -> pb::AgentMessage {
    pb::AgentMessage {
        payload: Some(pb::agent_message::Payload::Enroll(pb::EnrollInfo {
            agent_id: config.agent_id.clone(),
            hostname: crate::config::hostname(),
            os_release: crate::config::os_release(),
            kernel_version: crate::config::kernel_version(),
            agent_version: env!("CARGO_PKG_VERSION").to_string(),
        })),
    }
}

fn heartbeat_message(config: &Config) -> pb::AgentMessage {
    let ts_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    pb::AgentMessage {
        payload: Some(pb::agent_message::Payload::Heartbeat(pb::Heartbeat {
            agent_id: config.agent_id.clone(),
            ts_unix,
            mode: current_selinux_mode(),
            policy_name: "targeted".to_string(),
            policy_version: String::new(),
        })),
    }
}

fn avc_event_message(agent_id: &str, event: &AvcDenial) -> pb::AgentMessage {
    pb::AgentMessage {
        payload: Some(pb::agent_message::Payload::AvcEvent(pb::AvcEvent {
            agent_id: agent_id.to_string(),
            ts_unix: event.ts_unix,
            scontext: event.scontext.clone(),
            tcontext: event.tcontext.clone(),
            tclass: event.tclass.clone(),
            perms: event.perms.clone(),
            comm: event.comm.clone(),
            path: event.path.clone(),
            pid: event.pid.clone(),
            raw_line: event.raw_line.clone(),
        })),
    }
}

async fn selinux_inventory_message(agent_id: &str) -> pb::AgentMessage {
    let ts_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (booleans, modules) = selinux_info::collect().await;
    pb::AgentMessage {
        payload: Some(pb::agent_message::Payload::SelinuxInventory(
            pb::SelinuxInventory {
                agent_id: agent_id.to_string(),
                ts_unix,
                booleans,
                modules,
            },
        )),
    }
}

fn current_selinux_mode() -> String {
    match std::fs::read_to_string("/sys/fs/selinux/enforce") {
        Ok(v) if v.trim() == "1" => "enforcing".to_string(),
        Ok(v) if v.trim() == "0" => "permissive".to_string(),
        _ => "disabled".to_string(),
    }
}
